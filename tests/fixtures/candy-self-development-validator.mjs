import { readFile } from "node:fs/promises";

const expected =
  "# Candy self-development dogfood\nVerified by the real Candy TUI and DeepSeek Pi Agent Engine.\n";
const actual = await readFile("docs/implementation/self-development-dogfood-note.md", "utf8");
if (actual !== expected) {
  console.error("self-development note does not match the reviewed acceptance content");
  process.exitCode = 1;
}
