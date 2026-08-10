import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  CommandLedger,
  decodeJsonLine,
  encodeJsonLine,
  validateProtocolMessage,
  type CommandEnvelope,
  type EventEnvelope,
  type ProtocolMessage,
  type RuntimeEvent,
  type TaskSnapshot,
} from "@candy/protocol";
import { SystemClock, SQLiteTaskStore, type TaskMetadata } from "@candy/platform";
import { DeterministicAgentEngine, type AgentEngine, type AgentObservation } from "@candy/runtime";

export interface AppServerState {
  readonly protocolVersion: 1;
  readonly runtimeVersion: "0.0.0";
  readonly executingTasks: readonly string[];
}

/** Legacy single-message projection retained for the protocol smoke fixture. */
export function handleAppServerMessage(
  message: ProtocolMessage,
  state: AppServerState,
): ProtocolMessage {
  void state;
  if (message.kind === "command") {
    const command = message as CommandEnvelope;
    return {
      v: 1,
      kind: "event",
      taskId: command.taskId,
      sequence: 1,
      revision: command.expectedRevision,
      event: {
        type: "snapshot",
        snapshot: { taskId: command.taskId, revision: command.expectedRevision, state: "idle" },
      },
    };
  }
  return message;
}

export interface AppServerControllerOptions {
  readonly databasePath?: string;
  readonly engine?: AgentEngine;
  readonly ownerId?: string;
}

type Emit = (message: ProtocolMessage) => void;

interface ActiveTask {
  readonly abort: AbortController;
  done: Promise<void>;
  requestedStop?: "paused" | "cancelled";
}

/**
 * Durable task command loop used by Desktop and the app-server smoke path.
 * Prompts remain in the Pi-owned session path in the real engine; this
 * deterministic controller keeps the fixture prompt in memory only.
 */
export class AppServerController {
  readonly #store: SQLiteTaskStore;
  readonly #engine: AgentEngine;
  readonly #ownerId: string;
  readonly #commands = new CommandLedger();
  readonly #prompts = new Map<string, string>();
  readonly #active = new Map<string, ActiveTask>();
  readonly #sequences = new Map<string, number>();

  public constructor(options: AppServerControllerOptions = {}) {
    this.#store = new SQLiteTaskStore(options.databasePath ?? ":memory:");
    this.#engine =
      options.engine ?? new DeterministicAgentEngine(new SystemClock(), "Candy fixture response");
    this.#ownerId = options.ownerId ?? `app-server:${process.pid}`;
  }

  public get state(): AppServerState {
    return {
      protocolVersion: 1,
      runtimeVersion: "0.0.0",
      executingTasks: [...this.#active.keys()],
    };
  }

  public async dispatch(
    message: ProtocolMessage,
    emit: Emit = () => undefined,
  ): Promise<readonly ProtocolMessage[]> {
    validateProtocolMessage(message);
    if (message.kind !== "command") return [message];
    const existing = this.#store.get(message.taskId);
    this.#commands.accept(message, existing?.revision ?? 0);
    const command = message.command;

    if (command.type === "task.create") {
      if (existing) throw new Error(`Task ${message.taskId} already exists.`);
      const metadata = this.#store.create(
        message.taskId,
        command.approvalProfile,
        this.nextQueueOrder(),
      );
      this.#prompts.set(message.taskId, command.prompt);
      return [
        this.event(message.taskId, metadata.revision, {
          type: "task.created",
          approvalProfile: command.approvalProfile,
        }),
        this.snapshot(metadata),
      ];
    }

    if (command.type === "snapshot") {
      return [
        this.snapshot(
          existing ?? {
            taskId: message.taskId,
            revision: message.expectedRevision,
            state: "queued",
            approvalProfile: "read-only",
          },
        ),
      ];
    }

    if (!existing) throw new Error(`Task ${message.taskId} does not exist.`);
    if (command.type === "task.run" || command.type === "task.resume") {
      if (existing.state === "running") return [this.snapshot(existing)];
      if (
        existing.state !== "queued" &&
        existing.state !== "paused" &&
        existing.state !== "interrupted"
      ) {
        throw new Error(`Task ${message.taskId} is not resumable.`);
      }
      const running = this.#store.transition(
        message.taskId,
        message.expectedRevision,
        "running",
        this.#ownerId,
      );
      const startEvents = [this.stateChanged(running, "user"), this.snapshot(running)];
      setImmediate(() => this.startTask(message.taskId, emit));
      return startEvents;
    }

