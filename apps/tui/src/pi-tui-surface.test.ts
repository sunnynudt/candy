import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CandyTuiSurface, FakeTerminal, assertSafeTuiEnvironment } from "./pi-tui-surface.js";
import { createCandySlashCommandAutocompleteProvider } from "./slash-commands.js";

async function waitForOutput(
  terminal: FakeTerminal,
  pattern: RegExp,
  maxAttempts: number = 500,
): Promise<string> {
  for (let attempt: number = 0; attempt < maxAttempts; attempt += 1) {
    const output = terminal.writes.join("");
    if (pattern.test(output)) return output;
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 1);
    });
  }
  return terminal.writes.join("");
}

test("Candy TUI rejects all Pi debug and log environment variables", () => {
  assertSafeTuiEnvironment({});
  assert.throws(
    () => assertSafeTuiEnvironment({ PI_TUI_WRITE_LOG: "fixture" }),
    /PI_TUI_WRITE_LOG/u,
  );
  assert.throws(() => assertSafeTuiEnvironment({ PI_TUI_DEBUG: "0" }), /PI_TUI_DEBUG/u);
  assert.throws(
    () => assertSafeTuiEnvironment({ PI_DEBUG_REDRAW: "disabled" }),
    /PI_DEBUG_REDRAW/u,
  );
});

test("Candy TUI surface restores a fake terminal on normal stop and Ctrl+C", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-surface-"));
  const terminal: FakeTerminal = new FakeTerminal();
  let interrupted: boolean = false;
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    onSubmit: (): void => undefined,
    onInterrupt: (): void => {
      interrupted = true;
    },
  });
  try {
    surface.appendTranscript("fixture transcript");
    surface.start();
    terminal.emitInput("\x03");
    await surface.stop();
    assert.equal(interrupted, true);
    assert.equal(terminal.started, true);
    assert.equal(terminal.stopped, true);
    assert.equal(terminal.drainCalls, 1);
    assert.equal(terminal.cursorShown, true);
    assert.ok(
      terminal.writes.some((value: string): boolean => value.includes("fixture transcript")),
    );
    assert.ok(!terminal.writes.some((value: string): boolean => value.includes("PI_TUI_DEBUG")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy TUI surface uses an explicit Candy app-data log directory", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-log-path-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    onSubmit: (): void => undefined,
    onInterrupt: (): void => undefined,
  });
  try {
    assert.equal(surface.logDirectory, path.join(root, "logs"));
    surface.start();
    await surface.stop();
    assert.equal(
      terminal.writes.some((value: string): boolean => value.includes("/.pi/")),
      false,
    );
    assert.equal(
      terminal.writes.some((value: string): boolean => value.includes("/tmp/tui")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy TUI surface displays Candy command suggestions when slash is typed", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-slash-commands-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    onSubmit: (): void => undefined,
    onInterrupt: (): void => undefined,
  });
  try {
    surface.start();
    terminal.emitInput("/");
    const output = await waitForOutput(terminal, /\/model/u);
    assert.match(output, /Choose the primary model/u);
  } finally {
    await surface.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy TUI surface completes a command name and its model argument", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-slash-completion-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const submitted: string[] = [];
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    onSubmit: (text: string): void => {
      submitted.push(text);
    },
    onInterrupt: (): void => undefined,
  });
  try {
    surface.start();
    terminal.emitInput("/mo");
    await waitForOutput(terminal, /\/model/u);
    terminal.emitInput("\t");
    terminal.emitInput("\r");
    assert.deepEqual(submitted, ["/model"]);

    terminal.emitInput("/model ");
    terminal.emitInput("\t");
    await waitForOutput(terminal, /minimax-m3/u);
    terminal.emitInput("\x1b[B");
    terminal.emitInput("\x1b[B");
    terminal.emitInput("\r");
    terminal.emitInput("\r");
    assert.deepEqual(submitted, ["/model", "/model minimax-m3"]);
  } finally {
    await surface.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy slash autocomplete never falls through to file discovery", async () => {
  const provider = createCandySlashCommandAutocompleteProvider();
  const suggestions = await provider.getSuggestions(["/attach @"], 0, 9, {
    signal: new AbortController().signal,
  });
  assert.equal(suggestions, null);
});

test("Candy TUI surface restores the terminal when startup throws", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-start-error-"));
  class ThrowingTerminal extends FakeTerminal {
    public override start(onInput: (data: string) => void, onResize: () => void): void {
      super.start(onInput, onResize);
      throw new Error("fixture terminal start failure");
    }
  }
  const terminal: ThrowingTerminal = new ThrowingTerminal();
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    onSubmit: (): void => undefined,
    onInterrupt: (): void => undefined,
  });
  try {
    assert.throws(() => surface.start(), /fixture terminal start failure/u);
    await surface.stop();
    assert.equal(terminal.stopped, true);
    assert.equal(terminal.drainCalls, 1);
    assert.equal(terminal.cursorShown, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
