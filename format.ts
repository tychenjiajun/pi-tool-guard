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
