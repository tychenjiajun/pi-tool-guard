// ---------------------------------------------------------------------------
// In-process view application
// ---------------------------------------------------------------------------
//
// The guard's projection runs through `pi.exec` (`bash -c 'cat -- "$1" | …'`).
// That is the only faithful way to apply an arbitrary removed pipeline
// (`grep -E … | head`), but `head -N` and `tail -N` are overwhelmingly the
// common case (615 of 673 real notices) and need no shell at all. Doing those
// in-process avoids two process spawns per projected command and removes the
// only place where the projection touches a shell.
//
// `applySimpleView` is deliberately narrow: it matches a *single* plain
// `head`/`tail` invocation — no follow flag, no `+N`/`-z`/`-q`, no other
// command, no redirection. Anything else returns `undefined` and the caller
// falls back to `pi.exec`, so behaviour for every other pipeline is unchanged.

/** A parsed `head`/`tail` invocation that can be applied in-process. */
interface SimpleView {
  readonly command: "head" | "tail";
  readonly mode: "lines" | "bytes";
  readonly count: number;
}

/** `head`/`tail` default to the first/last 10 lines. */
const DEFAULT_LINE_COUNT = 10;

/** Parse `head`/`tail`; `undefined` for anything not a plain projection. */
function parseSimpleView(pipeline: string): SimpleView | undefined {
  const parts = pipeline.trim().split(/\s+/);
  const command = parts[0];
  if (command !== "head" && command !== "tail") return undefined;

  if (parts.length === 1) return { command, mode: "lines", count: DEFAULT_LINE_COUNT };
  if (parts.length === 2) {
    const arg = parts[1]!;
    const short = /^-(\d+)$/.exec(arg);
    if (short) return { command, mode: "lines", count: Number(short[1]) };
    const lines = /^-n(\d+)$/.exec(arg);
    if (lines) return { command, mode: "lines", count: Number(lines[1]) };
    const bytes = /^-c(\d+)$/.exec(arg);
    if (bytes) return { command, mode: "bytes", count: Number(bytes[1]) };
    return undefined;
  }
  if (parts.length === 3) {
    const value = parts[2]!;
    if (!/^\d+$/.test(value)) return undefined;
    if (parts[1] === "-n") return { command, mode: "lines", count: Number(value) };
    if (parts[1] === "-c") return { command, mode: "bytes", count: Number(value) };
    return undefined;
  }
  return undefined;
}

/**
 * First `count` lines of `text`, matching coreutils: a line ends at `\n`, and a
 * trailing partial line counts. The trailing newline of the last taken line is
 * preserved (`head -1` of `"a\nb\n"` is `"a\n"`).
 */
function headLines(text: string, count: number): string {
  let index = 0;
  let taken = 0;
  while (index < text.length && taken < count) {
    const newline = text.indexOf("\n", index);
    if (newline === -1) return text;
    index = newline + 1;
    taken++;
  }
  return text.slice(0, index);
}

/**
 * Last `count` lines of `text`, matching coreutils: a single trailing `\n` is a
 * terminator, not an empty final line (`tail -1` of `"a\nb\n"` is `"b\n"`).
 */
function tailLines(text: string, count: number): string {
  let end = text.length;
  if (end > 0 && text[end - 1] === "\n") end--;
  let seen = 0;
  for (let i = end; i > 0; i--) {
    if (text[i - 1] !== "\n") continue;
    seen++;
    if (seen === count) return text.slice(i);
  }
  return text;
}

/**
 * Apply a single plain `head`/`tail` projection to `text` without a subprocess.
 * Returns `undefined` when `pipeline` is anything else, so the caller can fall
 * back to `pi.exec`.
 */
export function applySimpleView(text: string, pipeline: string): string | undefined {
  const spec = parseSimpleView(pipeline);
  if (!spec) return undefined;
  if (spec.count <= 0) return "";

  if (spec.mode === "bytes") {
    const bytes = Buffer.from(text, "utf8");
    const slice =
      spec.command === "head"
        ? bytes.subarray(0, spec.count)
        : bytes.subarray(Math.max(0, bytes.length - spec.count));
    return slice.toString("utf8");
  }

  return spec.command === "head" ? headLines(text, spec.count) : tailLines(text, spec.count);
}