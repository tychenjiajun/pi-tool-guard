# Agent Instructions

## Package Manager
- Use **pnpm**: `pnpm install`

## Commands
| Task | Command |
|------|---------|
| Run all tests | `pnpm test` |
| Type check | `pnpm typecheck` |
| Run single test file | `pnpm vitest run bash.test.ts` |

## Key Conventions
- This is a **pi extension** — entry point is `index.ts`
- Test files: `*.test.ts` alongside source files
- Extract testable logic into separate modules (e.g., `execute.ts`) for unit testing
- Use `vi.useFakeTimers()` for time-dependent tests (slow vs fast commands)
- Mock `ctx.ui.notify` and `pi.exec` in tests

## Architecture
- `index.ts` — Extension entry, registers tool overrides and the `message_end` tool-name repair
- `execute.ts` — Core bash execution logic (extracted for testability)
- `bash.ts` — Helper functions for running extractors and building notices
- `pipeline.ts` — Bash command parsing and extractor stripping
- `view.ts` — In-process application of a plain trailing `head`/`tail`
- `aliases.ts` — Argument normalization for edit/write/read
- `names.ts` — Tool-name repair: case-fold plus bounded edit distance over the declared tool set
- `contract.ts` — Versioned `details.piToolGuard` interop contract for downstream consumers (e.g. SoL-Pi's evidence-preserving reducer)
- `timing.ts` — Duration formatting + proportional bar split
- `format.ts` — Pure text measurement and savings/count/byte formatting
- `render.ts` — Swaps pi's trailing `Took` line for the guard receipt
- `tui.ts` — SoL-Pi-style themed receipt component (`Container`/`Text` from `@earendil-works/pi-tui`) plus the transient footer status

## Interop Contract

Bash extractor stripping happens in `execute` (not `prepareArguments`) so `tool_result.input.command` keeps the command the user wrote. Only **view** extractors (`head`, `tail`, `grep`, `egrep`, `fgrep`, `rg`, `less`, `more`) are stripped; **transform** extractors (`sed`, `awk`, `cut`, `sort`, `uniq`, `wc`, `column`, `jq`, `yq`, `tr`) are left in place. A transform stops the trailing run instead of poisoning it, so `du -sh * | sort -rh | head -15` removes only `head -15` and the shell still applies `sort -rh`. Stripping is only attempted when the trailing view is the command's final pipeline and its stdout is the whole command's stdout. Statements around that window are handled by **Hoisting**: a non-silent statement or AndOr member is redirected into a temp side-channel sink (`{ <text>\n} >> '<sink>' 2>&1`) and the guard re-attaches the sink's text before/after the projection, so `cd x && echo "=== build ===" && npm test | tail -12` is now stripped instead of skipped. Hoisting needs sink files (created in `execute`); without them — or when a statement carries its own extractor, is backgrounded, or contains a here-document — the command is left untouched, so `stripTrailingExtractors(cmd)` with no sinks behaves exactly as before hoisting existed. A pipeline containing an **unbounded producer** (`tail -f`/`-F`/`--follow`, `yes`, `journalctl -f`, `watch`, an un-counted `ping`) is never stripped: the removed view may be the only thing that terminates it (`tail -f log | grep -m 1 DONE`, `yes | head -5`), and a removed `tail -f` would hang the guard's own extractor re-run. Bounded producers (`timeout 5 tail -f x | head`) still strip. The projection itself is applied in-process for a plain `head`/`tail` (`view.ts` → `applySimpleView`, ~76% of projected commands); any other removed pipeline — and every unreadable file — runs through `pi.exec`. Backgrounded final statements, and grouped commands that are not otherwise hoistable, are still left untouched. When extractors are stripped, the result stamps `details.piToolGuard` (see `contract.ts`):

- `outcome: "projection-applied"` — `content` is the user's projection, applied as a fallback. The projection re-runs against the **full** persisted output, and `head`/`tail` are line-based, so the guard re-applies pi's own model-facing cap (2000 lines / 50KB, tail kept — `format.ts` → `capModelOutput`): a `head -60` over 30 matches of a minified HTML file once returned all 4.3MB and bypassed pi's truncation entirely. When capped, `capped: true` is stamped on the contract; fast capped runs append pi's `[Showing … Full output: <path>]` banner (slow runs point via the readback notice instead), and `structuredContent.output` takes the capped text without the banner. `details.fullOutputPath`/`truncation` are **always kept**, so a downstream reducer (e.g. SoL-Pi's evidence-preserving reducer) can read the exact full log and override the projection with its receipt. When pi did **not** truncate but the guard persisted its own slow log, the guard also publishes that path as `details.fullOutputPath`, so the reducer reads the guard's full log instead of the projection.
- `outcome: "full-output"` — `content` is the cleaned command's full output; `details.fullOutputPath` is preserved. Also the fallback when a slow command's full output cannot be persisted (filesystem error) and pi did not truncate.
- `timing` — optional `{ commandMs, extractorMs, totalMs }`; the bash `renderResult` override uses it to replace pi's opaque `Took <total>` line with a SoL-Pi-style receipt when `extractorMs > 0` **and** the run was slow.
- `projection` — optional `{ inputLines, inputBytes, outputLines, outputBytes }`; measured only for inline (non-truncated) projections, powers the "Context saved" receipt line.
- `noop` — optional boolean; `true` means the projection left the output unchanged (inline projections only). The guard then publishes the contract but shows no notice and no receipt (pi's plain `Took` line stays).
- `slow` — optional boolean; the cleaned command ran for ≥ `FAST_THRESHOLD_MS`. **Only slow runs show guard UI** (Notice, footer status, receipt); fast commands look exactly like the built-in bash tool. `shouldRenderGuardReceipt` in `render.ts` gates the receipt on it.

Slow commands (≥ `FAST_THRESHOLD_MS`) persist the full, unextracted output to a file (`pi-bash-guard-<hex>.log` in the OS temp dir) and append a **Full-Output Readback** LLM notice (`buildSlowReadbackNotice`) that inlines the path as `Full output: <path>` and tells the agent to read it on demand instead of re-running. The `pi-bash-` prefix is deliberate: SoL-Pi's evidence-preserving reducer (`safePiBashTempPath`) trusts only `pi-bash-*.log` files directly under the OS temp dir, so this name — combined with publishing the path as `details.fullOutputPath` — keeps the full log reducible even when pi did not truncate; the `guard-` segment keeps it distinguishable from pi's own files. If persisting fails (filesystem error) and pi did not truncate, the guard falls back to returning the full output (outcome `full-output`) instead of a projection, so the readback notice is never misleading. Persisted logs are swept best-effort on subsequent persists once they exceed `FULL_OUTPUT_TTL_MS` (24h). The guard never replays a previous run — every invocation executes the command again.

**Resolved failures (pi ≥ 0.99 / 1.2.0).** pi's bash never throws for a non-zero exit: it resolves with `isError: true` and appends `Command exited with code N` to the content. That status describes the *cleaned* command, so `executeBashGuarded` splits it off (`splitExitStatus` in `bash.ts`) before the extractor input, the persisted log, and the projection, then reports the **view's** exit — what pi itself would report for `cmd | view`. The status line and `isError` flag are kept exactly as pi wrote them only when nothing re-decides the exit (`stripResult.hasFollowingStatement`, or a view that never ran). pi's `structuredContent` (bash `outputSchema`: `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }`, read by codemode scripts) is re-stamped around the projection — `output` becomes the projected text (capped to pi's model-facing limits, bannerless), `exit_code` the view's exit, `wall_time_seconds` the guarded run — while `truncated`/`full_output_path` are preserved.

Error (non-zero exit) path: extractor exit codes are propagated — a stripped pipeline whose re-applied view extractor exits non-zero (e.g. `... | grep nomatch`, which exits 1) fails with `Command exited with code 1`, matching pi's own `cmd | extractor` behavior, instead of returning an empty success. That holds only while the extractor is the command's last command: when a statement follows the window (`a | grep x; echo done`) bash exits with *that* statement's status, so the guard projects instead of throwing (`stripResult.hasFollowingStatement`). For an error that does throw with an exit code (custom bash operations, older pi), the guard recovers the output and `Full output: <path>` pointer, applies the stripped view extractor, and throws an error whose message is the projected text (capped to the same 50KB model-facing limit) followed by `[Command exited with code N. Full output: <path>]` (on slow commands the error carries the `Full output: <path>` pointer). A thrown error cannot carry `details`, so no `piToolGuard` contract is published on the error path — this is a documented limitation.

A statement after the window that reads `$?`/`${?}`/`PIPESTATUS` blocks stripping entirely (`pipeline.ts` → `READ_STATUS_RE`): the removed view is no longer the pipeline's last command, so `$?` would report the cleaned pipeline's status, and the guard only learns the view's status after the run. `printf 'a\n' | grep nomatch; echo "R=$?"` prints `R=1` in bash but would print `R=0` after stripping, so the command is passed through untouched.

**Fast-path fidelity (known limitations).** For fast commands the guard executes the *cleaned* command and re-applies the stripped extractor to pi's formatted result, rather than running the native `cmd | extractor` pipeline. Three accepted deviations: pi merges stdout+stderr before the guard projects, so a stripped `grep`/`head` also filters stderr lines (a real shell pipeline would not); the guard trims trailing whitespace from the projection; and during a fast run pi's live `onUpdate` stream shows the cleaned command's unfiltered output — only the returned content is the projection. These are documented limitations, not bugs. Empty inline projections render as `(no output)`, matching pi's own empty-result rendering.

Consumers must parse via `readPiToolGuardDetails` and fall back to inline content for unknown versions.

## External References
| Need | File |
|------|------|
| Domain glossary | `CONTEXT.md` |
| Interop contract | `contract.ts` |
| Pi extension docs | [pi docs](https://github.com/earendil-works/pi-coding-agent/docs) |

## Commit Attribution
AI commits MUST include:
```
Co-Authored-By: MiMo <mimo@xiaomi.com>
```
