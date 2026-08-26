import path from "node:path";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  Editor,
  ProcessTerminal,
  Spacer,
  Text,
  TuiAltScreen,
  isKeyRelease,
  matchesKey,
  type EditorTheme,
  Key,
} from "@earendil-works/pi-tui";
import { containsCredentialMaterial } from "@candy/platform";
import { createCandySlashCommandAutocompleteProvider } from "./slash-commands.js";
import { CandyTranscript, type CandyTranscriptKind } from "./transcript.js";
import { launchExternalEditor, normalizeEditorOutput } from "./external-editor.js";

const TUI_DEBUG_ENVIRONMENT_NAMES: readonly string[] = [
  "PI_TUI_WRITE_LOG",
  "PI_TUI_DEBUG",
  "PI_DEBUG_REDRAW",
];

/** Rows below the transcript viewport: spacer + input hint + editor border + editor content + slack. */
const RESERVED_BELOW_TRANSCRIPT_ROWS = 6;

const EDITOR_THEME: EditorTheme = {
  borderColor: (value: string): string => value,
  selectList: {
    selectedPrefix: (value: string): string => value,
    selectedText: (value: string): string => value,
    description: (value: string): string => value,
    scrollInfo: (value: string): string => value,
    noMatch: (value: string): string => value,
  },
};

export interface CandyTuiTerminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  drainInput(maxMs?: number, idleMs?: number): Promise<void>;
  write(data: string): void;
  readonly columns: number;
  readonly rows: number;
  readonly kittyProtocolActive: boolean;
  moveBy(lines: number): void;
  hideCursor(): void;
  showCursor(): void;
  clearLine(): void;
  clearFromCursor(): void;
  clearScreen(): void;
  setTitle(title: string): void;
  setProgress(active: boolean): void;
}

export interface CandyTuiSurfaceOptions {
  readonly appDataRoot: string;
  readonly workspacePath?: () => string;
  readonly terminal?: CandyTuiTerminal | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly onSubmit: (text: string) => void;
  readonly onInterrupt: () => void;
  /** Copy the last assistant reply; the surface owns the transcript text. */
  readonly onCopyLastAssistant?: () => void;
  /** Cycle the selected model; 1 forward, -1 backward. */
  readonly onCycleModel?: (direction: 1 | -1) => void;
  /** Test seam; the production default launches the resolved editor command. */
  readonly launchExternalEditor?: (target: string) => Promise<number>;
}

export class CandyTuiSurface {
  readonly #terminal: CandyTuiTerminal;
  readonly #tui: TuiAltScreen;
  readonly #transcript: CandyTranscript;
  readonly #editor: Editor;
  readonly #appDataRoot: string;
  readonly #launchExternalEditor: (target: string) => Promise<number>;
  readonly #onSubmit: (text: string) => void;
  readonly #onInterrupt: () => void;
  readonly #onCopyLastAssistant: (() => void) | undefined;
  readonly #onCycleModel: ((direction: 1 | -1) => void) | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #removeInterruptListener: () => void;
  readonly #removeScrollListener: () => void;
  readonly #removeKeybindingListener: () => void;
  readonly #removeInputLogListener: (() => void) | undefined;
  public readonly logDirectory: string;
  #started: boolean = false;
  #editorOpen: boolean = false;

