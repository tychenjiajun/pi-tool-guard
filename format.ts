import { DEFAULT_MAX_BYTES, formatSize, truncateTail } from "@earendil-works/pi-coding-agent";
import type { PiToolGuardProjection } from "./contract.ts";

// ---------------------------------------------------------------------------
// Pure formatting + measurement helpers for the guard UI
// ---------------------------------------------------------------------------

const INTEGER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const encoder = new TextEncoder();

export interface TextSize {
  /** Number of logical lines (a trailing newline does not add an empty line). */
  lines: number;
  /** UTF-8 byte length. */
  bytes: number;
}

/** Measure text the way the model pays for it: lines and UTF-8 bytes. */
export function measureText(text: string): TextSize {
  const trimmed = text.replace(/\n$/, "");
  return {
    lines: trimmed.length === 0 ? 0 : trimmed.split("\n").length,
    bytes: encoder.encode(text).length,
  };
}

export function formatCount(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return INTEGER_FORMAT.format(safe);
}

/** Compact human byte size, e.g. `12.1 KiB`. */
export function formatBytes(value: number): string {
  const bytes = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  if (bytes >= 1024 * 1024) return `${compact(bytes / (1024 * 1024))} MiB`;
  if (bytes >= 1024) return `${compact(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

/**
 * One-line summary of what the projection removed, e.g.
 * `1,234 → 20 lines · 98% smaller · 12.1 KiB saved`.
 */
export function formatProjectionSavings(projection: PiToolGuardProjection): string {
  const lineDrop = Math.max(0, projection.inputLines - projection.outputLines);
  const byteDrop = Math.max(0, projection.inputBytes - projection.outputBytes);
  const percent =
    projection.inputLines > 0
      ? Math.round((lineDrop / projection.inputLines) * 100)
      : 0;

  const parts = [
    `${formatCount(projection.inputLines)} → ${formatCount(projection.outputLines)} lines`,
  ];
  if (percent > 0) parts.push(`${percent}% smaller`);
  if (byteDrop > 0) parts.push(`${formatBytes(byteDrop)} saved`);
  return parts.join(" · ");
}

function compact(value: number): string {
  return value.toFixed(1).replace(/\.0$/u, "");
}

export interface CappedText {
  /** The capped text WITHOUT the truncation banner. */
  text: string;
  /**
   * Pi's own `[Showing … Full output: <path>]` banner, empty when the text
   * was not capped or when no `fullOutputPath` was supplied.
   */
  banner: string;
  /** Whether the cap actually trimmed the text. */
  capped: boolean;
}

/**
 * Cap a guard-composed text to pi's model-facing bash limits (2000 lines /
 * 50KB, tail kept), re-using pi's own `truncateTail` so the result matches
 * what pi's native executor would have shown for the same output.
 *
 * The projection re-runs against the *full* persisted output, and `head` /
 * `tail` are line-based: `head -60` over 30 matches of a minified HTML file
 * returned all 4.3MB unchanged in production sessions — every line kept, and
 * pi's own 50KB cap bypassed entirely. Re-applying the cap makes a projected
 * result never larger than the native `cmd | extractor` pipeline's result.
 *
 * When capped, a `[Showing … Full output: <path>]` banner (pi's own wording)
 * keeps the readback pointer reachable for `extractFullOutputPath`. Pass
 * `fullOutputPath: undefined` when a notice or `[Command exited …]` bracket
 * that follows the text already carries the path.
 */
export function capModelOutput(text: string, fullOutputPath?: string): CappedText {
  const truncation = truncateTail(text);
  if (!truncation.truncated) return { text, banner: "", capped: false };
  if (!fullOutputPath) return { text: truncation.content, banner: "", capped: true };

  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  let banner: string;
  if (truncation.lastLinePartial) {
    const lines = text.split("\n");
    const lineBytes = encoder.encode(lines[endLine - 1] ?? "").length;
    banner = `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${formatSize(lineBytes)}). Full output: ${fullOutputPath}]`;
  } else if (truncation.truncatedBy === "lines") {
    banner = `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
  } else {
    banner = `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
  }
  return { text: truncation.content, banner, capped: true };
}
