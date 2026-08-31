import path from "node:path";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  Editor,
  ProcessTerminal,
  ScrollView,
  Spacer,
  TuiAltScreen,
  VStack,
  detectCapabilities,
  isKeyRelease,
  matchesKey,
  setCapabilities,
  truncateToWidth,
  visibleWidth,
  type AutocompleteItem,
  type Component,
  type EditorTheme,
  Key,
} from "@earendil-works/pi-tui";
import { containsCredentialMaterial } from "@candy/platform";
import {
  createCandySlashCommandAutocompleteProvider,
  type CandySkillSlashCommand,
} from "./slash-commands.js";
import { CandyTranscript, type CandyTranscriptKind } from "./transcript.js";
import { launchExternalEditor, normalizeEditorOutput } from "./external-editor.js";

const TUI_DEBUG_ENVIRONMENT_NAMES: readonly string[] = [
  "PI_TUI_WRITE_LOG",
  "PI_TUI_DEBUG",
  "PI_DEBUG_REDRAW",
];

/** Fixed rows above the live transcript. */
const HEADER_ROWS = 2;
const MIN_TRANSCRIPT_ROWS = 8;

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";
const ANSI_ACCENT = "\x1b[38;5;75m";
const ANSI_MINT = "\x1b[38;5;78m";
const ANSI_TEXT = "\x1b[38;5;252m";
const ANSI_SOFT = "\x1b[38;5;117m";
const ANSI_WARNING = "\x1b[38;5;221m";
const ANSI_FULL_ACCESS_BACKGROUND = "\x1b[48;5;130m";
const ANSI_FULL_ACCESS_TEXT = "\x1b[38;5;231m";
const COPY_LAST_ASSISTANT_URL = "candy://copy-last-assistant";
const OPEN_FULL_ACCESS_URL = "candy://open-full-access";
const CONFIRM_FULL_ACCESS_URL = "candy://confirm-full-access";

function tint(value: string, color: string): string {
  return `${color}${value}${ANSI_RESET}`;
}

function bold(value: string): string {
  return `${ANSI_BOLD}${value}${ANSI_RESET}`;
}

function dim(value: string): string {
  return `${ANSI_DIM}${value}${ANSI_RESET}`;
}

function fullAccessBadge(): string {
  return `${ANSI_FULL_ACCESS_BACKGROUND}${ANSI_FULL_ACCESS_TEXT}${ANSI_BOLD} ⚠ FULL ACCESS ${ANSI_RESET}`;
}

/** A TUI-local OSC 8 action handled without invoking an external URL opener. */
function localActionLink(url: string, label: string): string {
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

function truncateMiddle(value: string, maxWidth: number): string {
  if (visibleWidth(value) <= maxWidth) return value;
  if (value.includes("\x1b")) return truncateToWidth(value, maxWidth);
  if (maxWidth <= 1) return "…".slice(0, maxWidth);
  const available = maxWidth - 1;
  const headWidth = Math.ceil(available / 2);
  const tailWidth = Math.floor(available / 2);
  return `${takeVisible(value, headWidth)}…${takeVisible(value, tailWidth, true)}`;
}

function takeVisible(value: string, maxWidth: number, fromEnd: boolean = false): string {
  const characters = [...value];
  const ordered = fromEnd ? characters.reverse() : characters;
  const selected: string[] = [];
  let width = 0;
  for (const character of ordered) {
    const characterWidth = visibleWidth(character);
    if (width + characterWidth > maxWidth) break;
    selected.push(character);
    width += characterWidth;
  }
  return (fromEnd ? selected.reverse() : selected).join("");
}

function composeChromeLine(left: string, right: string, width: number): string {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + rightWidth + 2 > width) {
    if (rightWidth + 2 >= width) return truncateToWidth(right, width);
    const leftBudget = width - rightWidth - 1;
    const clippedLeft = truncateToWidth(left, leftBudget);
    return `${clippedLeft}${" ".repeat(width - visibleWidth(clippedLeft) - rightWidth)}${right}`;
  }
  return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
}

