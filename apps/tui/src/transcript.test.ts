import assert from "node:assert/strict";
import test from "node:test";
import { CandyTranscript } from "./transcript.js";

function renderLines(transcript: CandyTranscript, width: number = 80): string[] {
  return transcript.render(width);
}

test("plain segments render literally without markdown interpretation", () => {
  const transcript = new CandyTranscript();
  transcript.append("# not a heading\n- not a bullet\n--- not a rule\n");
  const lines = renderLines(transcript);
  assert.ok(lines.some((line) => line.includes("# not a heading")));
  assert.ok(lines.some((line) => line.includes("- not a bullet")));
  assert.ok(lines.some((line) => line.includes("--- not a rule")));
  assert.equal(
    lines.some((line) => line.includes("\x1b[1m")),
    false,
  );
});

test("assistant segments render markdown structure", () => {
  const transcript = new CandyTranscript();
  transcript.append("# Heading\n\n**bold** and `code`", "assistant");
  const lines = renderLines(transcript);
  assert.ok(lines.some((line) => line.includes(`\x1b[1mHeading\x1b[0m`)));
  assert.ok(lines.some((line) => line.includes(`\x1b[1mbold\x1b[0m`)));
});

test("assistant code fences stay open across streamed deltas", () => {
  const transcript = new CandyTranscript();
  transcript.append("```ts\n", "assistant");
  transcript.append("const answer = 42;\n", "assistant");
  transcript.append("```\n", "assistant");
  const lines = renderLines(transcript);
  assert.ok(lines.some((line) => line.includes("const answer = 42;")));
});

test("transcript renders its complete bounded live content for the owning ScrollView", () => {
  const transcript = new CandyTranscript();
  for (let index = 0; index < 10; index += 1) {
    transcript.append(`line ${index}\n`);
  }
  const lines = renderLines(transcript);
  assert.ok(lines.some((line) => line.includes("line 0")));
  assert.ok(lines.some((line) => line.includes("line 9")));
});

test("live transcript window is bounded and drops the oldest segment", () => {
  const transcript = new CandyTranscript();
  transcript.append("A".repeat(200 * 1024));
  transcript.append("tail marker");
  const output = renderLines(transcript, 40).join("\n");
  assert.ok(output.includes("tail marker"));
  assert.ok(!output.includes("A".repeat(64)));
});

test("empty appends are ignored and an empty transcript renders nothing", () => {
  const transcript = new CandyTranscript();
  transcript.append("");
  assert.deepEqual(renderLines(transcript), []);
  transcript.append("\n");
  assert.ok(renderLines(transcript).length > 0);
});

test("thinking segments render collapsed by default and expand with the toggle", () => {
  const transcript = new CandyTranscript();
  transcript.append("reasoning text here", "thinking");
  assert.equal(transcript.thinkingVisible, false);
  let lines = renderLines(transcript);
  assert.equal(lines.length, 1);
  assert.ok((lines[0] ?? "").includes("已折叠"));
  assert.ok(!(lines[0] ?? "").includes("reasoning"));

  transcript.toggleThinking();
  assert.equal(transcript.thinkingVisible, true);
  lines = renderLines(transcript);
  assert.ok(lines.some((line) => line.includes("Ctrl+T 折叠")));
  assert.ok(lines.some((line) => line.includes("reasoning text here")));
  assert.ok(lines.some((line) => line.includes("\x1b[2m")));

  transcript.toggleThinking();
  lines = renderLines(transcript);
  assert.equal(lines.length, 1);
});

test("thinking content renders literally without markdown interpretation", () => {
  const transcript = new CandyTranscript();
  transcript.append("# not a heading\n- not a bullet", "thinking");
  transcript.toggleThinking();
  const lines = renderLines(transcript);
  assert.ok(lines.some((line) => line.includes("# not a heading")));
  assert.ok(lines.some((line) => line.includes("- not a bullet")));
  assert.ok(lines.every((line) => !line.includes("\x1b[1m")));
});

test("consecutive thinking appends coalesce into one marker", () => {
  const transcript = new CandyTranscript();
  transcript.append("first part ", "thinking");
  transcript.append("second part", "thinking");
  transcript.toggleThinking();
  const lines = renderLines(transcript);
  assert.equal(lines.filter((line) => line.includes("Ctrl+T 折叠")).length, 1);
  assert.ok(lines.some((line) => line.includes("first part second part")));
});