  public constructor(options: CandyTuiSurfaceOptions) {
    this.#terminal = options.terminal ?? new ProcessTerminal();
    this.#onSubmit = options.onSubmit;
    this.#onInterrupt = options.onInterrupt;
    this.#onCopyLastAssistant = options.onCopyLastAssistant;
    this.#onCycleModel = options.onCycleModel;
    this.#environment = options.environment ?? process.env;
    this.#appDataRoot = path.resolve(options.appDataRoot);
    this.#launchExternalEditor =
      options.launchExternalEditor ??
      ((target: string): Promise<number> => launchExternalEditor(target));
    this.logDirectory = path.join(this.#appDataRoot, "logs");
    this.#tui = new TuiAltScreen(this.#terminal, true, this.logDirectory);
    this.#transcript = new CandyTranscript(() =>
      Math.max(8, this.#terminal.rows - RESERVED_BELOW_TRANSCRIPT_ROWS),
    );
    this.#editor = new Editor(this.#tui, EDITOR_THEME, { paddingX: 1 });
    this.#editor.setAutocompleteProvider(
      createCandySlashCommandAutocompleteProvider(options.workspacePath ?? (() => process.cwd())),
    );
    this.#editor.onSubmit = (text: string): void => {
      const submittedText: string = text.trim();
      this.#editor.setText("");
      if (submittedText.length > 0) this.#onSubmit(submittedText);
    };
    this.#tui.addChild(this.#transcript);
    this.#tui.addChild(new Spacer(1));
    this.#tui.addChild(new Text("输入 Input >（最底部输入行，回车提交）"));
    this.#tui.addChild(this.#editor);
    this.#tui.setFocus(this.#editor);
    this.#removeInterruptListener = this.#tui.addInputListener(
      (data: string): { consume: boolean } | undefined => {
        if (!matchesKey(data, "ctrl+c")) return undefined;
        this.#onInterrupt();
        return { consume: true };
      },
    );
    // Transcript scrollback. PageUp/PageDown scroll the transcript only while
    // it overflows the viewport; otherwise they stay available to the editor
    // for paging multi-line input. Key releases are filtered so kitty
    // terminals do not scroll twice per key press. A consumed scroll key must
    // request a render itself because the TUI only re-renders after the
    // focused component handles input.
    this.#removeScrollListener = this.#tui.addInputListener(
      (data: string): { consume: boolean } | undefined => {
        if (!this.#transcript.overflowing || isKeyRelease(data)) return undefined;
        if (matchesKey(data, "pageUp")) {
          this.#transcript.pageUp();
          this.#tui.requestRender();
          return { consume: true };
        }
        if (matchesKey(data, "pageDown")) {
          this.#transcript.pageDown();
          this.#tui.requestRender();
          return { consume: true };
        }
        return undefined;
      },
    );
    // Application keybindings: copy the last assistant reply (Ctrl+X) and
    // cycle the selected model (Ctrl+P forward, Ctrl+Shift+P backward). The
    // shifted binding is matched first because legacy terminals report
    // Ctrl+Shift+P as plain Ctrl+P. Key releases are filtered so kitty
    // terminals do not trigger the action twice per key press.
    this.#removeKeybindingListener = this.#tui.addInputListener(
      (data: string): { consume: boolean } | undefined => {
        if (isKeyRelease(data)) return undefined;
        if (matchesKey(data, Key.ctrlShift("p"))) {
          this.#onCycleModel?.(-1);
          return { consume: true };
        }
        if (matchesKey(data, Key.ctrl("p"))) {
          this.#onCycleModel?.(1);
          return { consume: true };
        }
        if (matchesKey(data, Key.ctrl("x"))) {
          this.#onCopyLastAssistant?.();
          return { consume: true };
        }
        if (matchesKey(data, Key.ctrl("t"))) {
          // Thinking visibility is a view state owned by the transcript.
          this.#transcript.toggleThinking();
          this.#tui.requestRender();
          return { consume: true };
        }
        if (matchesKey(data, Key.ctrl("g"))) {
          void this.openExternalEditor();
          return { consume: true };
        }
        return undefined;
      },
    );
    const inputLog = this.#environment.CANDY_TUI_INPUT_LOG;
    this.#removeInputLogListener =
      inputLog === undefined || inputLog.length === 0
        ? undefined
        : this.#tui.addInputListener((data: string) => {
            // Opt-in raw-input diagnostics for terminal compatibility issues.
            // The file path is chosen by the user; this listener never runs in
            // normal operation and does not affect input handling. Credential-
            // shaped input is never written to the diagnostic log.
            try {
              if (containsCredentialMaterial(data)) return undefined;
              appendFileSync(
                inputLog,
                `${JSON.stringify({ at: Date.now(), data })}${"\n"}`,
                "utf8",
              );
            } catch {
              // Diagnostics must never break interactive input.
            }
            return undefined;
          });
  }

  public appendTranscript(value: string, kind: CandyTranscriptKind = "plain"): void {
    this.#transcript.append(value, kind);
    this.#tui.requestRender();
  }

  /**
   * Suspend the TUI, open the current editor content in the external
   * editor, and replace the input with the saved result on a clean exit.
   * The TUI resumes in all paths and the Candy-owned temp file is always
   * deleted.
   */
  public async openExternalEditor(): Promise<void> {
    if (this.#editorOpen) return;
    this.#editorOpen = true;
    const original = this.#editor.getText();
    const target = path.join(this.#appDataRoot, "state", `external-editor-${process.pid}.txt`);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, original, "utf8");
      await this.#suspend();
      const exitCode = await this.#launchExternalEditor(target);
      const updated = await readFile(target, "utf8");
      if (exitCode !== 0) {
        this.appendTranscript(`external editor: exited with ${exitCode}; input unchanged\n`);
        return;
      }
      const normalized = normalizeEditorOutput(original, updated);
      this.#editor.setText(normalized);
      this.appendTranscript(
        normalized === original
          ? "external editor: no change\n"
          : `external editor: input replaced (${normalized.length} chars)\n`,
      );
    } catch (error) {
      this.appendTranscript(`external editor: ${(error as Error).message}\n`);
    } finally {
      await rm(target, { force: true }).catch(() => undefined);
      this.#editorOpen = false;
      this.#resume();
    }
  }

  /** Restore the terminal without dropping TUI input listeners. */
  async #suspend(): Promise<void> {
    this.#tui.stop();
    await this.#terminal.drainInput();
    this.#terminal.showCursor();
  }

  /** Reconnect the terminal and re-render after an external editor session. */
  #resume(): void {
    this.#tui.start();
    this.#tui.requestRender();
  }

  public start(): void {
    assertSafeTuiEnvironment(this.#environment);
    this.#started = true;
    this.#tui.start();
  }

  public async stop(): Promise<void> {
    const wasStarted: boolean = this.#started;
    this.#started = false;
    this.#removeInterruptListener();
    this.#removeScrollListener();
    this.#removeKeybindingListener();
    this.#removeInputLogListener?.();
    let rendererStopped: boolean = false;
    try {
      if (wasStarted) {
        this.#tui.stop();
        rendererStopped = true;
      }
    } finally {
      try {
        await this.#terminal.drainInput();
      } finally {
        this.#terminal.showCursor();
        if (wasStarted && !rendererStopped) this.#terminal.stop();
      }
    }
  }
}

