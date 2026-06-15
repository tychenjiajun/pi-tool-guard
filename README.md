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

**Three-case strategy:**

| Scenario | UI Notification | LLM Response |
|---|---|---|
| Fast command (< 10s), truncated | `Filtered via \`head -5\`` | Filtered result only |
| Fast command (< 10s), not truncated | `Filtered via \`head -5\`` | Filtered result only |
| Slow command (truncated or not) | `The full output is above...` | Result + `This is a slow command. Avoid re-running...` |

> **Notification format**: The UI notification shows both the full original command and the extracted pipeline. Example: `Removed trailing pipeline commands: \`grep FAIL | head -5\` from \`npm test | grep FAIL | head -5\`.`

**Example:** `vitest run | tail -n 10`
- If vitest finishes in < 10s → run `tail` on result (or full output file if truncated), notify UI
- If vitest is slow → return result as-is, notify UI, append slow-command hint to LLM

**Detected extractors:** `head`, `tail`, `grep`, `egrep`, `fgrep`, `rg`, `sed`, `awk`, `cut`, `sort`, `uniq`, `wc`, `less`, `more`, `column`, `jq`, `yq`, `tr`

All trailing extractors are stripped: `npm test | grep FAIL | head -5` → strips `grep FAIL | head -5`

---

## Architecture

Both features use `prepareArguments` on overridden built-in tools — the cleanest pi extension pattern for argument correction:

- **edit/write/read**: `createXxxToolDefinition(cwd)` + `prepareArguments` normalizes aliases before schema validation
- **bash**: `createBashToolDefinition(cwd)` + custom `execute` override:
  1. `prepareArguments` parses the command with [unbash](https://github.com/nicolo-ribaudo/unbash), strips trailing extractors
  2. `execute` runs the stripped command via the original built-in execute
  3. If fast (< 10s) + truncated → runs extractor on the full output file via `pi.exec`
  4. If fast (< 10s) + not truncated → pipes result through extractor via `pi.exec`
  5. If slow (truncated or not) → returns result as-is with notice

No error recovery, no session scanning.

## Development

```bash
pnpm install
pnpm test        # Run all tests
pnpm typecheck   # Type check
```

## License

MIT
