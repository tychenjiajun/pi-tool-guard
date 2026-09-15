import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractFullOutputPath } from "./pipeline.ts";

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
 * LLM-facing notice for a slow command. The full, unextracted output was
 * persisted to a file, so the agent should read that file later instead of
 * re-running the expensive command. The path is inlined (rather than left in
 * `details`) so the agent can act on it without extra digging.
 */
export function buildSlowReadbackNotice(originalCommand: string, sourcePath?: string): string {
  const header = `⏳ This was a slow command (\`${originalCommand}\` took ≥ ${FAST_THRESHOLD_MS / 1000}s). Avoid re-running it.`;
  if (!sourcePath) {
    return `${header} The full output is shown above; read it rather than re-running.`;
  }
  return [
    header,
    `The full, unextracted output was saved to: ${sourcePath}`,
    `To see more later, read that file on demand — e.g. the \`read\` tool with offset/limit, or \`sed -n 'START,ENDp' "${sourcePath}"\` — instead of re-running the command.`,
  ].join("\n");
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
 *
 * F2: accepts exit code 0 AND 1 (grep exits 1 on no match) and allows empty
 * stdout. Returns the filtered text (possibly ""), or undefined on exception
 * or exit code >= 2.
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
    if (result.code === 0 || result.code === 1) {
      return result.stdout.trimEnd();
    }
  } catch {
    // Bail silently
  }
  return undefined;
}

/**
 * Run an extractor pipeline on inline text via printf + pipe.
 *
 * F2: accepts exit code 0 AND 1 (grep exits 1 on no match) and allows empty
 * stdout. Returns the filtered text (possibly ""), or undefined on exception
 * or exit code >= 2.
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
    if (result.code === 0 || result.code === 1) {
      return result.stdout.trimEnd();
    }
  } catch {
    // Bail silently
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// F4: slow-command full-output persistence
// ---------------------------------------------------------------------------

/**
 * Persist the full text of a slow command to a fresh temp file and return its
 * path. Returns undefined on any filesystem error so callers can fall back to
 * inline handling.
 */
export function persistFullOutput(text: string): string | undefined {
  try {
    const path = join(tmpdir(), `pi-tool-guard-${randomBytes(8).toString("hex")}.log`);
    writeFileSync(path, text, "utf-8");
    return path;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// F1: structured bash error parsing
// ---------------------------------------------------------------------------

export interface ParsedBashError {
  text: string;
  fullOutputPath?: string;
  exitCode?: number;
}

const BANNER_RE = /\n*\[Showing (?:last|lines)[^\]]*Full output:[^\]]*\]\s*$/m;
const EXIT_CODE_RE = /\n*Command exited with code (\d+)\s*$/;

/**
 * Parse a bash error message produced by pi's bash tool. Extracts the exit
 * code, the full-output path (if the output was truncated), and strips the
 * truncation banner from the text. Returns the raw text with no exitCode when
 * the message does not match the expected "Command exited with code N" shape
 * (e.g. abort/timeout) — callers should rethrow unchanged in that case.
 */
export function parseBashError(err: unknown): ParsedBashError {
  const raw = err instanceof Error ? err.message : String(err);
  const match = raw.match(EXIT_CODE_RE);
  if (!match) return { text: raw };

  const exitCode = Number(match[1]);
  let text = raw.slice(0, match.index).trimEnd();
  const fullOutputPath = extractFullOutputPath(text);
  text = text.replace(BANNER_RE, "").trimEnd();
  return {
    text,
    ...(fullOutputPath ? { fullOutputPath } : {}),
    exitCode,
  };
}
