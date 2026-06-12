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

## External References
| Need | File |
|------|------|
| Domain glossary | `CONTEXT.md` |
| Pi extension docs | [pi docs](https://github.com/earendil-works/pi-coding-agent/docs) |

## Commit Attribution
AI commits MUST include:
```
Co-Authored-By: MiMo <mimo@xiaomi.com>
```
