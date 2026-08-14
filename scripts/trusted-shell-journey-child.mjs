import { createDefaultInteractiveTui } from "../apps/tui/dist/main.js";

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
