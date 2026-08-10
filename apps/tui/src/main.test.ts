import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { InteractiveTui, type TuiAgentEngine } from "./main.js";

test("interactive TUI creates a queued task, runs it, and reports completion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-"));
  let output = "";
  const engine: TuiAgentEngine = {
    async *runTurn(input, signal) {
      if (signal.aborted) throw new Error("cancelled");
      yield { type: "turn.started", taskId: input.taskId };
      yield { type: "assistant.delta", taskId: input.taskId, text: "fixture response" };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  try {
    await new InteractiveTui({
      input: Readable.from(
        (async function* () {
          yield "inspect fixture\n";
          await new Promise<void>((resolve) => setImmediate(resolve));
          yield ":tasks\n";
          await new Promise<void>((resolve) => setImmediate(resolve));
          yield ":quit\n";
        })(),
      ),
      output: outputStream,
      appDataRoot: root,
      engine,
    }).run();
    assert.match(output, /created task-/u);
    assert.match(output, /fixture response/u);
    assert.match(output, /completed/u);
    assert.match(output, /task-.*completed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
