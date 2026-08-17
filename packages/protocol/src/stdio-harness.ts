import { decodeJsonLines, encodeJsonLine } from "./index.js";

try {
  for await (const message of decodeJsonLines(process.stdin)) {
    process.stdout.write(encodeJsonLine(message));
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown protocol error.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
