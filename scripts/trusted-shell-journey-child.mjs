import { InteractiveTui } from "../apps/tui/dist/main.js";

if (process.env.CANDY_TRUSTED_SHELL_ACCEPTANCE !== "1") {
  throw new Error("Trusted Shell acceptance child requires the explicit acceptance marker.");
}

const appDataRoot = process.env.CANDY_APP_DATA_ROOT;
const workspace = process.env.CANDY_JOURNEY_WORKSPACE;
if (appDataRoot === undefined || workspace === undefined) {
  throw new Error("Trusted Shell acceptance requires Candy app data and workspace paths.");
}

// This is an acceptance-only composition root. Normal `apps/tui/dist/main.js`
// startup leaves the capability flag false; this child represents the build
// after the platform-specific G2 review has been accepted.
await new InteractiveTui({
  appDataRoot,
  workspacePath: workspace,
  trustedShellAutoAvailable: true,
}).run();
