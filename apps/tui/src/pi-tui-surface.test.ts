import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("Candy TUI surface keeps five core states clear at 80, 120, and 200 columns", async () => {
  for (const columns of [80, 120, 200]) {
    const root = await mkdtemp(path.join(tmpdir(), `candy-tui-design-${columns}-`));
    const terminal = new FakeTerminal({ columns, rows: 32 });
    let phase: string | undefined;
    let title: string | undefined;
    const surface = new CandyTuiSurface({
      appDataRoot: root,
      terminal,
      taskId: () => (title === undefined ? undefined : "task-design-fixture"),
      taskTitle: () => title,
      taskPhase: () => phase,
      recoveryTaskCount: () => 2,
      worktreeEnabled: () => true,
      trustedShellEnabled: () => true,
      onSubmit: (): void => undefined,
      onInterrupt: (): void => undefined,
    });
    try {
      surface.start();
      await waitForOutput(terminal, /准备新任务[\s\S]*● 就绪/u);

      title = "深入分析当前产品，评估相比 Pi 有哪些差异";
      phase = "tool 读取文件";
      surface.upsertToolActivity("call-1", "◇ 读取文件：docs/product/candy-v1.md");
      await waitForOutput(terminal, /● 读取文件[\s\S]*读取文件：docs\/product\/candy-v1\.md/u);

      phase = "waiting for your approval";
      surface.appendTranscript(
        "! 需要你的确认\n  操作  删除文件\n\n/approve delete-1  删除并继续",
        "approval",
      );
      await waitForOutput(terminal, /● 等待确认[\s\S]*需要你的确认/u);

      phase = "completed";
      surface.appendTranscript("已完成分析，可以继续追问。", "assistant");
      await waitForOutput(terminal, /● 上轮完成[\s\S]*Candy[\s\S]*已完成分析/u);

      surface.appendTranscript("diff --git a/src/value.ts b/src/value.ts\n+const value = 42;\n");
      const output = await waitForOutput(terminal, /diff --git a\/src\/value\.ts/u);
      assert.match(output, /↻ 2 个可恢复任务 · \/tasks/u);
      assert.doesNotMatch(output, /Shell 开启/u);
      if (columns >= 120) assert.match(output, /安全工作区[\s\S]*本地检查就绪/u);
      assert.doesNotMatch(output, /⌘K|local coding studio|recoverable/u);
    } finally {
      await surface.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Candy TUI surface keeps the Full access danger badge visible at every supported width", async () => {
  for (const columns of [80, 120, 200]) {
    const root = await mkdtemp(path.join(tmpdir(), `candy-tui-full-access-status-${columns}-`));
    const terminal = new FakeTerminal({ columns, rows: 32 });
    const surface = new CandyTuiSurface({
      appDataRoot: root,
      terminal,
      workspacePath: () => "/Users/example/project",
      profile: () => "auto",
      worktreeEnabled: () => true,
      fullAccessEnabled: () => true,
      onSubmit: (): void => undefined,
      onInterrupt: (): void => undefined,
    });
    try {
      surface.start();
      const output = await waitForOutput(terminal, /⚠ FULL ACCESS/u);
      assert.match(output, /⚠ FULL ACCESS/u);
      if (columns >= 120) assert.match(output, /access safe/u);
    } finally {
      await surface.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Candy TUI surface exposes a clickable Full access warning entry when available", async () => {
  for (const columns of [80, 120, 200]) {
    const root = await mkdtemp(path.join(tmpdir(), `candy-tui-full-access-entry-${columns}-`));
    const terminal = new FakeTerminal({ columns, rows: 32 });
    let opened = 0;
    const surface = new CandyTuiSurface({
      appDataRoot: root,
      terminal,
      fullAccessAvailable: () => true,
      onSubmit: (): void => undefined,
      onInterrupt: (): void => undefined,
      onOpenFullAccess: (): void => {
        opened += 1;
      },
    });
    try {
      surface.start();
      await waitForOutput(terminal, /开启 Full access/u);
      terminal.emitInput("\x1b[<0;3;2M");
      terminal.emitInput("\x1b[<0;3;2m");
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, 30);
      });
      assert.equal(opened, 1);
    } finally {
      await surface.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Candy TUI surface exposes a second clickable confirmation after the warning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-full-access-confirm-"));
  const terminal = new FakeTerminal({ columns: 120, rows: 32 });
  let confirmations = 0;
  const surface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    fullAccessAvailable: () => true,
    fullAccessConfirmationPending: () => true,
    onSubmit: (): void => undefined,
    onInterrupt: (): void => undefined,
    onConfirmFullAccess: (): void => {
      confirmations += 1;
    },
  });
  try {
    surface.start();
    await waitForOutput(terminal, /确认开启 Full access/u);
    terminal.emitInput("\x1b[<0;3;2M");
    terminal.emitInput("\x1b[<0;3;2m");
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 30);
    });
    assert.equal(confirmations, 1);
  } finally {
    await surface.stop();
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
    terminal.emitInput("\x1b[B");
    terminal.emitInput("\r");
    terminal.emitInput("\r");
    assert.deepEqual(submitted, ["/model", "/model minimax-m3"]);
  } finally {
    await surface.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy slash autocomplete keeps bare /model as an explicit query before model choices", async () => {
  const provider = createCandySlashCommandAutocompleteProvider();
  const suggestions = await provider.getSuggestions(["/model"], 0, 6, {
    signal: new AbortController().signal,
  });
  assert.deepEqual(suggestions?.items, [
    { value: "", label: "查看当前模型", description: "显示当前模型与全部可选项" },
    { value: "deepseek-flash", label: "deepseek-flash", description: "DeepSeek V4 Flash" },
    { value: "deepseek-pro", label: "deepseek-pro", description: "DeepSeek V4 Pro" },
    {
      value: "deepseek-flash-vision",
      label: "deepseek-flash-vision",
      description: "DeepSeek V4 Flash Vision (experimental, multimodal)",
    },
    { value: "minimax-m3", label: "minimax-m3", description: "MiniMax M3 (native image)" },
  ]);
  assert.equal(suggestions?.prefix, "/model");
});