export function assertSafeTuiEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
  const unsafeNames: string[] = TUI_DEBUG_ENVIRONMENT_NAMES.filter(
    (name: string): boolean => environment[name] !== undefined && environment[name] !== "",
  );
  if (unsafeNames.length > 0) {
    throw new Error(`Candy TUI rejects unsafe debug environment: ${unsafeNames.join(", ")}`);
  }
}

export class FakeTerminal implements CandyTuiTerminal {
  public readonly writes: string[] = [];
  public readonly columns: number;
  public readonly rows: number;
  public readonly kittyProtocolActive: boolean = false;
  public started: boolean = false;
  public stopped: boolean = false;
  public cursorHidden: boolean = false;
  public cursorShown: boolean = false;
  public drainCalls: number = 0;
  #inputHandler: ((data: string) => void) | undefined = undefined;
  #resizeHandler: (() => void) | undefined = undefined;

  public constructor(options: { readonly columns?: number; readonly rows?: number } = {}) {
    this.columns = options.columns ?? 80;
    this.rows = options.rows ?? 24;
  }

  public start(onInput: (data: string) => void, onResize: () => void): void {
    this.started = true;
    this.#inputHandler = onInput;
    this.#resizeHandler = onResize;
  }

  public stop(): void {
    this.stopped = true;
    this.#inputHandler = undefined;
    this.#resizeHandler = undefined;
  }

  public drainInput(): Promise<void> {
    this.drainCalls += 1;
    return Promise.resolve();
  }

  public write(data: string): void {
    this.writes.push(data);
  }

  public moveBy(): void {
    return;
  }

  public hideCursor(): void {
    this.cursorHidden = true;
  }

  public showCursor(): void {
    this.cursorShown = true;
  }

  public clearLine(): void {}

  public clearFromCursor(): void {}

  public clearScreen(): void {}

  public setTitle(): void {
    return;
  }

  public setProgress(): void {
    return;
  }

  public emitInput(data: string): void {
    this.#inputHandler?.(data);
  }

  public emitResize(): void {
    this.#resizeHandler?.();
  }
}
