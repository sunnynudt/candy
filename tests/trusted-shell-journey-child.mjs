import { createDefaultInteractiveTui } from "../apps/tui/dist/main.js";

// The ConPTY bridge closes the pseudo-console output pipe as its host process
// exits. A late terminal stop() write (e.g. showCursor) can then surface as
// EPIPE during Node teardown. In a real interactive terminal the pipe stays
// open, so this is a harness-only edge: swallow EPIPE so the journey exit code
// stays truthful, and rethrow anything else.
process.on("uncaughtException", (error) => {
  if (error instanceof Error && error.code === "EPIPE") return;
  throw error;
});

const appDataRoot = process.env.CANDY_APP_DATA_ROOT;
const workspace = process.env.CANDY_JOURNEY_WORKSPACE;
if (appDataRoot === undefined || workspace === undefined) {
  throw new Error("Trusted Shell journey requires Candy app data and workspace paths.");
}

// Exercise the same normal composition root as `npm run tui`; no acceptance
// marker or test-only capability override may enable Trusted Shell Auto.
await createDefaultInteractiveTui({
  appDataRoot,
  workspacePath: workspace,
}).run();
