import { createInterface } from "node:readline";
import { decodeJsonLine, encodeJsonLine } from "./index.js";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  try {
    process.stdout.write(encodeJsonLine(decodeJsonLine(line)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown protocol error.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    break;
  }
}
