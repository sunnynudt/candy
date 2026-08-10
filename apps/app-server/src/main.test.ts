import assert from "node:assert/strict";
import test from "node:test";
import { type CommandEnvelope, type ProtocolMessage } from "@candy/protocol";
import { AppServerController } from "./main.js";

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
