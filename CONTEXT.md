# pi-tool-guard

A pi extension that intercepts and corrects LLM tool calls before execution. It normalizes argument aliases and optimizes bash pipeline commands to prevent common LLM mistakes.

## Language

**Extractor**:
A trailing command in a bash pipeline that filters or transforms output. Two kinds: **View Extractors** (`head`, `tail`, `grep`, `egrep`, `fgrep`, `rg`, `less`, `more`) are safe to strip and re-apply; **Transform Extractors** (`sed`, `awk`, `cut`, `sort`, `uniq`, `wc`, `column`, `jq`, `yq`, `tr`) are NOT stripped — the guard leaves the command unchanged so the shell applies the transform.
_Avoid_: filter, pipe command

**Pipeline Stripping**:
Removing trailing **View Extractors** from a bash command so the full output is available for further processing. **Transform Extractors** are left in place. Only the **final pipeline** is eligible, and only when its stdout is the whole command's stdout: with `;`/`&&`/`||` the stripped extractor would also filter the earlier statements, so the command is left untouched unless every other statement is a **Silent Prefix**, a **Hoisted Statement**, or a **Status-Reading Statement** (which is refused outright). Redirections (`<`, `>`, `2>&1`) stay attached to their command — an input redirect on the cleaned command is kept, and a redirect on a stripped view travels with it in the removed pipeline. A final statement that is **backgrounded** with `&` is never stripped (its output is not synchronously capturable, and slicing out the view would drop the `&`, silently foregrounding the job).
_Avoid_: pipeline trimming, command rewriting

**Silent Prefix**:
The statements or AndOr members that run before a command's final pipeline (`cd /tmp && npm test | tail`, `FOO=bar; npm test | head`). They share the script's stdout, so stripping the final extractor is only faithful when the whole prefix provably writes nothing to stdout. The allowlist is tiny and structural: `cd`, `true`, `:`, `test`, `[`, and bare assignments — with no redirects (a `2>&1` could merge stderr into the stream the extractor reads). Grouped (`(...)`, `{ ...; }`) and backgrounded prefixes are never assumed silent. A prefix that is neither **silent** nor a **Hoisted Statement** blocks stripping entirely. A *trailing* statement gets the same treatment — silent ones simply stay in place.
_Avoid_: quiet prefix, empty prefix

