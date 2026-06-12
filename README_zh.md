# pi-tool-guard

一个 pi 扩展，用于纠正常见的 LLM 工具调用错误：规范化 `edit`/`write`/`read` 的参数别名，并从 `bash` 命令中去除尾部管道提取器。

## 安装

```bash
pi install npm:pi-tool-guard
```

---

## 功能

### 1. 参数别名规范化 (`edit` / `write` / `read`)

当 LLM 使用错误的字段名调用工具时，扩展会规范化这些字段，然后再进行 schema 验证。不会报错，不需要重新执行。

| 工具 | 标准字段 | 接受的别名 |
|---|---|---|
| edit | `path` | `file`, `filePath`, `file_path`, `target`, `filename`, `file_name` |
| edit | `edits[].oldText` | `old_str`, `old_string`, `oldContent`, `old`, `original`, `search` |
| edit | `edits[].newText` | `new_str`, `new_string`, `newContent`, `new`, `replacement`, `replace` |
| write | `path` | `file`, `filePath`, `file_path`, `target`, `filename`, `file_name` |
| write | `content` | `text`, `body`, `code`, `data`, `fileContent`, `contents` |
| read | `path` | `file`, `filePath`, `file_path`, `target`, `filename`, `file_name` |
| read | `offset` | `start`, `startLine`, `start_line`, `from`, `line` |
| read | `limit` | `lines`, `maxLines`, `max_lines`, `count`, `numLines`, `num_lines` |

> **Edit 工具简写**: 顶层的 `oldText`/`newText`（或别名）会自动包装到 `edits` 数组中。
>
> **Read 工具类型转换**: `offset` 和 `limit` 的字符串值会被转换为数字。

### 2. Bash 管道提取器剥离

当 LLM 在 bash 命令后附加截断命令（`tail`、`head`、`grep` 等）时，扩展会智能地剥离并应用这些提取器。

**三种情况策略：**

| 场景 | UI 通知 | LLM 响应 |
|---|---|---|
| 快速命令（< 10秒），已截断 | `Filtered via \`head\`` | 仅返回过滤后的结果 |
| 快速命令（< 10秒），未截断 | `Filtered via \`head\`` | 仅返回过滤后的结果 |
| 慢速命令（无论是否截断） | `The full output is above...` | 结果 + `This is a slow command. Avoid re-running...` |

**示例：** `vitest run | tail -n 10`
- 如果 vitest 在 10 秒内完成 → 对结果运行 `tail`（如果已截断则对完整输出文件运行），通知 UI
- 如果 vitest 运行缓慢 → 原样返回结果，通知 UI，向 LLM 追加慢速命令提示

**检测的提取器：** `head`, `tail`, `grep`, `egrep`, `fgrep`, `rg`, `sed`, `awk`, `cut`, `sort`, `uniq`, `wc`, `less`, `more`, `column`, `jq`, `yq`, `tr`

所有尾部提取器都会被剥离：`npm test | grep FAIL | head -5` → 剥离 `grep FAIL | head -5`

---

## 架构

两个功能都使用 `prepareArguments` 来覆盖内置工具——这是 pi 扩展进行参数纠正的最简洁模式：

- **edit/write/read**: `createXxxToolDefinition(cwd)` + `prepareArguments` 在 schema 验证前规范化别名
- **bash**: `createBashToolDefinition(cwd)` + 自定义 `execute` 覆盖：
  1. `prepareArguments` 使用 [unbash](https://github.com/nicolo-ribaudo/unbash) 解析命令，剥离尾部提取器
  2. `execute` 通过原始内置 execute 运行剥离后的命令
  3. 如果快速（< 10秒）且已截断 → 通过 `pi.exec` 在完整输出文件上运行提取器
  4. 如果快速（< 10秒）且未截断 → 通过 `pi.exec` 将结果通过管道传递给提取器
  5. 如果慢速（无论是否截断）→ 原样返回结果并附带通知

无错误恢复，无会话扫描。

## 开发

```bash
pnpm install
pnpm test        # 运行所有测试
pnpm typecheck   # 类型检查
```

## 许可证

MIT
