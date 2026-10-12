# pi-tool-guard

A pi extension that corrects common LLM tool call mistakes: normalizes argument aliases for `edit`/`write`/`read` and strips trailing pipeline extractors from `bash` commands.

## Install

```bash
pi install npm:pi-tool-guard
```

---

## Features

### 1. Argument alias normalization (`edit` / `write` / `read`)

When the LLM calls a tool with wrong field names, the extension normalizes them before schema validation. No error, no re-execution.

| Tool | Canonical | Accepted aliases |
|---|---|---|
| edit | `path` | `file`, `filePath`, `file_path`, `target`, `filename`, `file_name` |
| edit | `edits[].oldText` | `old_str`, `old_string`, `oldContent`, `old`, `original`, `search` |
| edit | `edits[].newText` | `new_str`, `new_string`, `newContent`, `new`, `replacement`, `replace` |
| write | `path` | `file`, `filePath`, `file_path`, `target`, `filename`, `file_name` |
| write | `content` | `text`, `body`, `code`, `data`, `fileContent`, `contents` |
| read | `path` | `file`, `filePath`, `file_path`, `target`, `filename`, `file_name` |
| read | `offset` | `start`, `startLine`, `start_line`, `from`, `line` |
| read | `limit` | `lines`, `maxLines`, `max_lines`, `count`, `numLines`, `num_lines` |

> **Edit tool shorthand**: top-level `oldText`/`newText` (or aliases) are automatically wrapped into an `edits` array.
>
> **Read tool type coercion**: string values for `offset` and `limit` are coerced to numbers.

### 2. Bash pipeline extractor stripping

When the LLM appends truncation commands (`tail`, `head`, `grep`, etc.) to bash commands, the extension strips them and applies the extractor intelligently.

**Four-case strategy:**

| Scenario | UI Notification | LLM Response |
|---|---|---|
| Fast command (< 10s), truncated | — (none; identical to the built-in bash tool) | Filtered result only |
| Fast command (< 10s), not truncated | — (none; identical to the built-in bash tool) | Filtered result only |
| Slow command (truncated or not) | `The full output is above...` + guard receipt | Projected view + **Full-Output Readback** notice (inlines the saved path and says to read it instead of re-running) |
| Error (non-zero exit) | `Filtered via ...` | Projected text + `[Command exited with code N. Full output: <path>]` |

> **Notification format**: The UI notification shows both the full original command and the extracted pipeline. Example: `Removed trailing pipeline commands: \`grep FAIL | head -5\` from \`npm test | grep FAIL | head -5\`.` Fast commands show no notice and no receipt, so they look exactly like the built-in tool.

**Example:** `vitest run | tail -n 10`
- If vitest finishes in < 10s → run `tail` on result (or full output file if truncated), no UI
- If vitest is slow → persist the full, unextracted output to a temp file, return the projected view, notify UI, append a Full-Output Readback notice (path + "read it instead of re-running") to the LLM
- If vitest exits non-zero → recover the output and `Full output: <path>` pointer from the error, apply `tail` to the available full output, throw an error whose message is the projected text followed by `[Command exited with code N. Full output: <path>]`

**Extractor split:** Not all trailing pipeline commands are stripped. The guard distinguishes:

- **View extractors** (safe to strip; the guard re-applies them): `head`, `tail`, `grep`, `egrep`, `fgrep`, `rg`, `less`, `more`
- **Transform extractors** (NOT stripped): `sed`, `awk`, `cut`, `sort`, `uniq`, `wc`, `column`, `jq`, `yq`, `tr`

If the trailing pipeline contains any transform extractor, the guard leaves the command completely unchanged and runs it as-is (so the shell applies the transform). Stripping a transform would silently drop the transformation the user asked for.

Only view extractors are stripped: `npm test | grep FAIL | head -5` → strips `grep FAIL | head -5`