**Hoisted Statement**:
A statement or AndOr member that shares the command's stdout with the projection window but is neither provably silent nor part of it. The guard redirects it into a **Side Channel** (`{ <text>\n} >> '<sink>' 2>&1`) so the shell preserves every byte while the extractor only ever sees the window: `cd x && echo "=== build ===" && npm test | tail -12` becomes `cd x && { echo "=== build ===\n} >> '<sink>' 2>&1 && npm test`, and the guard re-attaches the sink's text before the projection. Hoisting needs **Side Channel** files; without them (or when a statement cannot be hoisted faithfully) the command is left completely untouched, which is what keeps the pre-hoisting behaviour byte-identical for every command that does not need one. Statements are never hoisted when they carry a **View Extractor** of their own (the shell would apply one extractor while the guard applies another), when they are **backgrounded**, or when they contain a here-document (its body lives outside the statement's span). `{ ...; }` runs in the *current* shell — unlike `( ... )` — so a hoisted `cd`/assignment keeps its effect on the window after it, a leading redirection does not reset `$?`, and `&&`/`||` short-circuiting is preserved (`cd /missing && echo hi && npm test | tail` still skips the pipeline).
_Avoid_: side channel statement, rescued statement

**Side Channel**:
A `pi-bash-guard-sink-<hex>.out` temp file that a **Hoisted Statement** appends its stdout+stderr to. Opened (and truncated) by the guard before the run so the shell's `>>` can never fail and short-circuit an `&&` chain; read once the command has finished, re-attached around the projection, and always removed. Sinks are never evidence: unlike `pi-bash-guard-*.log` they are never published as a **Source Path**, and only a stale sweep (`FULL_OUTPUT_TTL_MS`) can outlive a crashed run.
_Avoid_: temp file, buffer

**Status-Reading Statement**:
A statement after the projection window whose text reads `$?`, `${?}`, or `PIPESTATUS`. Stripping the extractor changes that status — the removed view is no longer the last command of the pipeline — and the guard only learns the view's own status *after* the command has run, so it cannot reproduce it. Such a command is passed through completely untouched rather than printing a lie: `printf 'a\n' | grep nomatch; echo "R=$?"` prints `R=1` in bash, while the stripped form would print `R=0`. Prefixes are unaffected — they read the status of whatever ran before them, which the guard never touches.
_Avoid_: exit-code reader, $? consumer

**Exit-Status Owner**:
The last statement of a command, which owns the shell's exit status. Stripping an extractor behind one means the extractor's non-zero exit no longer fails the script (`a | grep x; echo done` exits 0 in bash), so the guard must not report `Command exited with code 1` for it. Recorded on the plan as `hasFollowingStatement`.
_Avoid_: exit code owner, final status

**Fast Command**:
A bash command that completes in under 10 seconds (configurable via `FAST_THRESHOLD_MS`).
_Avoid_: quick command, short command

**Fast-Path Projection**:
For a **Fast Command** ending in a stripped view extractor, guard executes the *cleaned* command and re-applies the extractor to pi's formatted result instead of running the native `cmd | extractor` pipeline. This is faithful in the common case, with three accepted, documented deviations: pi merges stdout+stderr before the guard projects, so a stripped `grep`/`head` also filters stderr lines (a real shell pipeline would not); the guard trims trailing whitespace from the projection; and during the run pi's live `onUpdate` stream shows the cleaned command's unfiltered output — only the returned content is the projection. These are known limitations, not bugs. An empty inline projection renders as `(no output)`, matching pi's own empty-result rendering.
_Avoid_: exact-shell fidelity, stderr separation

**Slow Command**:
A bash command that takes 10 seconds or more to complete. The guard persists the full output to a temp file (even below pi's truncation limit), runs the stripped view extractor, and returns the projected view + full-output pointer with an **LLM Notice**. The persisted log is a `pi-bash-guard-<hex>.log` in the OS temp dir (named so downstream consumers that trust pi's `pi-bash-*.log` artifacts will read it); logs older than `FULL_OUTPUT_TTL_MS` (24h) are swept best-effort on subsequent persists. When pi did not truncate, the guard publishes this path as `details.fullOutputPath` so a reducer can archive the full log. If persisting fails (filesystem error) and pi did not truncate, the guard falls back to returning the full output (outcome `full-output`) instead of a projection.
_Avoid_: long command, heavy command

**Truncation**:
When pi's built-in bash tool output exceeds limits (50KB or 2000 lines), it saves the full output to a temp file and returns a truncated result with `fullOutputPath`.
_Avoid_: clipping, cutting

**Notice**:
A message displayed to the user via `ctx.ui.notify`. This is separate from the LLM response.
_Avoid_: notification, alert

**LLM Notice**:
A message appended to the tool result that the LLM sees. Used only for slow commands to discourage re-running.
_Avoid_: hint, message

**Argument Normalization**:
Converting incorrect or alias field names to the canonical names expected by the tool schema.
_Avoid_: field mapping, alias resolution

**Guard Contract**:
The versioned `details.piToolGuard` record published on bash results when extractors were stripped. Describes the original and cleaned commands and the outcome. Downstream extensions (e.g. SoL-Pi's evidence-preserving reducer) read it to decide whether the visible content is the user's projection or a full output. Not published on the error (non-zero exit) path — a thrown error cannot carry `details`.
_Avoid_: metadata blob, guard flag

**Projection Applied**:
A Guard Contract outcome meaning `content` is the result of re-running the stripped view extractor pipeline — the user's requested view, applied as a fallback. `details.fullOutputPath`/`truncation` are always kept so a downstream reducer (e.g. SoL-Pi's evidence-preserving reducer) can read the exact full log and override the projection.
_Avoid_: filtered result, reduced

**Full Output**:
A Guard Contract outcome meaning `content` is the cleaned command's full (possibly truncated) output — the extractor was not applied. `details.fullOutputPath` is preserved.
_Avoid_: raw result

**Source Path**:
The `piToolGuard.sourcePath` field pointing at the untruncated output file. It mirrors `details.fullOutputPath`, which guard always keeps — and, for a slow command pi did not truncate, sets to guard's own persisted `pi-bash-guard-*.log` — so pre-contract reducers still find the full log.
_Avoid_: fullOutputPath, temp path

**Full-Output Readback**:
The **LLM Notice** appended to a **Slow Command**'s projected result. It inlines the full-output file path and tells the agent to read that file on demand (e.g. the `read` tool with offset/limit, or `sed -n 'START,ENDp' <path>`) instead of re-running the expensive command. The guard never replays a previous run — every invocation executes the command again.
_Avoid_: cache hit, replay, memoization

**Error (Non-zero Exit)**:
When the cleaned command exits non-zero, pi's bash tool throws. The guard recovers the output and `Full output: <path>` pointer from that error, applies the stripped view extractor to the available full output, and throws an error whose message is the projected text followed by `[Command exited with code N. Full output: <path>]`. The same path handles a re-applied extractor that itself exits non-zero (e.g. `cmd | grep no-match`); its exit code is propagated to match pi's native `cmd | extractor` behavior. No Guard Contract is published on this path.
_Avoid_: error projection, exit code recovery

**Timing Split**:
Illustrating the per-phase wall clock — `commandMs` (cleaned command execution) versus `extractorMs` (guard's extractor projection). Published as the optional `piToolGuard.timing` record and rendered only for a **Slow Command** that actually ran an extractor.
_Avoid_: timing breakdown, duration chart

**Guard Receipt**:
The SoL-Pi-style themed block that replaces pi's single `Took <total>` line: a `🛡 pi-tool-guard · <pipeline>` title, an optional `Context saved · …` line from the **Projection Stats**, and the **Timing Split** bar. Rendered by `tui.ts` only for a **Slow Command** whose projection is not a **No-op Projection**. **Fast Commands** show no guard UI at all — no **Notice**, no receipt — so they look exactly like the built-in bash tool.
_Avoid_: timing illustration, toast

**Projection Stats**:
Before/after line and byte counts of a projection (`piToolGuard.projection`), measured only for inline (non-truncated) commands. Powers the receipt's "Context saved" line.
_Avoid_: savings, reduction metrics

**No-op Projection**:
A **Projection Applied** whose content is identical (ignoring trailing whitespace) to the cleaned command's own output. The guard still stamps the **Guard Contract** but shows no **Notice** and no **Guard Receipt**, because it changed nothing the user would see. Only computed for inline (non-truncated) projections; for projections from a saved file the guard cannot cheaply compare against the full text, so it does not claim a no-op.
_Avoid_: empty filter, redundant projection

## Relationships

- A **Pipeline** contains one or more commands, with optional **View Extractors** at the end (**Transform Extractors** are never stripped)
- A **Pipeline** is stripped only when it is the whole command, or when every other statement is a **Silent Prefix**, a **Hoisted Statement**, or the **Exit-Status Owner**; a **Status-Reading Statement** after the window, an extractor inside a **Hoisted Statement**, a here-document, or a backgrounded statement leaves the command untouched
- **Hoisted Statements** shave their output into a **Side Channel** and the guard re-attaches it around the projection, so stdout, `&&` short-circuiting, `cd` effects and `$?` all stay exactly as the shell would have produced them
- **Fast Commands** have view extractors piped through them (or run on `fullOutputPath` if truncated)
- **Slow Commands** persist the full, unextracted output to a file, run the view extractor, and return the projected view + **Full-Output Readback** as an **LLM Notice**
- **Error (Non-zero Exit)** recovers output from the thrown error, applies the view extractor, and throws a projected error with exit code + path
- **Truncation** is independent of speed — a fast command can be truncated, a slow command may not be
- The **Guard Contract** is stamped only when view extractors were stripped; a **Projection Applied** outcome applies guard's projection as a fallback while always keeping `fullOutputPath` so a reducer can override, and a **Full Output** outcome keeps it too; no contract is published on the error path
- A **Timing Split** rides on the **Guard Contract**; it is rendered only for a **Slow Command** when `extractorMs > 0` (a projection actually ran)
- A **Guard Receipt** bundles the **Timing Split** with **Projection Stats**; it replaces pi's `Took` line only for a **Slow Command** whose projection changed the output — **Fast Commands** keep pi's plain line
- A **No-op Projection** is a **Projection Applied** that leaves the output unchanged (inline projections only), so guard suppresses both its **Notice** and its **Guard Receipt** while still publishing the contract

## Example dialogue

> **Dev:** "When the LLM runs `ls | head -5`, what does the guard do?"
> **Domain expert:** "It strips `head`, runs `ls`, then pipes the result through `head`. The user sees a UI notice, but the LLM gets the filtered result only."
>
> **Dev:** "What about `npm test | tail -10` if it takes 30 seconds?"
> **Domain expert:** "It's a slow command. The guard strips `tail`, persists the full, unextracted output to a temp file, runs `tail` on it, and returns the projected view to the LLM with a **Full-Output Readback** notice: the notice inlines the file path and tells the agent to read it on demand instead of re-running. It also shows a UI notice and stamps the **Guard Contract** with outcome **Projection Applied**, so a downstream reducer can archive the full log via `fullOutputPath`. The guard does not replay runs — a later identical `npm test` executes again."
>
> **Dev:** "And if it exits non-zero?"
> **Domain expert:** "The guard recovers the output and `Full output: <path>` from the error, applies the stripped view extractor, and throws an error whose message is the projected text followed by `[Command exited with code N. Full output: <path>]`. No Guard Contract is published on this path — a thrown error cannot carry `details`."
>
> **Dev:** "And if it finishes in 2 seconds?"
> **Domain expert:** "**Projection Applied**: the guard runs `tail` on the result as a fallback, but keeps `fullOutputPath`, so a reducer that understands the contract (or just reads **Source Path**) can override guard's projection with an evidence-checked receipt for the full log."
>
> **Dev:** "And `cd app && echo \"=== build ===\" && npm test | tail -12; echo \"R=$?\"`?"
> **Domain expert:** "The `echo` and the `&&` chain used to block stripping, because re-applying `tail` would filter their output too. Now the **Hoisted Statements** go into **Side Channels** and the guard re-attaches them, so a **Hoisted Statement** no longer blocks anything. The `echo \"R=$?\"` is different: it is a **Status-Reading Statement**, and stripping `tail` would make `$?` observe `npm test` instead of `tail` — so that whole command is still passed through untouched. Move the status read out of the command (or drop it) and the guard handles the rest."

## Flagged ambiguities

- "notice" was used for both UI and LLM messages — resolved: "Notice" means UI notification, "LLM Notice" means message appended to tool result.
