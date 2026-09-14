import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// bash extractor execution helpers
// ---------------------------------------------------------------------------

export const FAST_THRESHOLD_MS = 10_000;

export type NoticeMode = "fast" | "fast-file" | "slow";

export function buildNotice(
  removedPipeline: string,
  originalCommand: string,
  mode: NoticeMode = "slow",
): string {
  let suffix: string;
  switch (mode) {
    case "fast":
      suffix = `Filtered via \`${removedPipeline}\` — full output was small enough to pipe.`;
      break;
    case "fast-file":
      suffix = `Filtered via \`${removedPipeline}\` — the large output was piped through from its saved temp file.`;
      break;
    default:
      suffix = `The full output is above — do NOT re-run with different parameters.`;
  }
  return `🛡 pi-tool-guard · bash filter\nRemoved trailing pipeline commands: \`${removedPipeline}\` from \`${originalCommand}\`. ${suffix}`;
}

/**
 * True when applying the extractor changed nothing: the projection is
 * byte-identical (ignoring trailing whitespace) to the cleaned command's own
 * output. The guard is then a no-op, so its UI notice would be pure noise.
 */
export function isProjectionNoop(projected: string, original: string): boolean {
  return projected.trimEnd() === original.trimEnd();
}

/**
 * Run an extractor pipeline on a file (e.g. the full output temp file).
 * Returns the filtered text, or undefined on failure.
 */
export async function runExtractorOnFile(
  pi: ExtensionAPI,
  filePath: string,
  pipeline: string,
): Promise<string | undefined> {
  try {
    // The path travels as an argv element ($1), never spliced into the script,
    // so spaces/quotes/`$` in it cannot be re-parsed by bash.
    const result = await pi.exec("bash", ["-c", `cat -- "$1" | ${pipeline}`, "bash", filePath]);
    if (result.code === 0 && result.stdout.trim()) {
      return result.stdout.trimEnd();
    }
  } catch {
    // Bail silently
  }
  return undefined;
}

/**
 * Run an extractor pipeline on inline text via printf + pipe.
 * Returns the filtered text, or undefined on failure.
 */
export async function runExtractorOnText(
  pi: ExtensionAPI,
  text: string,
  pipeline: string,
): Promise<string | undefined> {
  try {
    // `text` is passed as $1, not spliced into the script. Splicing
    // `JSON.stringify(text)` let bash collapse real newlines into the two
    // characters `\n` (breaking every line-based extractor) and let `$(...)`
    // / backticks in command output expand.
    const result = await pi.exec("bash", ["-c", `printf '%s' "$1" | ${pipeline}`, "bash", text]);
    if (result.code === 0) {
      return result.stdout.trimEnd() || undefined;
    }
  } catch {
    // Bail silently
  }
  return undefined;
}