test("Candy slash autocomplete marks the current model and surfaces it in the bare query", async () => {
  const provider = createCandySlashCommandAutocompleteProvider(
    () => process.cwd(),
    [],
    undefined,
    () => "deepseek-v4-flash",
  );
  const suggestions = await provider.getSuggestions(["/model"], 0, 6, {
    signal: new AbortController().signal,
  });
  assert.deepEqual(suggestions?.items, [
    {
      value: "",
      label: "查看当前模型",
      description: "当前模型：deepseek-flash · 显示当前模型与全部可选项",
    },
    { value: "deepseek-flash", label: "deepseek-flash ✓", description: "DeepSeek V4 Flash" },
    { value: "deepseek-pro", label: "deepseek-pro", description: "DeepSeek V4 Pro" },
    {
      value: "deepseek-flash-vision",
      label: "deepseek-flash-vision",
      description: "DeepSeek V4 Flash Vision (experimental, multimodal)",
    },
    { value: "minimax-m3", label: "minimax-m3", description: "MiniMax M3 (native image)" },
  ]);
  assert.equal(suggestions?.prefix, "/model");
});

test("Candy slash autocomplete preserves a bare /model query completion", async () => {
  const provider = createCandySlashCommandAutocompleteProvider();
  const result = provider.applyCompletion(
    ["/model"],
    0,
    6,
    {
      value: "",
      label: "查看当前模型",
      description: "显示当前模型与全部可选项",
    },
    "/model",
  );
  assert.deepEqual(result.lines, ["/model "]);
  assert.equal(result.cursorLine, 0);
  assert.equal(result.cursorCol, "/model ".length);
});

