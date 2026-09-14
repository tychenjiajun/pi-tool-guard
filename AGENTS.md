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
- `index.ts` — Extension entry, registers tool overrides
- `execute.ts` — Core bash execution logic (extracted for testability)
- `bash.ts` — Helper functions for running extractors and building notices
- `pipeline.ts` — Bash command parsing and extractor stripping
- `aliases.ts` — Argument normalization for edit/write/read
- `contract.ts` — Versioned `details.piToolGuard` interop contract for downstream consumers (e.g. SoL-Pi's evidence-preserving reducer)
- `timing.ts` — Duration formatting + proportional bar split
- `format.ts` — Pure text measurement and savings/count/byte formatting
- `render.ts` — Swaps pi's trailing `Took` line for the guard receipt
- `tui.ts` — SoL-Pi-style themed receipt component (`Container`/`Text` from `@earendil-works/pi-tui`) plus the transient footer status

## Interop Contract

Bash extractor stripping happens in `execute` (not `prepareArguments`) so `tool_result.input.command` keeps the command the user wrote. When extractors are stripped, the result stamps `details.piToolGuard` (see `contract.ts`):

- `outcome: "projection-applied"` — `content` is the user's projection, applied as a fallback. `details.fullOutputPath`/`truncation` are **kept**, so a downstream reducer (e.g. SoL-Pi's evidence-preserving reducer) can read the exact full log and override the projection with its receipt.
- `outcome: "full-output"` — `content` is the cleaned command's full output; `details.fullOutputPath` is preserved.
- `timing` — optional `{ commandMs, extractorMs, totalMs }`; the bash `renderResult` override uses it to replace pi's opaque `Took <total>` line with a SoL-Pi-style receipt when `extractorMs > 0`.
- `projection` — optional `{ inputLines, inputBytes, outputLines, outputBytes }`; measured only for inline (non-truncated) projections, powers the "Context saved" receipt line.
- `noop` — optional boolean; `true` means the projection left the output unchanged. The guard then publishes the contract but shows no notice and no receipt (pi's plain `Took` line stays).

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
