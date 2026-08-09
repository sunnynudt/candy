import type { Clock } from "@candy/platform";

export interface AgentTurnInput {
  readonly taskId: string;
  readonly prompt: string;
}

export type AgentObservation =
  | { readonly type: "turn.started"; readonly taskId: string; readonly at: number }
  | { readonly type: "assistant.delta"; readonly text: string }
  | { readonly type: "turn.completed"; readonly taskId: string; readonly at: number };

export interface AgentEngine {
  runTurn(input: AgentTurnInput, signal: AbortSignal): AsyncIterable<AgentObservation>;
}

export class DeterministicAgentEngine implements AgentEngine {
  public constructor(
    private readonly clock: Clock,
    private readonly response: string,
  ) {}

  public async *runTurn(
    input: AgentTurnInput,
    signal: AbortSignal,
  ): AsyncIterable<AgentObservation> {
    throwIfAborted(signal);
    yield { type: "turn.started", taskId: input.taskId, at: this.clock.now() };
    throwIfAborted(signal);
    yield { type: "assistant.delta", text: this.response };
    throwIfAborted(signal);
    yield { type: "turn.completed", taskId: input.taskId, at: this.clock.now() };
  }
}

export interface BrowserCapability {
  readonly available: boolean;
  open(taskId: string, url: string, signal: AbortSignal): Promise<void>;
}

export class BrowserUnavailableError extends Error {
  public constructor() {
    super("Browser capability is unavailable in the TUI runtime.");
    this.name = "BrowserUnavailableError";
  }
}

export class UnavailableBrowserCapability implements BrowserCapability {
  public readonly available = false;

  public open(taskId: string, url: string, signal: AbortSignal): Promise<void> {
    void taskId;
    void url;
    void signal;
    return Promise.reject(new BrowserUnavailableError());
  }
}

export class CandyRuntime {
  public constructor(
    private readonly agentEngine: AgentEngine,
    public readonly browser: BrowserCapability,
  ) {}

  public async runReadOnlyTurn(
    input: AgentTurnInput,
    signal: AbortSignal,
  ): Promise<readonly AgentObservation[]> {
    const observations: AgentObservation[] = [];
    for await (const observation of this.agentEngine.runTurn(input, signal)) {
      observations.push(observation);
    }
    return observations;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Turn aborted.");
  }
}