    if (command.type === "task.cancel" || command.type === "task.pause") {
      const active = this.#active.get(message.taskId);
      if (active) {
        active.requestedStop = command.type === "task.pause" ? "paused" : "cancelled";
        active.abort.abort(
          new Error(command.type === "task.pause" ? "Task paused." : "Task cancelled."),
        );
        await active.done;
        const finished = this.#store.get(message.taskId);
        return finished ? [this.snapshot(finished)] : [];
      }
      const nextState = command.type === "task.pause" ? "paused" : "cancelled";
      const updated = this.#store.transition(message.taskId, message.expectedRevision, nextState);
      return [this.stateChanged(updated, "user"), this.snapshot(updated)];
    }

    if (command.type === "approval.respond") {
      return [this.snapshot(existing)];
    }

    throw new Error("Unsupported app-server command.");
  }

  public close(): void {
    for (const active of this.#active.values()) active.abort.abort(new Error("App-server closed."));
    this.#store.close();
  }

  private startTask(taskId: string, emit: Emit): void {
    const abort = new AbortController();
    const active: ActiveTask = { abort, done: Promise.resolve() };
    const done = this.runTask(taskId, active, emit);
    active.done = done;
    this.#active.set(taskId, active);
  }

  private async runTask(taskId: string, active: ActiveTask, emit: Emit): Promise<void> {
    try {
      const prompt = this.#prompts.get(taskId);
      if (prompt === undefined) throw new Error("Task prompt is unavailable after restart.");
      for await (const observation of this.#engine.runTurn(
        { taskId, prompt },
        active.abort.signal,
      )) {
        const metadata = this.#store.get(taskId);
        if (!metadata || metadata.state !== "running") break;
        const event = observationToEvent(taskId, metadata.revision, observation);
        if (event) emit(this.event(taskId, metadata.revision, event));
      }
      const metadata = this.#store.get(taskId);
      if (metadata?.state === "running") {
        const completed = this.#store.transition(taskId, metadata.revision, "completed");
        emit(this.stateChanged(completed, "validator"));
        emit(this.snapshot(completed));
      }
    } catch (error) {
      const metadata = this.#store.get(taskId);
      if (metadata?.state === "running") {
        const nextState =
          active.requestedStop ?? (active.abort.signal.aborted ? "interrupted" : "interrupted");
        const interrupted = this.#store.transition(taskId, metadata.revision, nextState);
        emit(
          this.event(taskId, interrupted.revision, {
            type: "task.error",
            code: nextState === "cancelled" ? "cancelled" : "runtime_error",
          }),
        );
        emit(
          this.stateChanged(interrupted, active.requestedStop === "cancelled" ? "user" : "error"),
        );
        emit(this.snapshot(interrupted));
      }
      void error;
    } finally {
      this.#active.delete(taskId);
    }
  }

  private nextQueueOrder(): number {
    return this.#store.queued().reduce((max, item) => Math.max(max, item.queueOrder ?? 0), 0) + 1;
  }

  private snapshot(metadata: TaskMetadata | TaskSnapshot): EventEnvelope {
    return this.event(metadata.taskId, metadata.revision, {
      type: "snapshot",
      snapshot: {
        taskId: metadata.taskId,
        revision: metadata.revision,
        state: metadata.state === "queued" ? "queued" : metadata.state,
        ...(metadata.approvalProfile === undefined
          ? {}
          : { approvalProfile: metadata.approvalProfile }),
        ...(metadata.ownerId === undefined ? {} : { ownerId: metadata.ownerId }),
      },
    });
  }

  private stateChanged(
    metadata: TaskMetadata,
    reason: "user" | "owner_lost" | "approval" | "validator" | "error",
  ): EventEnvelope {
    return this.event(metadata.taskId, metadata.revision, {
      type: "task.state_changed",
      state: metadata.state,
      reason,
    });
  }

  private event(taskId: string, revision: number, event: RuntimeEvent): EventEnvelope {
    const sequence = (this.#sequences.get(taskId) ?? 0) + 1;
    this.#sequences.set(taskId, sequence);
    return { v: 1, kind: "event", taskId, sequence, revision, event };
  }
}

function observationToEvent(
  _taskId: string,
  _revision: number,
  observation: AgentObservation,
): RuntimeEvent | undefined {
  if (observation.type === "assistant.delta")
    return { type: "assistant.delta", text: observation.text };
  if (observation.type === "tool.completed")
    return { type: "tool.completed", tool: observation.tool, ok: true };
  return undefined;
}

export function runAppServer(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): void {
  const controller = new AppServerController();
  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  const write = (message: ProtocolMessage): void => {
    stdout.write(encodeJsonLine(message));
  };
  void (async () => {
    try {
      for await (const line of lines) {
        try {
          const responses = await controller.dispatch(decodeJsonLine(line), write);
          responses.forEach(write);
        } catch {
          stdout.write('{"v":1,"kind":"error","code":"invalid_message"}\n');
        }
      }
    } finally {
      controller.close();
    }
  })();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAppServer(process.stdin, process.stdout);
}