**Multi-statement safety:** stripping is only attempted when the trailing view's stdout is the whole command's stdout. A lone pipeline, or one surrounded by statements the guard can account for, is eligible. Statements that share the script's stdout but sit outside the window — a non-silent prefix (`cd /tmp && echo "=== build ===" && npm test | tail`) or a trailing `; echo done` — are **hoisted** into a temp side-channel file (`{ echo "=== build ==="\n} >> '<sink>' 2>&1`) so the shell preserves every byte, and the guard re-attaches that text around the projection. A prefix that is provably silent (`cd`, bare assignments, `true`, `:`, `test`, `[`, without redirects) needs no sink at all. What is still left untouched: a statement that carries its own extractor (`a | head && b | tail`), a backgrounded statement, a here-document, and — importantly — a trailing statement that reads the previous status:

```bash
printf 'a\n' | grep nomatch; echo "R=$?"   # bash prints R=1
```

Stripping `grep` would make `$?` observe `printf` (printing `R=0`), and the guard only learns the view's status *after* the command has run, so it passes the command through untouched rather than printing a lie. Prefixes are safe to hoist because `$?` there refers to whatever ran before them, which the guard never touches.

**Fast-path fidelity:** for fast commands the guard executes the *cleaned* command and re-applies the stripped extractor to pi's formatted result, rather than running the native `cmd | extractor` pipeline. This is faithful in the common case, with three accepted, documented deviations: pi merges stdout+stderr before the guard projects, so a stripped `grep`/`head` also filters stderr lines (a real shell pipeline would not); the guard trims trailing whitespace from the projection; and during the run pi's live `onUpdate` stream shows the cleaned command's unfiltered output — only the returned content is the projection. These are known limitations, not bugs.

**Exit codes:** Extractor exit codes are propagated, matching pi's own `cmd | extractor` behavior: a stripped pipeline whose re-applied extractor exits non-zero (e.g. `cmd | grep no-match`, where grep exits 1) fails with `Command exited with code 1`, instead of returning an empty success. On slow commands the error appends `Full output: <path>`. That only holds while the extractor is the command's last command — with a following statement (`cmd | grep x; echo done`) bash exits with *that* statement's status, so the guard projects instead of throwing.

**Empty output:** an empty inline projection renders as `(no output)`, matching pi's own empty-result rendering.

**Slow commands:** For slow commands (≥ 10s), the guard persists the full, unextracted output to a temp file (`pi-bash-guard-<hex>.log` in the OS temp dir; swept best-effort after 24h via `FULL_OUTPUT_TTL_MS` on subsequent persists) even when it is below pi's 50KB/2000-line truncation limit, and returns the projected view (outcome `projection-applied`) instead of dumping the entire output. The `pi-bash-` name plus a `details.fullOutputPath` pointer make that file readable by SoL-Pi's evidence-preserving reducer, so the full log stays reducible even when pi did not truncate. If the full output cannot be persisted (filesystem error) and pi did not truncate, the guard falls back to returning the full output (outcome `full-output`) rather than a projection, so the readback notice is never misleading. The LLM notice inlines that file path and tells the agent to read it on demand — e.g. the `read` tool with offset/limit, or `sed -n 'START,ENDp' <path>` — rather than re-running the expensive command. The guard never replays a previous run; every invocation executes the command again.

**Timing split:** pi's built-in renderer prints one opaque `Took <total>` line. For a **slow** command where the guard ran a stripped extractor, that line is replaced with a SoL-Pi-style receipt. Fast commands keep pi's plain line — no receipt, no UI:

```
🛡 pi-tool-guard · grep FAIL | head -5
   Context saved · 1,234 → 20 lines · 98% smaller · 19 KiB saved
   Took 6.5s  ██████████████░░░░  cmd 5.0s · filter 1.5s
```

The bar is proportional — accent `█` for the cleaned command, warning `░` for the guard's extractor.

**Silent no-op:** when applying the extractor leaves the output unchanged (e.g. `tail -20` on a 2-line result), the guard shows no UI notice and no receipt — pi's plain `Took` line stays. Notices and receipts only fire when the projection actually changed the content. No-op detection is only computed for inline (non-truncated) projections; for projections from a saved file the guard cannot cheaply compare against the full text, so it does not claim a no-op.

---

## Architecture

Alias normalization uses `prepareArguments` on the overridden `edit`/`write`/`read` tools — the cleanest pi extension pattern for argument correction:

- **edit/write/read**: `createXxxToolDefinition(cwd)` + `prepareArguments` normalizes aliases before schema validation

