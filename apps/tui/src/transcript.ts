import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";

/**
 * Live transcript rendering for the Candy TUI.
 *
 * The transcript mixes distinct presentation kinds:
 * - assistant text (streamed model output) rendered as markdown;
 * - user turns with a quiet accent role label;
 * - thinking text (streamed model reasoning) rendered dim, collapsed by
 *   default and toggleable with Ctrl+T;
 * - live tool activity updated in place;
 * - approval decisions with a warning hierarchy; and
 * - plain evidence lines (status and diffs) rendered literally so markdown
 *   syntax inside them is never interpreted.
 *
 * Rendering is bounded to a rolling live window so long sessions keep a
 * bounded render cost; the full saved transcript remains available through
 * /transcript. The owning Pi ScrollView supplies the viewport, mouse-wheel
 * handling, PageUp/PageDown navigation, follow-tail behavior, and scrollbar.
 */

export type CandyTranscriptKind = "assistant" | "thinking" | "user" | "tool" | "approval" | "plain";

/** Bound on live transcript bytes kept for rendering and scrollback. */
const MAX_LIVE_TRANSCRIPT_BYTES = 192 * 1024;
/** Bound on one coalesced segment before a new segment starts. */
const MAX_SEGMENT_BYTES = 64 * 1024;
/** Horizontal padding matching the plain Text widget this replaces. */
const CONTENT_PADDING_X = 1;

const BOLD = (value: string): string => `\x1b[1m${value}\x1b[0m`;
const DIM = (value: string): string => `\x1b[2m${value}\x1b[0m`;
const ACCENT = (value: string): string => `\x1b[38;5;75m${value}\x1b[0m`;
const USER_ACCENT = (value: string): string => `\x1b[38;5;141m${value}\x1b[0m`;
const MINT = (value: string): string => `\x1b[38;5;78m${value}\x1b[0m`;
const WARNING = (value: string): string => `\x1b[38;5;221m${value}\x1b[0m`;
const ERROR = (value: string): string => `\x1b[38;5;203m${value}\x1b[0m`;
const PASSTHROUGH = (value: string): string => value;

/** Monochrome markdown theme that stays within the Candy TUI aesthetic. */
const CANDY_TRANSCRIPT_THEME: MarkdownTheme = {
  heading: BOLD,
  link: DIM,
  linkUrl: DIM,
  code: PASSTHROUGH,
  codeBlock: PASSTHROUGH,
  codeBlockBorder: DIM,
  quote: DIM,
  quoteBorder: DIM,
  hr: DIM,
  listBullet: PASSTHROUGH,
  bold: BOLD,
  italic: PASSTHROUGH,
  strikethrough: PASSTHROUGH,
  underline: PASSTHROUGH,
};

interface CandyTranscriptSegment {
  readonly kind: CandyTranscriptKind;
  text: string;
  readonly key: string | undefined;
  /**
   * Markdown renderer for assistant segments. Thinking and plain segments
   * render literally without a renderer so tool/status/evidence lines never
   * have their markdown-significant characters interpreted.
   */
  readonly markdown: Markdown | undefined;
}

const THINKING_COLLAPSED_HINT = "▸ 思考过程 · Ctrl+T 展开";
const THINKING_EXPANDED_HINT = "▾ 思考过程 · Ctrl+T 折叠";

export class CandyTranscript implements Component {
  #segments: CandyTranscriptSegment[] = [];
  /** Thinking blocks are collapsed by default; Ctrl+T toggles. */
  #thinkingVisible = false;

  /** Toggle the visibility of collapsed thinking blocks (Ctrl+T). */
  public toggleThinking(): void {
    this.#thinkingVisible = !this.#thinkingVisible;
  }

  public get thinkingVisible(): boolean {
    return this.#thinkingVisible;
  }

