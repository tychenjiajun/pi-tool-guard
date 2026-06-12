# pi-tool-guard

A pi extension that intercepts and corrects LLM tool calls before execution. It normalizes argument aliases and optimizes bash pipeline commands to prevent common LLM mistakes.

## Language

**Extractor**:
A trailing command in a bash pipeline that filters or transforms output (`head`, `tail`, `grep`, etc.).
_Avoid_: filter, pipe command

**Pipeline Stripping**:
Removing trailing extractors from a bash command so the full output is available for further processing.

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

## Relationships

- A **Pipeline** contains one or more commands, with optional **Extractors** at the end
- **Fast Commands** have extractors piped through them (or run on `fullOutputPath` if truncated)
- **Slow Commands** return results as-is with an **LLM Notice**
- **Truncation** is independent of speed — a fast command can be truncated, a slow command may not be

## Example dialogue

> **Dev:** "When the LLM runs `ls | head -5`, what does the guard do?"
> **Domain expert:** "It strips `head`, runs `ls`, then pipes the result through `head`. The user sees a UI notice, but the LLM gets the filtered result only."
>
> **Dev:** "What about `npm test | tail -10` if it takes 30 seconds?"
> **Domain expert:** "It's a slow command. The guard strips `tail`, runs `npm test`, returns the full result to the LLM with a 'slow command' hint, and shows a UI notice."

## Flagged ambiguities

- "notice" was used for both UI and LLM messages — resolved: "Notice" means UI notification, "LLM Notice" means message appended to tool result.