Bash runs a custom `execute` override:

1. `execute` parses the command with [unbash](https://github.com/nicolo-ribaudo/unbash) and strips trailing **view** extractors (transform extractors are left in place). It only strips a lone final pipeline or one surrounded by statements it can account for: provably silent ones stay in place, and non-silent ones are **hoisted** into a temp side-channel sink (`{ <text>\n} >> '<sink>' 2>&1`) whose text is re-attached around the projection. Statements carrying their own extractor, backgrounded statements, here-documents, and trailing status readers (`$?`/`PIPESTATUS`) pass the whole command through unchanged. Stripping happens here (not in `prepareArguments`) so `tool_result.input.command` keeps the command the user wrote.
2. The cleaned command is run through the original built-in execute.
3. If fast (< 10s) + truncated → runs extractor on the full output file via `pi.exec`
4. If fast (< 10s) + not truncated → pipes result through extractor via `pi.exec`
5. If slow (truncated or not) → persists the full, unextracted output to a temp file (`pi-bash-guard-<hex>.log`, OS temp dir; swept best-effort after 24h via `FULL_OUTPUT_TTL_MS` on subsequent persists), runs the extractor, returns the projected view + Full-Output Readback notice (falls back to outcome `full-output` if persisting fails and pi did not truncate)
6. If the command exits non-zero → recovers the output and `Full output: <path>` pointer from the error, applies the stripped (view) extractor to the available full output, and throws an error whose message is the projected text followed by a bracket note preserving the exit code and full-output path

No session scanning. Error path: a thrown error cannot carry `details`, so no `piToolGuard` contract is published on the error path — this is a documented limitation.

---

## Interop: `details.piToolGuard`

When the guard strips extractors it stamps a versioned record on `details.piToolGuard` so other `tool_result` handlers — notably [SoL-Pi](https://github.com/earendil-works/soL-pi)'s evidence-preserving reducer — can tell what the visible content really is:

```ts
interface PiToolGuardDetails {
  version: 1;
  originalCommand: string;   // e.g. "npm test | tail -20"
  cleanedCommand: string;    // e.g. "npm test"
  removed: string[];         // e.g. ["tail"]
  removedPipeline: string;   // e.g. "tail -20"
  outcome: "projection-applied" | "full-output";
  sourcePath?: string;       // untruncated output, when Pi produced one
  timing?: {                 // per-phase wall clock, when guard took effect
    commandMs: number;       // cleaned command execution
    extractorMs: number;     // guard's extractor projection (0 when none ran)
    totalMs: number;         // commandMs + extractorMs
  };
  projection?: {             // before/after size, when measurable
    inputLines: number;
    inputBytes: number;
    outputLines: number;
    outputBytes: number;
  };
  noop?: boolean;            // projection left the output unchanged (inline projections only)
  slow?: boolean;            // cleaned command ran >= 10s; only slow runs show guard UI
}
```

- `outcome: "projection-applied"` — `content` is the user's projection, applied as a fallback. The guard **always keeps** `details.fullOutputPath`/`truncation` (so a reducer still archives the full log) and mirrors the path as `piToolGuard.sourcePath`. When pi did not truncate but the guard persisted its own slow log, the guard also publishes that `pi-bash-guard-*.log` path as `details.fullOutputPath`. SoL-Pi's reducer reads `fullOutputPath`, reduces the full log, and overrides guard's projection with its receipt.
- `outcome: "full-output"` — `content` is the cleaned command's full output and `details.fullOutputPath` is kept. Also the fallback when a slow command's full output cannot be persisted (filesystem error) and pi did not truncate.
- `slow` — optional boolean; `true` means the cleaned command ran for at least `FAST_THRESHOLD_MS`. Only slow runs surface guard UI (Notice, footer status, receipt); fast commands look exactly like the built-in bash tool.
- No extractors stripped → no record; `details` is left untouched.

The contract is additive and versioned. Consumers must parse with `readPiToolGuardDetails` (exported from `contract.ts`) and fall back to the inline content for unknown versions.

## Development

```bash
pnpm install
pnpm test        # Run all tests
pnpm typecheck   # Type check
```

## License

MIT
