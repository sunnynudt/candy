import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { PiAgentEngineInput } from "@candy/pi-adapter";
import { type CommandEnvelope, type ProtocolMessage } from "@candy/protocol";
import { AttachmentStore, type AgentTurnInput } from "@candy/runtime";
import { AppServerController, PiAppServerEngine } from "./main.js";

function command(
  taskId: string,
  commandId: string,
  expectedRevision: number,
  value: CommandEnvelope["command"],
): CommandEnvelope {
  return { v: 1, kind: "command", commandId, taskId, expectedRevision, command: value };
}

function eventTypes(messages: readonly ProtocolMessage[]): string[] {
  return messages.flatMap((message) => (message.kind === "event" ? [message.event.type] : []));
}

test("app-server creates, runs, streams and durably completes one task", async () => {
  const controller = new AppServerController();
  const background: ProtocolMessage[] = [];
  try {
    const created = await controller.dispatch(
      command("task-1", "create-1", 0, {
        type: "task.create",
        prompt: "inspect fixture",
        approvalProfile: "read-only",
      }),
    );
    assert.deepEqual(eventTypes(created), ["task.created", "snapshot"]);

    const started = await controller.dispatch(
      command("task-1", "run-1", 0, { type: "task.run" }),
      (message) => background.push(message),
    );
    assert.deepEqual(eventTypes(started), ["task.state_changed", "snapshot"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(eventTypes(background), ["assistant.delta", "task.state_changed", "snapshot"]);
    const last = background.at(-1);
    assert.ok(last?.kind === "event");
    assert.equal(last.event.type, "snapshot");
    if (last.event.type === "snapshot") assert.equal(last.event.snapshot.state, "completed");

    await assert.rejects(
      controller.dispatch(command("task-1", "stale", 0, { type: "task.cancel" })),
      /current revision/u,
    );
  } finally {
    controller.close();
  }
});

test("app-server rejects a secret before it can become an event", async () => {
  const controller = new AppServerController();
  try {
    await assert.rejects(
      controller.dispatch(
        command("task-secret", "create-secret", 0, {
          type: "task.create",
          prompt: "Bearer fixture-secret",
          approvalProfile: "read-only",
        }),
      ),
      /secret/iu,
    );
  } finally {
    controller.close();
  }
});

test("app-server Pi bridge preserves image input for the selected provider", async () => {
  const received: PiAgentEngineInput[] = [];
  const engine = {
    async *runTurn(input: PiAgentEngineInput) {
      received.push(input);
      yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
    },
    async recoverPrompt() {
      return undefined;
    },
  };
  const bridge = new PiAppServerEngine(engine, engine);
  for await (const observation of bridge.runTurn(
    {
      taskId: "task-image-bridge",
      prompt: "describe",
      model: "MiniMax-M3",
      images: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
    },
    new AbortController().signal,
  )) {
    assert.equal(observation.type, "turn.completed");
  }
  assert.deepEqual(received[0]?.images, [{ mimeType: "image/png", data: "aW1hZ2U=" }]);
});

test("app-server preserves actionable provider error codes without exposing messages", async () => {
  const error = Object.assign(new Error("provider diagnostic must not become an event"), {
    code: "needs_credentials",
  });
  const engine = {
    async *runTurn() {
      await Promise.reject(error);
      yield { type: "turn.completed" as const, taskId: "task-provider-error", at: Date.now() };
    },
  };
  const controller = new AppServerController({ engine });
  const background: ProtocolMessage[] = [];
  try {
    await controller.dispatch(
      command("task-provider-error", "create-provider-error", 0, {
        type: "task.create",
        prompt: "run provider",
        approvalProfile: "read-only",
      }),
    );
    await controller.dispatch(
      command("task-provider-error", "run-provider-error", 0, { type: "task.run" }),
      (message) => background.push(message),
    );
    for (let attempt = 0; attempt < 10 && background.length < 3; attempt += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const errorEvent = background.find(
      (message) => message.kind === "event" && message.event.type === "task.error",
    );
    assert.ok(errorEvent?.kind === "event" && errorEvent.event.type === "task.error");
    if (errorEvent?.kind === "event" && errorEvent.event.type === "task.error") {
      assert.equal(errorEvent.event.code, "needs_credentials");
      assert.equal(JSON.stringify(errorEvent).includes("provider diagnostic"), false);
    }
  } finally {
    controller.close();
  }
});

test("app-server keeps a running task read-only to a second owner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-app-server-owners-"));
  const databasePath = path.join(root, "state", "tasks.sqlite");
  let releaseTurn: (() => void) | undefined;
  const turnReleased = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const ownerEngine = {
    async *runTurn(input: AgentTurnInput) {
      resolveStarted?.();
      await turnReleased;
      yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
    },
  };
  const first = new AppServerController({ databasePath, engine: ownerEngine, ownerId: "owner-1" });
  const second = new AppServerController({
    databasePath,
    ownerId: "owner-2",
  });
  try {
    await first.dispatch(
      command("task-owned", "create-owned", 0, {
        type: "task.create",
        prompt: "owned task",
        approvalProfile: "read-only",
      }),
    );
    await first.dispatch(command("task-owned", "run-owned", 0, { type: "task.run" }), (message) => {
      if (
        message.kind === "event" &&
        message.event.type === "snapshot" &&
        message.event.snapshot.state === "completed"
      )
        resolveCompleted?.();
    });
    await started;
    const remoteCancel = await second.dispatch(
      command("task-owned", "remote-cancel", 1, { type: "task.cancel" }),
    );
    const snapshot = remoteCancel.at(-1);
    assert.ok(snapshot?.kind === "event" && snapshot.event.type === "snapshot");
    if (snapshot?.kind === "event" && snapshot.event.type === "snapshot") {
      assert.equal(snapshot.event.snapshot.state, "running");
      assert.equal(snapshot.event.snapshot.ownerId, "owner-1");
    }
    releaseTurn?.();
    await completed;
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("app-server resolves Candy-owned image attachments into the selected MiniMax turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-app-server-attachments-"));
  const attachmentStore = new AttachmentStore(path.join(root, "attachments"));
  let observedImages = 0;
  let resolveObservedImages: (() => void) | undefined;
  const imagesObserved = new Promise<void>((resolve) => {
    resolveObservedImages = resolve;
  });
  const engine = {
    async *runTurn(input: AgentTurnInput) {
      observedImages = input.images?.length ?? 0;
      resolveObservedImages?.();
      yield { type: "turn.completed" as const, taskId: "task-image", at: Date.now() };
    },
  };
  const attachment = await attachmentStore.put(
    "image",
    "image/png",
    new TextEncoder().encode("fixture-image"),
  );
  const controller = new AppServerController({ engine, attachments: attachmentStore });
  const background: ProtocolMessage[] = [];
  try {
    await controller.dispatch(
      command("task-image", "create-image", 0, {
        type: "task.create",
        prompt: "describe image",
        approvalProfile: "read-only",
        model: "MiniMax-M3",
        attachmentIds: [attachment.id],
      }),
    );
    await controller.dispatch(
      command("task-image", "run-image", 0, { type: "task.run" }),
      (message) => background.push(message),
    );
    await imagesObserved;
    for (
      let attempt = 0;
      attempt < 10 &&
      !background.some(
        (message) =>
          message.kind === "event" &&
          message.event.type === "snapshot" &&
          message.event.snapshot.state === "completed",
      );
      attempt += 1
    )
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(observedImages, 1);
    assert.equal(
      background.some(
        (message) =>
          message.kind === "event" &&
          message.event.type === "snapshot" &&
          message.event.snapshot.state === "completed",
      ),
      true,
      JSON.stringify(background),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("app-server limits starts to three active tasks and promotes queued FIFO work", async () => {
  let active = 0;
  let maximumActive = 0;
  const started = new Set<string>();
  const gateResolvers = new Map<string, () => void>();
  let resolveThreeStarted: (() => void) | undefined;
  const threeStarted = new Promise<void>((resolve) => {
    resolveThreeStarted = resolve;
  });
  let resolveAllCompleted: (() => void) | undefined;
  const allCompleted = new Promise<void>((resolve) => {
    resolveAllCompleted = resolve;
  });
  const completed = new Set<string>();
  const engine = {
    async *runTurn(input: AgentTurnInput) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started.add(input.taskId);
      if (started.size === 3) resolveThreeStarted?.();
      await new Promise<void>((resolve) => gateResolvers.set(input.taskId, resolve));
      active -= 1;
      yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
    },
  };
  const controller = new AppServerController({ engine });
  const background = new Map<string, ProtocolMessage[]>();
  try {
    for (let index = 1; index <= 4; index += 1) {
      const taskId = `task-fifo-${index}`;
      background.set(taskId, []);
      await controller.dispatch(
        command(taskId, `create-${index}`, 0, {
          type: "task.create",
          prompt: taskId,
          approvalProfile: "read-only",
        }),
      );
      await controller.dispatch(
        command(taskId, `run-${index}`, 0, { type: "task.run" }),
        (message) => {
          background.get(taskId)?.push(message);
          if (
            message.kind === "event" &&
            message.event.type === "snapshot" &&
            message.event.snapshot.state === "completed"
          ) {
            completed.add(taskId);
            if (completed.size === 4) resolveAllCompleted?.();
          }
        },
      );
    }
    await threeStarted;
    const queuedSnapshot = (
      await controller.dispatch(command("task-fifo-4", "snapshot-4", 0, { type: "snapshot" }))
    ).at(-1);
    assert.ok(queuedSnapshot?.kind === "event");
    if (queuedSnapshot?.kind === "event" && queuedSnapshot.event.type === "snapshot") {
      assert.equal(queuedSnapshot.event.snapshot.state, "queued");
      assert.equal(queuedSnapshot.event.snapshot.revision, 0);
    }
    assert.equal(started.has("task-fifo-4"), false);
    gateResolvers.get("task-fifo-1")?.();
    for (let attempt = 0; attempt < 20 && !started.has("task-fifo-4"); attempt += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(started.has("task-fifo-4"), true);
    for (const resolve of gateResolvers.values()) resolve();
    await allCompleted;
    assert.equal(maximumActive <= 3, true);
  } finally {
    controller.close();
  }
});
