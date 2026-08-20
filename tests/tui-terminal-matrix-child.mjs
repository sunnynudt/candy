import { InteractiveTui } from "../apps/tui/dist/main.js";

// The ConPTY bridge closes the pseudo-console output pipe as its host process
// exits. A late terminal stop() write (e.g. showCursor) can then surface as
// EPIPE during Node teardown. In a real interactive terminal the pipe stays
// open, so this is a harness-only edge: swallow EPIPE so the matrix exit code
// stays truthful, and rethrow anything else.
process.on("uncaughtException", (error) => {
  if (error instanceof Error && error.code === "EPIPE") return;
  throw error;
});

const appDataRoot = process.env.CANDY_TERMINAL_MATRIX_APP_DATA_ROOT;
const workspacePath = process.env.CANDY_TERMINAL_MATRIX_WORKSPACE;
const mode = process.env.CANDY_TERMINAL_MATRIX_MODE;
if (appDataRoot === undefined || workspacePath === undefined || mode === undefined)
  throw new Error("Terminal matrix requires an app-data root, workspace, and mode.");

let turnCount = 0;
const engine = {
  async *runTurn(input, signal) {
    yield { type: "turn.started", taskId: input.taskId };
    if (mode === "runtime-failure") throw new Error("workspace runtime failure fixture");
    if (mode === "cancel") {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("terminal matrix cancelled");
    }
    const marker = turnCount++ === 0 ? "terminal-matrix-first-ok" : "terminal-matrix-paste-ok";
    yield { type: "assistant.delta", taskId: input.taskId, text: marker };
    yield { type: "turn.completed", taskId: input.taskId };
  },
};

await new InteractiveTui({ appDataRoot, workspacePath, engine }).run();
