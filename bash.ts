import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractFullOutputPath } from "./pipeline.ts";

// ---------------------------------------------------------------------------
// bash extractor execution helpers
// ---------------------------------------------------------------------------

export const FAST_THRESHOLD_MS = 10_000;

/** pi renders an empty command result as this literal string. */
export const EMPTY_OUTPUT_PLACEHOLDER = "(no output)";

/** Full-output temp files older than this are swept. */
export const FULL_OUTPUT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Filename prefix for guard-persisted full outputs.
 *
 * It intentionally starts with `pi-bash-` so downstream consumers that only
 * trust pi's own temp artifacts (notably SoL-Pi's evidence-preserving reducer,
 * whose `safePiBashTempPath` requires `/^pi-bash-[^/\\]+\.log$/` directly in
 * the OS temp dir) will read the guard's full log. The `guard-` segment keeps
 * it distinguishable from pi's own files so the guard never sweeps those.
 */
export const FULL_OUTPUT_PREFIX = "pi-bash-guard-";

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
    // The literal `Full output: <path>` form mirrors pi's truncation banner
    // and the error path; downstream reducers (SoL-Pi's EPR) regex-scan for it
    // when `details.fullOutputPath` is unavailable.
    `Full output: ${sourcePath}`,
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
 * Result of running an extractor pipeline. `code` carries the pipeline's real
 * exit code, which is propagated so a non-zero exit matches what pi's native
 * `cmd | extractor` pipeline would have done (no `pipefail`, so the code is the
 * extractor's own).
 */
export interface ExtractorRunResult {
  text: string;
  code: number;
}

/**
 * Run an extractor pipeline on a file (e.g. the full output temp file).
 *
 * Returns `{ text, code }` for ANY exit code from `pi.exec` — callers decide
 * what to do with non-zero codes. Returns `undefined` only when `pi.exec`
 * itself throws.
 */
export async function runExtractorOnFile(
  pi: ExtensionAPI,
  filePath: string,
  pipeline: string,
): Promise<ExtractorRunResult | undefined> {
  try {
    // The path travels as an argv element ($1), never spliced into the script,
    // so spaces/quotes/`$` in it cannot be re-parsed by bash.
    const result = await pi.exec("bash", ["-c", `cat -- "$1" | ${pipeline}`, "bash", filePath]);
    return { text: result.stdout.trimEnd(), code: result.code ?? 0 };
  } catch {
    // Bail silently
    return undefined;
  }
}

/**
 * Run an extractor pipeline on inline text via printf + pipe.
 *
 * Returns `{ text, code }` for ANY exit code from `pi.exec` — callers decide
 * what to do with non-zero codes. Returns `undefined` only when `pi.exec`
 * itself throws.
 */
export async function runExtractorOnText(
  pi: ExtensionAPI,
  text: string,
  pipeline: string,
): Promise<ExtractorRunResult | undefined> {
  try {
    // `text` is passed as $1, not spliced into the script. Splicing
    // `JSON.stringify(text)` let bash collapse real newlines into the two
    // characters `\n` (breaking every line-based extractor) and let `$(...)`
    // / backticks in command output expand.
    const result = await pi.exec("bash", ["-c", `printf '%s' "$1" | ${pipeline}`, "bash", text]);
    return { text: result.stdout.trimEnd(), code: result.code ?? 0 };
  } catch {
    // Bail silently
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// F6: temp-file cleanup
// ---------------------------------------------------------------------------

const FULL_OUTPUT_FILENAME_RE = /^pi-bash-guard-.*\.log$/;

/**
 * Names the guard owns in the OS temp dir: full-output logs
 * (`pi-bash-guard-*.log`) and side-channel sinks (`pi-bash-guard-sink-*.out`).
 * Only the `.log` shape is trusted by downstream reducers; a sink is never
 * evidence and must never be published as a `fullOutputPath`.
 */
const GUARD_TEMP_FILENAME_RE = /^pi-bash-guard-.*\.(?:log|out)$/;

/**
 * Best-effort removal of stale guard temp files. Deletes files in `dir` whose
 * name matches `/^pi-bash-guard-.*\.(?:log|out)$/` and whose `mtimeMs` is older
 * than `maxAgeMs`. Never throws; returns the count of files removed.
 */
export function sweepStaleFullOutputs(
  dir: string = tmpdir(),
  maxAgeMs: number = FULL_OUTPUT_TTL_MS,
  now: number = Date.now(),
): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: false }) as string[];
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!GUARD_TEMP_FILENAME_RE.test(name)) continue;
    const filePath = join(dir, name);
    try {
      const st = statSync(filePath);
      if (now - st.mtimeMs > maxAgeMs) {
        rmSync(filePath);
        removed++;
      }
    } catch {
      // best-effort: skip this entry
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Side-channel sinks (hoisted statements)
// ---------------------------------------------------------------------------

/** Filename prefix for guard side-channel sinks (see `pipeline.ts`). */
export const SIDE_CHANNEL_FILENAME_PREFIX = "pi-bash-guard-sink-";

/**
 * Reserve a side-channel temp path. Returns undefined when the OS temp dir is
 * unusable, in which case hoisting is skipped and the command is passed through
 * untouched.
 */
export function createSideChannelPath(): string | undefined {
  try {
    return join(tmpdir(), `${SIDE_CHANNEL_FILENAME_PREFIX}${randomBytes(8).toString("hex")}.out`);
  } catch {
    return undefined;
  }
}

/**
 * Create/truncate a side-channel file so the shell's `>>` append can never fail
 * on a missing parent directory. Returns false on any filesystem error.
 */
export function resetSideChannel(path: string): boolean {
  try {
    writeFileSync(path, "", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Read a side-channel file; "" when it is missing or unreadable. */
export function readSideChannel(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** Best-effort removal of a side-channel file. */
export function removeSideChannel(path: string): void {
  try {
    rmSync(path);
  } catch {
    // best-effort: a leftover sink is swept by `sweepStaleFullOutputs`
  }
}

/**
 * Re-attach hoisted statements' output around the projection.
 *
 * The projection is `trimEnd`-ed by the extractor helpers, so a plain
 * concatenation could glue the last projected line to the first hoisted line
 * (`foo` + `TSCHECK=0`). A newline is inserted only when the accumulated text
 * does not already end with one, so a well-formed prefix/suffix is untouched.
 * Empty parts are dropped, which is what hides pi's `(no output)` placeholder
 * once a hoisted statement has produced real output.
 */
export function joinOutputStreams(...parts: Array<string | undefined>): string {
  let out = "";
  for (const part of parts) {
    if (!part) continue;
    if (out.length > 0 && !out.endsWith("\n")) out += "\n";
    out += part;
  }
  return out;
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
    sweepStaleFullOutputs();
  } catch {
    // sweepStaleFullOutputs never throws, but be defensive
  }
  try {
    const path = join(tmpdir(), `${FULL_OUTPUT_PREFIX}${randomBytes(8).toString("hex")}.log`);
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
