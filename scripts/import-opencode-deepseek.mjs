import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KeyringCredentialStore, parseOpenCodeDeepSeekCredential } from "@candy/platform";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceArgument = readArgument("--source");
const confirmed = process.argv.includes("--confirm-opencode-import");
const replace = process.argv.includes("--replace");

if (!confirmed) {
  console.error(
    "OpenCode import is opt-in. Use --confirm-opencode-import from a private local terminal.",
  );
  process.exitCode = 2;
} else {
  process.exitCode = await importCredential();
}

async function importCredential() {
  try {
    const source = await resolveSource(sourceArgument);
    const raw = JSON.parse(await readFile(source, "utf8"));
    const credential = parseOpenCodeDeepSeekCredential(raw);

    const store = new KeyringCredentialStore();
    if (!replace && store.has("deepseek") === "present") {
      console.error("OpenCode import refused: Candy DeepSeek credential is already present.");
      return 2;
    }
    store.replace("deepseek", credential);
    console.log("OpenCode DeepSeek credential imported into Candy Keychain; value omitted.");
    return 0;
  } catch (error) {
    console.error(`OpenCode import failed: ${classifyFailure(error)}.`);
    return 1;
  }
}

async function resolveSource(argument) {
  const candidate = argument === undefined ? defaultSource() : argument;
  if (!path.isAbsolute(candidate)) throw new Error("source must be an absolute path");
  const source = await realpath(candidate);
  if (path.basename(source) !== "auth.json") throw new Error("source must be auth.json");
  if (!source.split(path.sep).some((segment) => segment.toLowerCase() === "opencode")) {
    throw new Error("source must be inside an OpenCode directory");
  }
  if (isInside(root, source)) throw new Error("source must be outside the Candy repository");
  return source;
}

function defaultSource() {
  if (process.platform === "win32") {
    const appData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(appData, "opencode", "auth.json");
  }
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function classifyFailure(error) {
  if (error instanceof SyntaxError) return "invalid_json";
  if (error instanceof Error && /credential store|keychain|native/iu.test(error.message)) {
    return "candy_keychain_unavailable";
  }
  if (error instanceof Error && /unavailable|invalid|auth data|source/iu.test(error.message)) {
    return "invalid_opencode_source";
  }
  return "local_import_error";
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
