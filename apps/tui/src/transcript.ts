import {
  Markdown,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";

/**
 * Live transcript rendering for the Candy TUI.
 *
 * The transcript mixes two kinds of content:
 * - assistant text (streamed model output) rendered as markdown;
 * - plain evidence lines (status, tool activity, diffs, approval frames)
 *   rendered literally so markdown syntax inside them is never interpreted.
 *
 * Rendering is bounded to a rolling tail window so long sessions keep a
 * bounded render cost; the full saved transcript remains available through
 * /transcript. The component renders a viewport-sized window ending at the
 * live tail, and PageUp/PageDown scroll the window while it is not at the
 * tail. When the user has left the tail, a hint line shows how to return.
 */

export type CandyTranscriptKind = "assistant" | "plain";

/** Bound on live transcript bytes kept for rendering and scrollback. */
const MAX_LIVE_TRANSCRIPT_BYTES = 192 * 1024;
/** Bound on one coalesced segment before a new segment starts. */
const MAX_SEGMENT_BYTES = 64 * 1024;
/** Horizontal padding matching the plain Text widget this replaces. */
const CONTENT_PADDING_X = 1;

const BOLD = (value: string): string => `\x1b[1m${value}\x1b[0m`;
const DIM = (value: string): string => `\x1b[2m${value}\x1b[0m`;
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
  /**
   * Markdown renderer for assistant segments. Plain segments render
   * literally without a renderer so tool/status/evidence lines never have
   * their markdown-significant characters interpreted.
   */
  readonly markdown: Markdown | undefined;
}

const SCROLLED_HINT = "[↑ 回看历史 · PageUp/PageDown 翻页 · 翻到底部回到最新]";
const SCROLLED_STALE_HINT = "[↓ 有新内容 · PageUp/PageDown 翻页 · 翻到底部回到最新]";

export class CandyTranscript implements Component {
  readonly #viewportRows: () => number;
  #segments: CandyTranscriptSegment[] = [];
  /** Lines from the tail; 0 means pinned to the live tail. */
  #scrollOffset = 0;
  /** True when content arrived while the user was scrolled away from the tail. */
  #stale = false;
  /** Total wrapped line count of the last render. */
  #wrappedLineCount = 0;

  public constructor(viewportRows: () => number) {
    this.#viewportRows = viewportRows;
  }

  /** True when the rendered content exceeds the viewport window. */
  public get overflowing(): boolean {
    return this.#wrappedLineCount > Math.max(1, this.#viewportRows());
  }

  /** True when the viewport is pinned to the live tail. */
  public get atTail(): boolean {
    return this.#scrollOffset === 0;
  }

  public append(value: string, kind: CandyTranscriptKind = "plain"): void {
    if (value.length === 0) return;
    const last = this.#segments[this.#segments.length - 1];
    if (last !== undefined && last.kind === kind && last.text.length < MAX_SEGMENT_BYTES) {
      last.text += value;
      last.markdown?.setText(last.text);
    } else {
      this.#segments.push({
        kind,
        text: value,
        markdown:
          kind === "assistant"
            ? new Markdown(value, CONTENT_PADDING_X, 0, CANDY_TRANSCRIPT_THEME)
            : undefined,
      });
    }
    this.#dropOldest();
    if (this.#scrollOffset > 0) this.#stale = true;
  }

  /** Scroll by a signed number of lines; positive moves toward older content. */
  public scrollBy(delta: number): void {
    // Clamping to the real content extent happens in render(), where the
    // wrapped line count is known; the offset may be stale between renders.
    this.#scrollOffset = Math.max(0, this.#scrollOffset + delta);
    if (this.#scrollOffset === 0) this.#stale = false;
  }

  public pageUp(): void {
    this.scrollBy(Math.max(1, this.#viewportRows()));
  }

  public pageDown(): void {
    this.scrollBy(-Math.max(1, this.#viewportRows()));
  }

  public scrollToTail(): void {
    this.#scrollOffset = 0;
    this.#stale = false;
  }

  public invalidate(): void {
    for (const segment of this.#segments) segment.markdown?.invalidate();
  }

  public render(width: number): string[] {
    const lines: string[] = [];
    for (const segment of this.#segments) {
      if (segment.markdown === undefined) {
        lines.push(...wrapPlainLines(segment.text, width));
      } else {
        lines.push(...segment.markdown.render(width));
      }
    }
    this.#wrappedLineCount = lines.length;
    const viewport = Math.max(1, this.#viewportRows());
    const maxOffset = Math.max(0, lines.length - viewport);
    if (this.#scrollOffset > maxOffset) this.#scrollOffset = maxOffset;
    if (this.#scrollOffset === 0) {
      this.#stale = false;
      return lines.length <= viewport ? lines : lines.slice(lines.length - viewport);
    }
    const end = lines.length - this.#scrollOffset;
    const start = Math.max(0, end - viewport);
    return [this.#stale ? SCROLLED_STALE_HINT : SCROLLED_HINT, ...lines.slice(start, end)];
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
    return `${margin}${line}${" ".repeat(padding)}`;
  });
}
