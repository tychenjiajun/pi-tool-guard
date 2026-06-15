import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// bash extractor execution helpers
// ---------------------------------------------------------------------------

export const FAST_THRESHOLD_MS = 10_000;

export type NoticeMode = "fast" | "slow";

export function buildNotice(
  removedPipeline: string,
  originalCommand: string,
  mode: NoticeMode = "slow",
): string {
  const suffix = mode === "fast"
    ? `Filtered via \`${removedPipeline}\` — full output was small enough to pipe.`
    : `The full output is above — do NOT re-run with different parameters.`;
  return `[pi-tool-guard] Removed trailing pipeline commands: \`${removedPipeline}\` from \`${originalCommand}\`. ${suffix}`;
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
    const result = await pi.exec("bash", ["-c", `cat ${JSON.stringify(filePath)} | ${pipeline}`]);
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
    const result = await pi.exec("bash", ["-c", `printf '%s' ${JSON.stringify(text)} | ${pipeline}`]);
    if (result.code === 0) {
      return result.stdout.trimEnd() || undefined;
    }
  } catch {
    // Bail silently
  }
  return undefined;
}