test("Candy TUI surface shows the model popup and submits a bare /model as a query", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-model-popup-"));
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
    terminal.emitInput("/model");
    // Wait for the model chooser to render with all four options visible so
    // we know the autocomplete popup is open before we drive Enter.
    await waitForOutput(terminal, /minimax-m3/u);
    terminal.emitInput("\r");
    assert.deepEqual(submitted, ["/model"]);
  } finally {
    await surface.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy TUI surface lets arrow keys select a model inside a bare /model popup", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-model-popup-arrows-"));
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
    terminal.emitInput("/model");
    await waitForOutput(terminal, /minimax-m3/u);
    terminal.emitInput("\x1b[B"); // Down to deepseek-flash
    terminal.emitInput("\x1b[B"); // Down to deepseek-pro
    terminal.emitInput("\x1b[B"); // Down to deepseek-flash-vision
    terminal.emitInput("\x1b[B"); // Down to minimax-m3
    terminal.emitInput("\r");
    assert.deepEqual(submitted, ["/model minimax-m3"]);
  } finally {
    await surface.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy TUI surface shows queued turn messages in a fixed area and collapses when empty", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-queued-"));
  const terminal: FakeTerminal = new FakeTerminal();
  let queued: readonly string[] = [];
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    queuedTurnMessages: () => queued,
    onSubmit: (): void => undefined,
    onInterrupt: (): void => undefined,
  });
  try {
    surface.start();
    queued = ["[follow-up] report only after validation"];
    surface.refreshQueuedTurnMessages();
    const output = await waitForOutput(terminal, /排队/u);
    assert.match(output, /\[follow-up\] report only after validation/u);
    assert.match(output, /排队/u);
    // Emptying the queue removes the fixed area from subsequent renders.
    const writesBeforeClear: number = terminal.writes.length;
    queued = [];
    surface.refreshQueuedTurnMessages();
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 15);
    });
    assert.doesNotMatch(terminal.writes.slice(writesBeforeClear).join(""), /排队/u);
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

test("Candy slash autocomplete keeps built-ins ahead of colliding or invalid skill names", async () => {
  const provider = createCandySlashCommandAutocompleteProvider(
    () => process.cwd(),
    [
      { name: "model", description: "Colliding skill" },
      { name: "bad/name", description: "Invalid skill" },
    ],
  );
  const suggestions = await provider.getSuggestions(["/mo"], 0, 3, {
    signal: new AbortController().signal,
  });
  assert.deepEqual(suggestions?.items, [
    {
      value: "model",
      label: "model",
      description: "<model> — Choose the primary model",
    },
  ]);
});

