# pi-tool-guard

A pi extension that intercepts and corrects LLM tool calls before execution. It normalizes argument aliases and optimizes bash pipeline commands to prevent common LLM mistakes.

## Language

**Extractor**:
A trailing command in a bash pipeline that filters or transforms output (`head`, `tail`, `grep`, etc.).
_Avoid_: filter, pipe command

**Pipeline Stripping**:
Removing trailing **Extractors** from a bash command so the full output is available for further processing. "Trailing" is the end of the **whole** command: only the final `;`/`&&` statement's pipeline may lose extractors, and every earlier statement is preserved verbatim.
_Avoid_: pipeline trimming, command rewriting

**Fast Command**:
A bash command that completes in under 10 seconds (configurable via `FAST_THRESHOLD_MS`).
_Avoid_: quick command, short command

**Slow Command**:
A bash command that takes 10 seconds or more to complete.
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
The versioned `details.piToolGuard` record published on bash results when extractors were stripped. Describes the original and cleaned commands and the outcome. Downstream extensions (e.g. SoL-Pi's evidence-preserving reducer) read it to decide whether the visible content is the user's projection or a full output.
_Avoid_: metadata blob, guard flag

**Projection Applied**:
A Guard Contract outcome meaning `content` is the result of re-running the stripped extractor pipeline — the user's requested view, applied as a fallback. `details.fullOutputPath`/`truncation` are kept so a downstream reducer (e.g. SoL-Pi's evidence-preserving reducer) can read the exact full log and override the projection.
_Avoid_: filtered result, reduced

**Full Output**:
A Guard Contract outcome meaning `content` is the cleaned command's full (possibly truncated) output — the extractor was not applied (slow command). `details.fullOutputPath` is preserved.
_Avoid_: raw result

**Source Path**:
The `piToolGuard.sourcePath` field pointing at the untruncated output file. It mirrors `details.fullOutputPath`, which guard always keeps so pre-contract reducers still find the full log.
_Avoid_: fullOutputPath, temp path

**Timing Split**:
Illustrating the per-phase wall clock — `commandMs` (cleaned command execution) versus `extractorMs` (guard's extractor projection). Published as the optional `piToolGuard.timing` record and rendered only when the guard actually ran an extractor.
_Avoid_: timing breakdown, duration chart

**Guard Receipt**:
The SoL-Pi-style themed block that replaces pi's single `Took <total>` line: a `🛡 pi-tool-guard · <pipeline>` title, an optional `Context saved · …` line from the **Projection Stats**, and the **Timing Split** bar. Rendered by `tui.ts` only for a non-**No-op Projection**.
_Avoid_: timing illustration, toast

**Projection Stats**:
Before/after line and byte counts of a projection (`piToolGuard.projection`), measured only for inline (non-truncated) commands. Powers the receipt's "Context saved" line.
_Avoid_: savings, reduction metrics

**No-op Projection**:
A **Projection Applied** whose content is identical (ignoring trailing whitespace) to the cleaned command's own output. The guard still stamps the **Guard Contract** but shows no **Notice** and no **Guard Receipt**, because it changed nothing the user would see.
_Avoid_: empty filter, redundant projection

## Relationships

- A **Pipeline** contains one or more commands, with optional **Extractors** at the end
- **Fast Commands** have extractors piped through them (or run on `fullOutputPath` if truncated)
- **Slow Commands** return results as-is with an **LLM Notice**
- **Truncation** is independent of speed — a fast command can be truncated, a slow command may not be
- The **Guard Contract** is stamped only when extractors were stripped; a **Projection Applied** outcome applies guard's projection as a fallback while keeping `fullOutputPath` so a reducer can override, and a **Full Output** outcome keeps it too
- A **Timing Split** rides on the **Guard Contract**; it is rendered only when `extractorMs > 0` (a projection actually ran), so slow/full-output commands keep pi's plain `Took` line
- A **Guard Receipt** bundles the **Timing Split** with **Projection Stats**; it replaces pi's `Took` line only when the guard actually projected a change
- A **No-op Projection** is a **Projection Applied** that leaves the output unchanged, so guard suppresses both its **Notice** and its **Guard Receipt** while still publishing the contract

## Example dialogue

> **Dev:** "When the LLM runs `ls | head -5`, what does the guard do?"
> **Domain expert:** "It strips `head`, runs `ls`, then pipes the result through `head`. The user sees a UI notice, but the LLM gets the filtered result only."
>
> **Dev:** "What about `npm test | tail -10` if it takes 30 seconds?"
> **Domain expert:** "It's a slow command. The guard strips `tail`, runs `npm test`, returns the full result to the LLM with a 'slow command' hint, shows a UI notice, and stamps the **Guard Contract** with outcome **Full Output**. A downstream reducer can then safely archive the full log via `fullOutputPath`."
>
> **Dev:** "And if it finishes in 2 seconds?"
> **Domain expert:** "**Projection Applied**: the guard runs `tail` on the result as a fallback, but keeps `fullOutputPath`, so a reducer that understands the contract (or just reads **Source Path**) can override guard's projection with an evidence-checked receipt for the full log."

## Flagged ambiguities

- "notice" was used for both UI and LLM messages — resolved: "Notice" means UI notification, "LLM Notice" means message appended to tool result.