  public append(value: string, kind: CandyTranscriptKind = "plain"): void {
    if (value.length === 0) return;
    const last = this.#segments[this.#segments.length - 1];
    if (
      last !== undefined &&
      last.kind === kind &&
      kind !== "user" &&
      kind !== "tool" &&
      kind !== "approval" &&
      last.text.length < MAX_SEGMENT_BYTES
    ) {
      last.text += value;
      last.markdown?.setText(last.text);
    } else {
      this.#segments.push({
        kind,
        text: value,
        key: undefined,
        markdown:
          kind === "assistant"
            ? new Markdown(value, CONTENT_PADDING_X, 0, CANDY_TRANSCRIPT_THEME)
            : undefined,
      });
    }
    this.#dropOldest();
  }

  /** Keep one live row per tool call while preserving the final bounded evidence row. */
  public upsertTool(key: string, value: string): void {
    if (value.length === 0) return;
    const existing = this.#segments.findLast(
      (segment) => segment.kind === "tool" && segment.key === key,
    );
    if (existing !== undefined) {
      existing.text = value;
    } else {
      this.#segments.push({ kind: "tool", text: value, key, markdown: undefined });
    }
    this.#dropOldest();
  }

  public invalidate(): void {
    for (const segment of this.#segments) segment.markdown?.invalidate();
  }

  public render(width: number): string[] {
    const lines: string[] = [];
    for (const segment of this.#segments) {
      if (segment.kind === "assistant") {
        const markdown = segment.markdown;
        if (markdown !== undefined) {
          appendBlockSeparator(lines, width);
          lines.push(roleLabel("Candy", width, "assistant"));
          lines.push(...markdown.render(width));
        }
      } else if (segment.kind === "user") {
        appendBlockSeparator(lines, width);
        lines.push(roleLabel("用户", width, "user"));
        lines.push(...wrapReadableLines(segment.text, width));
      } else if (segment.kind === "thinking") {
        lines.push(...renderThinkingLines(segment.text, width, this.#thinkingVisible));
      } else if (segment.kind === "tool") {
        lines.push(...renderToolLines(segment.text, width));
      } else if (segment.kind === "approval") {
        appendBlockSeparator(lines, width);
        lines.push(...renderApprovalLines(segment.text, width));
      } else {
        lines.push(...wrapPlainLines(segment.text, width));
      }
    }
    return lines;
  }

  /** Drop oldest segments until the live window fits the byte bound. */
  #dropOldest(): void {
    let bytes = this.#segments.reduce((total, segment) => total + segment.text.length, 0);
    while (this.#segments.length > 1 && bytes > MAX_LIVE_TRANSCRIPT_BYTES) {
      const dropped = this.#segments.shift();
      if (dropped !== undefined) bytes -= dropped.text.length;
    }
  }
}

/** Wrap plain text to the content width and pad it to the full width. */
function wrapPlainLines(text: string, width: number): string[] {
  const contentWidth = Math.max(1, width - CONTENT_PADDING_X * 2);
  const margin = " ".repeat(CONTENT_PADDING_X);
  return wrapTextWithAnsi(text, contentWidth).map((line) => {
    const padding = Math.max(0, width - CONTENT_PADDING_X - visibleWidth(line));
    return margin + line + " ".repeat(padding);
  });
}

/**
 * Render a thinking segment: a dim marker line plus dim indented content
 * when expanded, or a single collapsed marker line by default.
 */
function renderThinkingLines(text: string, width: number, visible: boolean): string[] {
  const marker = visible ? THINKING_EXPANDED_HINT : THINKING_COLLAPSED_HINT;
  const lines: string[] = [dimLine(marker, width)];
  if (!visible) return lines;
  const contentWidth = Math.max(1, width - CONTENT_PADDING_X * 2);
  const margin = " ".repeat(CONTENT_PADDING_X + 2);
  for (const line of wrapTextWithAnsi(text, contentWidth - 2)) {
    const styled = DIM(line);
    const padding = Math.max(0, width - CONTENT_PADDING_X - 2 - visibleWidth(styled));
    lines.push(margin + styled + " ".repeat(padding));
  }
  return lines;
}

/** Dim a full-width padded line (marker lines are padded by the caller). */
function dimLine(value: string, width: number): string {
  return truncateToWidth(" ".repeat(CONTENT_PADDING_X) + DIM(value), width);
}

function appendBlockSeparator(lines: string[], width: number): void {
  if (lines.length > 0) lines.push(" ".repeat(width));
}

function roleLabel(value: string, width: number, role: "assistant" | "user"): string {
  const styled = role === "assistant" ? BOLD(ACCENT(value)) : BOLD(USER_ACCENT(value));
  return truncateToWidth(` ${styled}`, width);
}

function wrapReadableLines(text: string, width: number): string[] {
  const contentWidth = Math.max(1, width - CONTENT_PADDING_X * 2);
  const margin = " ".repeat(CONTENT_PADDING_X);
  return wrapTextWithAnsi(text, contentWidth).map((line) =>
    truncateToWidth(`${margin}${line}`, width),
  );
}

function renderToolLines(text: string, width: number): string[] {
  const contentWidth = Math.max(1, width - CONTENT_PADDING_X * 2);
  const match = text.match(/^([✓✗◇…])\s*(.*)$/su);
  const icon = match?.[1];
  const body = match?.[2] ?? text;
  const styledIcon =
    icon === "✓"
      ? MINT(icon)
      : icon === "✗"
        ? ERROR(icon)
        : icon === undefined
          ? DIM("·")
          : ACCENT(icon);
  const prefix = ` ${styledIcon} `;
  const prefixWidth = visibleWidth(prefix);
  return wrapTextWithAnsi(DIM(body), Math.max(1, contentWidth - prefixWidth)).map((line, index) =>
    truncateToWidth(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`, width),
  );
}

function renderApprovalLines(text: string, width: number): string[] {
  const contentWidth = Math.max(1, width - CONTENT_PADDING_X * 2);
  const lines: string[] = [];
  for (const sourceLine of text.split("\n")) {
    const value = sourceLine.trimEnd();
    if (value.length === 0) {
      lines.push(" ".repeat(width));
      continue;
    }
    const trimmed = value.trimStart();
    const styled = trimmed.startsWith("!")
      ? BOLD(WARNING(value))
      : trimmed.startsWith("/")
        ? ACCENT(value)
        : value;
    lines.push(
      ...wrapTextWithAnsi(styled, contentWidth).map((line) =>
        truncateToWidth(`${" ".repeat(CONTENT_PADDING_X)}${line}`, width),
      ),
    );
  }
  return lines;
}