test("Candy TUI surface scrolls the transcript with PageUp/PageDown", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-scrollback-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    onSubmit: (): void => undefined,
    onInterrupt: (): void => undefined,
  });
  try {
    surface.start();
    for (let index: number = 0; index < 40; index += 1) {
      surface.appendTranscript(`filler line ${index}\n`);
    }
    await waitForOutput(terminal, /filler line 39/u);
    terminal.writes.length = 0;
    terminal.emitInput("\x1b[5~"); // PageUp
    terminal.emitInput("\x1b[5~");
    terminal.emitInput("\x1b[5~");
    const scrolled = await waitForOutput(terminal, /filler line 0/u);
    assert.match(scrolled, /filler line 0/u);

    terminal.writes.length = 0;
    terminal.emitInput("\x1b[6~"); // PageDown
    terminal.emitInput("\x1b[6~");
    terminal.emitInput("\x1b[6~");
    const tail = await waitForOutput(terminal, /filler line 39/u);
    assert.doesNotMatch(tail, /filler line 0/u);
  } finally {
    await surface.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy TUI surface scrolls the transcript with the mouse wheel", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-wheel-scrollback-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    onSubmit: (): void => undefined,
    onInterrupt: (): void => undefined,
  });
  try {
    surface.start();
    for (let index: number = 0; index < 40; index += 1) {
      surface.appendTranscript(`wheel filler line ${index}\n`);
    }
    await waitForOutput(terminal, /wheel filler line 39/u);
    terminal.writes.length = 0;
    terminal.emitInput("\x1b[<64;10;10M"); // SGR mouse-wheel up
    const scrolled = await waitForOutput(terminal, /wheel filler line 25/u);
    assert.match(scrolled, /wheel filler line 25/u);

    terminal.writes.length = 0;
    terminal.emitInput("\x1b[<65;10;10M"); // SGR mouse-wheel down
    const tail = await waitForOutput(terminal, /wheel filler line 39/u);
    assert.match(tail, /wheel filler line 39/u);
  } finally {
    await surface.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy TUI surface keeps a fitting transcript at the tail", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-scroll-fit-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    onSubmit: (): void => undefined,
    onInterrupt: (): void => undefined,
  });
  try {
    surface.start();
    surface.appendTranscript("short transcript\n");
    await waitForOutput(terminal, /short transcript/u);
    terminal.writes.length = 0;
    terminal.emitInput("\x1b[5~");
    terminal.emitInput("\x1b[6~");
    terminal.emitInput("\x1b[<64;10;10M");
    terminal.emitInput("\x1b[<65;10;10M");
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 40);
    });
    assert.doesNotMatch(terminal.writes.join(""), /short transcript/u);
  } finally {
    await surface.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy TUI surface invokes the copy handler with Ctrl+X", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-copy-"));
  const terminal: FakeTerminal = new FakeTerminal();
  let copies: number = 0;
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    onSubmit: (): void => undefined,
    onInterrupt: (): void => undefined,
    onCopyLastAssistant: (): void => {
      copies += 1;
    },
  });
  try {
    surface.start();
    surface.appendTranscript("status line\n");
    await waitForOutput(terminal, /status line/u);
    terminal.emitInput("\x18"); // Ctrl+X
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 30);
    });
    assert.equal(copies, 1);
  } finally {
    await surface.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy TUI surface invokes the image paste handler with Ctrl+V", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-paste-image-"));
  const terminal: FakeTerminal = new FakeTerminal();
  let pasted: number = 0;
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    onSubmit: (): void => undefined,
    onInterrupt: (): void => undefined,
    onPasteImage: (): void => {
      pasted += 1;
    },
  });
  try {
    surface.start();
    await waitForOutput(terminal, /Ctrl\+V 粘贴图片/u);
    terminal.emitInput("\x16"); // Ctrl+V
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 30);
    });
    assert.equal(pasted, 1);
  } finally {
    await surface.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy TUI surface exposes a clickable copy action after a completed reply", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-copy-action-"));
  const terminal: FakeTerminal = new FakeTerminal();
  let copies: number = 0;
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    taskPhase: (): string => "completed",
    assistantReplyAvailable: (): boolean => true,
    onSubmit: (): void => undefined,
    onInterrupt: (): void => undefined,
    onCopyLastAssistant: (): void => {
      copies += 1;
    },
  });
  try {
    surface.start();
    await waitForOutput(terminal, /复制最后结论/u);
    // The footer is the terminal's final row; use a primary-button click on
    // the link label, then release at the same cell.
    terminal.emitInput("\x1b[<0;3;24M");
    terminal.emitInput("\x1b[<0;3;24m");
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 30);
    });
    assert.equal(copies, 1);
  } finally {
    await surface.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy TUI surface cycles the model with Ctrl+P and Ctrl+Shift+P", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-model-cycle-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const directions: (1 | -1)[] = [];
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    onSubmit: (): void => undefined,
    onInterrupt: (): void => undefined,
    onCycleModel: (direction: 1 | -1): void => {
      directions.push(direction);
    },
  });
  try {
    surface.start();
    terminal.emitInput("\x10"); // Ctrl+P
    terminal.emitInput("\x1b[112;6u"); // Ctrl+Shift+P (kitty, mod 5+1)
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 30);
    });
    assert.deepEqual(directions, [1, -1]);
  } finally {
    await surface.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy TUI surface ignores kitty key releases for copy and cycle", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-key-release-"));
  const terminal: FakeTerminal = new FakeTerminal();
  let copies: number = 0;
  const directions: (1 | -1)[] = [];
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    onSubmit: (): void => undefined,
    onInterrupt: (): void => undefined,
    onCopyLastAssistant: (): void => {
      copies += 1;
    },
    onCycleModel: (direction: 1 | -1): void => {
      directions.push(direction);
    },
  });
  try {
    surface.start();
    surface.appendTranscript("reply", "assistant");
    await waitForOutput(terminal, /reply/u);
    terminal.emitInput("\x1b[120;5:3u"); // Ctrl+X release (kitty)
    terminal.emitInput("\x1b[112;6:3u"); // Ctrl+Shift+P release (kitty)
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 30);
    });
    assert.equal(copies, 0);
    assert.deepEqual(directions, []);
  } finally {
    await surface.stop();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForLastWrite(terminal: FakeTerminal, pattern: RegExp): Promise<string> {
  for (let attempt: number = 0; attempt < 500; attempt += 1) {
    const last = terminal.writes[terminal.writes.length - 1] ?? "";
    if (pattern.test(last)) return last;
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 2);
    });
  }
  return terminal.writes[terminal.writes.length - 1] ?? "";
}

