import { createCandyWorkspaceTools } from "../packages/pi-adapter/dist/index.js";
import { InteractiveTui } from "../apps/tui/dist/main.js";

class TuiJourneyFixtureEngine {
  #turn = 0;

  async *runTurn(input, signal) {
    if (signal.aborted) throw new Error("fixture turn cancelled");
    if (input.model !== "MiniMax-M3") throw new Error("journey fixture requires MiniMax M3");
    if (input.images?.length !== 1 || input.images[0]?.mimeType !== "image/png")
      throw new Error("journey fixture did not receive the persisted image");

    const tools = createCandyWorkspaceTools(input.cwd, "auto", undefined, input.fileDeleteApproval);
    const execute = async (name, args) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`journey fixture tool is unavailable: ${name}`);
      try {
        await tool.execute(`journey-${this.#turn}-${name}`, args, signal, undefined, {});
        return true;
      } catch (error) {
        if (name !== "candy_delete") throw error;
        return false;
      }
    };

    yield { type: "turn.started", taskId: input.taskId };
    for (const [name, args] of [
      ["candy_list", { path: "." }],
      ["candy_read", { path: "src/value.ts" }],
      ["candy_search", { query: "value" }],
    ]) {
      const ok = await execute(name, args);
      yield { type: "tool.completed", taskId: input.taskId, tool: name, ok };
    }

    if (this.#turn === 0) {
      const writeOk = await execute("candy_write", {
        path: "src/created.ts",
        content: "export const created = true;\n",
      });
      yield { type: "tool.completed", taskId: input.taskId, tool: "candy_write", ok: writeOk };
      const editOk = await execute("candy_edit", {
        path: "src/value.ts",
        edits: [{ oldText: "= 1", newText: "= 2" }],
      });
      yield { type: "tool.completed", taskId: input.taskId, tool: "candy_edit", ok: editOk };
      const deleted = await execute("candy_delete", { path: "remove-first.txt" });
      yield {
        type: "tool.completed",
        taskId: input.taskId,
        tool: "candy_delete",
        ok: deleted,
      };
      yield {
        type: "assistant.delta",
        taskId: input.taskId,
        text: "fixture turn 1: listed, searched, read, created src/created.ts, edited src/value.ts, and deleted the requested file.\n",
      };
    } else {
      const createdReadOk = await execute("candy_read", { path: "src/created.ts" });
      yield { type: "tool.completed", taskId: input.taskId, tool: "candy_read", ok: createdReadOk };
      const editOk = await execute("candy_edit", {
        path: "src/value.ts",
        edits: [{ oldText: "= 2", newText: "= 3" }],
      });
      yield { type: "tool.completed", taskId: input.taskId, tool: "candy_edit", ok: editOk };
      const deleted = await execute("candy_delete", { path: "remove-second.txt" });
      yield {
        type: "tool.completed",
        taskId: input.taskId,
        tool: "candy_delete",
        ok: deleted,
      };
      yield {
        type: "assistant.delta",
        taskId: input.taskId,
        text: "fixture turn 2: reopened the created file, repaired src/value.ts, and deleted the requested file.\n",
      };
    }

    this.#turn += 1;
    yield { type: "turn.completed", taskId: input.taskId };
  }
}

const appDataRoot = process.env.CANDY_APP_DATA_ROOT;
if (appDataRoot === undefined || appDataRoot.length === 0)
  throw new Error("CANDY_APP_DATA_ROOT is required for the TUI journey fixture");

await new InteractiveTui({
  appDataRoot,
  workspacePath: process.cwd(),
  engine: new TuiJourneyFixtureEngine(),
}).run();
