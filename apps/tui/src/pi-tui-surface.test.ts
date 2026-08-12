import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CandyTuiSurface, FakeTerminal, assertSafeTuiEnvironment } from "./pi-tui-surface.js";

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
