import path from "node:path";
import { appendFileSync } from "node:fs";
import {
  Editor,
  ProcessTerminal,
  Spacer,
  Text,
  TuiAltScreen,
  matchesKey,
  type EditorTheme,
} from "@earendil-works/pi-tui";
import { containsCredentialMaterial } from "@candy/platform";

const TUI_DEBUG_ENVIRONMENT_NAMES: readonly string[] = [
  "PI_TUI_WRITE_LOG",
  "PI_TUI_DEBUG",
  "PI_DEBUG_REDRAW",
];

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
  readonly terminal?: CandyTuiTerminal | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly onSubmit: (text: string) => void;
  readonly onInterrupt: () => void;
}

export class CandyTuiSurface {
  readonly #terminal: CandyTuiTerminal;
  readonly #tui: TuiAltScreen;
  readonly #transcript: Text;
  readonly #editor: Editor;
  readonly #onSubmit: (text: string) => void;
  readonly #onInterrupt: () => void;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #removeInterruptListener: () => void;
  readonly #removeInputLogListener: (() => void) | undefined;
  public readonly logDirectory: string;
  #transcriptText: string = "";
  #started: boolean = false;

  public constructor(options: CandyTuiSurfaceOptions) {
    this.#terminal = options.terminal ?? new ProcessTerminal();
    this.#onSubmit = options.onSubmit;
    this.#onInterrupt = options.onInterrupt;
    this.#environment = options.environment ?? process.env;
    this.logDirectory = path.join(path.resolve(options.appDataRoot), "logs");
    this.#tui = new TuiAltScreen(this.#terminal, true, this.logDirectory);
    this.#transcript = new Text();
    this.#editor = new Editor(this.#tui, EDITOR_THEME, { paddingX: 1 });
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

  public appendTranscript(value: string): void {
    this.#transcriptText += value;
    this.#transcript.setText(this.#transcriptText);
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
  public readonly columns: number = 80;
  public readonly rows: number = 24;
  public readonly kittyProtocolActive: boolean = false;
  public started: boolean = false;
  public stopped: boolean = false;
  public cursorHidden: boolean = false;
  public cursorShown: boolean = false;
  public drainCalls: number = 0;
  #inputHandler: ((data: string) => void) | undefined = undefined;
  #resizeHandler: (() => void) | undefined = undefined;

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