function paddedLine(value: string, width: number): string {
  const clipped = truncateToWidth(value, width);
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function shortModel(value: string): string {
  return value.replace("deepseek-v4-", "DS ").replace("MiniMax-M3", "MiniMax M3");
}

interface CandyChromeOptions {
  readonly workspacePath: (() => string) | undefined;
  readonly model: (() => string) | undefined;
  readonly profile: (() => string) | undefined;
  readonly worktreeEnabled: (() => boolean) | undefined;
  readonly trustedShellEnabled: (() => boolean) | undefined;
  readonly fullAccessEnabled: (() => boolean) | undefined;
  readonly fullAccessAvailable: (() => boolean) | undefined;
  readonly fullAccessConfirmationPending: (() => boolean) | undefined;
  readonly taskId: (() => string | undefined) | undefined;
  readonly taskTitle: (() => string | undefined) | undefined;
  readonly taskPhase: (() => string | undefined) | undefined;
  readonly recoveryTaskCount: (() => number) | undefined;
}

/** Quiet, fixed chrome that keeps the transcript focused on the current turn. */
class CandyChrome implements Component {
  readonly #options: CandyChromeOptions;

  public constructor(options: CandyChromeOptions) {
    this.#options = options;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const workspaceWidth = safeWidth >= 140 ? 48 : safeWidth >= 100 ? 36 : 24;
    const workspace = truncateMiddle(
      this.#options.workspacePath?.() ?? process.cwd(),
      workspaceWidth,
    );
    const model = shortModel(this.#options.model?.() ?? "deepseek-v4-flash");
    const phase = this.#options.taskPhase?.();
    const recoveryTaskCount = this.#options.recoveryTaskCount?.() ?? 0;
    const status = phaseStatus(phase);
    const recovery =
      recoveryTaskCount > 0
        ? ` ${dim("·")} ${tint(`↻ ${recoveryTaskCount} 个可恢复任务 · /tasks`, ANSI_WARNING)}`
        : "";
    const profile = (this.#options.profile?.() ?? "auto") === "auto" ? "Auto" : "Read-only";
    const worktree = this.#options.worktreeEnabled?.() === true ? "安全工作区" : "当前工作区";
    const shell = this.#options.trustedShellEnabled?.() === true ? "本地检查就绪" : "本地检查关闭";
    const fullAccess = this.#options.fullAccessEnabled?.() === true;
    const fullAccessAvailable = this.#options.fullAccessAvailable?.() === true;
    const fullAccessConfirmationPending = this.#options.fullAccessConfirmationPending?.() === true;
    const taskTitle =
      this.#options.taskTitle?.() ??
      (this.#options.taskId?.() === undefined ? "准备新任务" : "未命名任务");
    const title = truncateMiddle(taskTitle, Math.max(16, Math.min(72, safeWidth - 30)));

    return [
      composeChromeLine(
        ` ${tint("●", ANSI_ACCENT)} ${bold("Candy")} ${dim("·")} ${tint(title, ANSI_TEXT)}`,
        status,
        safeWidth,
      ),
      composeChromeLine(
        fullAccess
          ? ` ${fullAccessBadge()} ${dim("·")} ${tint(workspace, ANSI_TEXT)} ${dim("·")} ${tint(profile, ANSI_TEXT)} ${dim("·")} ${tint(`${worktree} · 广域文件与网络 · /access safe`, ANSI_WARNING)}`
          : fullAccessAvailable
            ? ` ${localActionLink(fullAccessConfirmationPending ? CONFIRM_FULL_ACCESS_URL : OPEN_FULL_ACCESS_URL, tint(fullAccessConfirmationPending ? "⚠ 确认开启 Full access" : "⚠ 开启 Full access", ANSI_WARNING))} ${dim("·")} ${tint(workspace, ANSI_TEXT)} ${dim("·")} ${tint(profile, ANSI_TEXT)} ${dim("·")} ${tint(worktree, ANSI_TEXT)} ${dim("·")} ${tint(shell, ANSI_TEXT)}`
            : ` ${tint(workspace, ANSI_TEXT)} ${dim("·")} ${tint(profile, ANSI_TEXT)} ${dim("·")} ${tint(worktree, ANSI_TEXT)} ${dim("·")} ${tint(shell, ANSI_TEXT)}`,
        `${tint(model, ANSI_SOFT)}${recovery}`,
        safeWidth,
      ),
    ];
  }
}

function phaseStatus(phase: string | undefined): string {
  if (phase === undefined) return tint("● 就绪", ANSI_MINT);
  if (phase.includes("approval")) return tint("● 等待确认", ANSI_WARNING);
  if (phase.startsWith("tool "))
    return tint(`● ${truncateMiddle(phase.slice(5), 20)}`, ANSI_ACCENT);
  if (phase.startsWith("provider retry")) return tint("● 正在重试", ANSI_WARNING);
  const labels: Readonly<Record<string, string>> = {
    starting: "准备中",
    "turn running": "正在回答",
    "context compaction": "整理上下文",
    "turn settled": "正在收尾",
    completed: "上轮完成",
    paused: "已暂停",
    interrupted: "待恢复",
    cancelled: "已取消",
  };
  const label = labels[phase] ?? truncateMiddle(phase, 20);
  const color =
    phase === "paused" || phase === "interrupted" || phase === "cancelled"
      ? ANSI_WARNING
      : ANSI_MINT;
  return tint(`● ${label}`, color);
}

class CandyPromptLabel implements Component {
  readonly #taskPhase: (() => string | undefined) | undefined;

  public constructor(taskPhase: (() => string | undefined) | undefined) {
    this.#taskPhase = taskPhase;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    const phase = this.#taskPhase?.();
    const label = phase?.includes("approval")
      ? tint("需要你的确认", ANSI_WARNING)
      : isActivePhase(phase)
        ? "Candy 正在处理"
        : phase === "completed"
          ? "继续任务"
          : "开始任务";
    const hint = phase?.includes("approval")
      ? "· 按上方命令批准、拒绝或取消"
      : isActivePhase(phase)
        ? "· 输入 /steer 补充当前轮"
        : "· 回答、继续，或输入 / 查看命令";
    return [
      paddedLine(` ${tint("›", ANSI_ACCENT)} ${bold(label)} ${dim(hint)}`, Math.max(1, width)),
    ];
  }
}

interface CandyFooterOptions {
  readonly taskPhase: (() => string | undefined) | undefined;
  readonly assistantReplyAvailable: (() => boolean) | undefined;
}

class CandyFooter implements Component {
  readonly #options: CandyFooterOptions;

  public constructor(options: CandyFooterOptions) {
    this.#options = options;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    const phase = this.#options.taskPhase?.();
    const content =
      phase === "completed" && this.#options.assistantReplyAvailable?.() === true
        ? `${localActionLink(COPY_LAST_ASSISTANT_URL, tint("⧉ 复制最后结论", ANSI_SOFT))} ${dim("· Ctrl+X")}`
        : phase?.includes("approval")
          ? "/status 查看详情  ·  按上方命令作出决定"
          : isActivePhase(phase)
            ? "/steer 插入当前轮  ·  直接输入排队下一轮"
            : "/ 查看命令  ·  Enter 发送  ·  Ctrl+V 粘贴图片  ·  Ctrl+G 外部编辑  ·  Ctrl+T 思考";
    return [paddedLine(` ${dim(content)}`, Math.max(1, width))];
  }
}

function isActivePhase(phase: string | undefined): boolean {
  return (
    phase === "starting" ||
    phase === "turn running" ||
    phase === "context compaction" ||
    phase === "turn settled" ||
    phase?.startsWith("tool ") === true ||
    phase?.startsWith("provider retry") === true
  );
}

/**
 * A fixed, bounded list of messages queued for the active turn (follow-up /
 * steer). It sits below the status prompt so queued content stays out of the
 * streaming execution transcript. It renders nothing when the queue is empty.
 */
class QueuedTurnMessages implements Component {
  readonly #messages: () => readonly string[];
  readonly #maxVisible: number;

  public constructor(messages: () => readonly string[], maxVisible: number = 3) {
    this.#messages = messages;
    this.#maxVisible = Math.max(1, maxVisible);
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    const messages = this.#messages();
    if (messages.length === 0) return [];
    const safeWidth = Math.max(1, width);
    const header = ` ${tint("排队", ANSI_ACCENT)} ${dim(`· ${messages.length} 条待处理`)}`;
    const lines: string[] = [paddedLine(header, safeWidth)];
    for (const message of messages.slice(-this.#maxVisible)) {
      lines.push(paddedLine(truncateMiddle(tint(message, ANSI_SOFT), safeWidth), safeWidth));
    }
    if (messages.length > this.#maxVisible) {
      const remaining = messages.length - this.#maxVisible;
      lines.push(paddedLine(dim(`  … 还有 ${remaining} 条`), safeWidth));
    }
    return lines;
  }
}

const EDITOR_THEME: EditorTheme = {
  borderColor: dim,
  selectList: {
    selectedPrefix: (value: string): string => tint(value, ANSI_ACCENT),
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: (value: string): string => tint(value, ANSI_WARNING),
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
  readonly model?: () => string;
  readonly profile?: () => string;
  readonly worktreeEnabled?: () => boolean;
  readonly trustedShellEnabled?: () => boolean;
  /** Persistent platform Full Access mode; always rendered as a warning badge. */
  readonly fullAccessEnabled?: () => boolean;
  /** Whether this installation can show the platform Full Access entry point. */
  readonly fullAccessAvailable?: () => boolean;
  /** The user has viewed the warning and may now explicitly confirm Full access. */
  readonly fullAccessConfirmationPending?: () => boolean;
  readonly taskId?: () => string | undefined;
  readonly taskTitle?: () => string | undefined;
  readonly taskPhase?: () => string | undefined;
  /** Whether the final assistant reply is available to copy. */
  readonly assistantReplyAvailable?: () => boolean;
  readonly recoveryTaskCount?: () => number;
  readonly skills?: readonly CandySkillSlashCommand[];
  /** Model autocomplete entries (built-in plus user-configured). */
  readonly modelChoices?: readonly AutocompleteItem[];
  /** Messages queued for the active turn (follow-up / steer), shown in a fixed area. */
  readonly queuedTurnMessages?: () => readonly string[];
  readonly terminal?: CandyTuiTerminal | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly onSubmit: (text: string) => void;
  readonly onInterrupt: () => void;
  /** Copy the last assistant reply; the surface owns the transcript text. */
  readonly onCopyLastAssistant?: () => void;
  /** Reveal the warning before a user may explicitly confirm Full access. */
  readonly onOpenFullAccess?: () => void;
  /** Explicitly confirm Full access after its warning has been revealed. */
  readonly onConfirmFullAccess?: () => void;
  /** Paste a raster image from the system clipboard after an explicit Ctrl+V gesture. */
  readonly onPasteImage?: () => void;
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
  readonly #onOpenFullAccess: (() => void) | undefined;
  readonly #onConfirmFullAccess: (() => void) | undefined;
  readonly #onPasteImage: (() => void) | undefined;
  readonly #onCycleModel: ((direction: 1 | -1) => void) | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #removeInterruptListener: () => void;
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
    this.#onOpenFullAccess = options.onOpenFullAccess;
    this.#onConfirmFullAccess = options.onConfirmFullAccess;
    this.#onPasteImage = options.onPasteImage;
    this.#onCycleModel = options.onCycleModel;
    this.#environment = options.environment ?? process.env;
    this.#appDataRoot = path.resolve(options.appDataRoot);
    this.#launchExternalEditor =
      options.launchExternalEditor ??
      ((target: string): Promise<number> => launchExternalEditor(target));
    this.logDirectory = path.join(this.#appDataRoot, "logs");
    this.#tui = new TuiAltScreen(this.#terminal, true, this.logDirectory, {
      openUrl: (url: string): void => {
        if (url === COPY_LAST_ASSISTANT_URL) this.#onCopyLastAssistant?.();
        if (url === OPEN_FULL_ACCESS_URL) this.#onOpenFullAccess?.();
        if (url === CONFIRM_FULL_ACCESS_URL) this.#onConfirmFullAccess?.();
      },
    });
    this.#transcript = new CandyTranscript();
    this.#editor = new Editor(this.#tui, EDITOR_THEME, { paddingX: 1 });
    this.#editor.setAutocompleteProvider(
      createCandySlashCommandAutocompleteProvider(
        options.workspacePath ?? (() => process.cwd()),
        options.skills,
        options.modelChoices,
        options.model ?? (() => undefined),
      ),
    );
    this.#editor.onSubmit = (text: string): void => {
      const submittedText: string = text.trim();
      this.#editor.setText("");
      if (submittedText.length > 0) this.#onSubmit(submittedText);
    };
    const chrome = new CandyChrome({
      workspacePath: options.workspacePath,
      model: options.model,
      profile: options.profile,
      worktreeEnabled: options.worktreeEnabled,
      trustedShellEnabled: options.trustedShellEnabled,
      fullAccessEnabled: options.fullAccessEnabled,
      fullAccessAvailable: options.fullAccessAvailable,
      fullAccessConfirmationPending: options.fullAccessConfirmationPending,
      taskId: options.taskId,
      taskTitle: options.taskTitle,
      taskPhase: options.taskPhase,
      recoveryTaskCount: options.recoveryTaskCount,
    });
    const transcriptViewport = new ScrollView(this.#transcript, {
      follow: "end",
      primary: true,
      overscroll: "contain",
      scrollbar: "auto",
    });
    this.#tui.setLayoutRoot(
      new VStack([
        { component: chrome, basis: HEADER_ROWS, shrink: 0 },
        {
          component: transcriptViewport,
          basis: MIN_TRANSCRIPT_ROWS,
          grow: 1,
          shrink: 1,
          minSize: MIN_TRANSCRIPT_ROWS,
        },
        { component: new Spacer(1), basis: 1, shrink: 0 },
        { component: new CandyPromptLabel(options.taskPhase), basis: 1, shrink: 0 },
        {
          component: new QueuedTurnMessages(options.queuedTurnMessages ?? (() => [])),
          basis: "auto",
          shrink: 0,
        },
        { component: this.#editor, basis: "auto", shrink: 0 },
        {
          component: new CandyFooter({
            taskPhase: options.taskPhase,
            assistantReplyAvailable: options.assistantReplyAvailable,
          }),
          basis: 1,
          shrink: 0,
        },
      ]),
    );
    this.#tui.setFocus(this.#editor);
    this.#removeInterruptListener = this.#tui.addInputListener(
      (data: string): { consume: boolean } | undefined => {
        if (!matchesKey(data, "ctrl+c")) return undefined;
        this.#onInterrupt();
        return { consume: true };
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
        if (matchesKey(data, Key.ctrl("v")) && this.#onPasteImage !== undefined) {
          this.#onPasteImage();
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

  /** Render an explicitly attached image inline, with a terminal-safe fallback. */
  public appendImageAttachment(mimeType: string, content: Uint8Array): void {
    this.#transcript.appendImage(mimeType, content);
    this.#tui.requestRender();
  }

  /** Re-render the fixed queued-turn-message area after its source list changes. */
  public refreshQueuedTurnMessages(): void {
    this.#tui.requestRender();
  }

  public upsertToolActivity(key: string, value: string): void {
    this.#transcript.upsertTool(key, value);
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
    this.#restoreInlineImageCapability();
    this.#tui.requestRender();
  }

  public start(): void {
    assertSafeTuiEnvironment(this.#environment);
    this.#started = true;
    this.#tui.start();
    this.#restoreInlineImageCapability();
  }

  /**
   * Pi TUI conservatively suppresses iTerm2 images while entering the
   * alternate screen. Candy's transcript owns its viewport and image rows, so
   * restore only a positively detected native iTerm2 capability afterwards.
   * Multiplexed and unknown terminals remain on Pi's text fallback.
   */
  #restoreInlineImageCapability(): void {
    const capabilities = detectCapabilities();
    if (capabilities.images === "iterm2") setCapabilities(capabilities);
  }

  public async stop(): Promise<void> {
    const wasStarted: boolean = this.#started;
    this.#started = false;
    this.#removeInterruptListener();
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