test("Candy TUI surface toggles thinking blocks with Ctrl+T", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-thinking-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    onSubmit: (): void => undefined,
    onInterrupt: (): void => undefined,
  });
  try {
    surface.start();
    surface.appendTranscript("hidden reasoning payload", "thinking");
    await waitForLastWrite(terminal, /思考过程 · Ctrl\+T 展开/u);
    assert.equal(terminal.writes.slice(-1).join("").includes("hidden reasoning"), false);
    terminal.emitInput("\x14"); // Ctrl+T expands
    await waitForLastWrite(terminal, /hidden reasoning payload/u);
    terminal.emitInput("\x14"); // Ctrl+T collapses again
    await waitForLastWrite(terminal, /思考过程 · Ctrl\+T 展开/u);
    assert.equal(terminal.writes.slice(-1).join("").includes("hidden reasoning"), false);
  } finally {
    await surface.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy TUI surface opens the external editor and replaces the input on save", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-external-editor-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const submitted: string[] = [];
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    onSubmit: (text: string): void => {
      submitted.push(text);
    },
    onInterrupt: (): void => undefined,
    launchExternalEditor: async (target: string): Promise<number> => {
      await writeFile(target, "edited prompt\n", "utf8");
      return 0;
    },
  });
  try {
    surface.start();
    terminal.emitInput("fixture");
    terminal.emitInput("\x07"); // Ctrl+G
    await waitForOutput(terminal, /external editor: input replaced/u);
    terminal.emitInput("\r");
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 30);
    });
    assert.deepEqual(submitted, ["edited prompt"]);
    assert.equal(terminal.started, true);
  } finally {
    await surface.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy TUI surface keeps the input when the external editor fails", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-external-editor-fail-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const submitted: string[] = [];
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    onSubmit: (text: string): void => {
      submitted.push(text);
    },
    onInterrupt: (): void => undefined,
    launchExternalEditor: async (): Promise<number> => 3,
  });
  try {
    surface.start();
    terminal.emitInput("keep me");
    terminal.emitInput("\x07"); // Ctrl+G
    await waitForOutput(terminal, /external editor: exited with 3/u);
    terminal.emitInput("\r");
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 30);
    });
    assert.deepEqual(submitted, ["keep me"]);
  } finally {
    await surface.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy TUI surface resumes interactive input after the external editor session", async () => {
  const root: string = await mkdtemp(path.join(tmpdir(), "candy-tui-external-editor-resume-"));
  const terminal: FakeTerminal = new FakeTerminal();
  let submitted: string | undefined;
  const surface: CandyTuiSurface = new CandyTuiSurface({
    appDataRoot: root,
    terminal,
    onSubmit: (text: string): void => {
      submitted = text;
    },
    onInterrupt: (): void => undefined,
    launchExternalEditor: async (target: string): Promise<number> => {
      await writeFile(target, "after editor", "utf8");
      return 0;
    },
  });
  try {
    surface.start();
    surface.appendTranscript("fixture transcript\n");
    terminal.emitInput("first");
    terminal.emitInput("\x07"); // Ctrl+G
    await waitForOutput(terminal, /external editor: input replaced/u);
    // Typing after resume must reach the editor and Ctrl+C must still interrupt.
    terminal.emitInput("!");
    terminal.emitInput("\r");
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 30);
    });
    assert.equal(submitted, "after editor!");
  } finally {
    await surface.stop();
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
