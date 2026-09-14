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
| 快速命令（< 10秒），已截断 | `Filtered via \`head -5\` —— 大输出从临时文件管道过滤` | 仅返回过滤后的结果 |
| 快速命令（< 10秒），未截断 | `Filtered via \`head -5\` —— 完整输出足够小，可直接管道` | 仅返回过滤后的结果 |
| 慢速命令（无论是否截断） | `The full output is above...` | 结果 + `This is a slow command. Avoid re-running...` |

> **通知格式**: UI 通知会显示完整的原始命令和提取的管道。示例：`Removed trailing pipeline commands: \`grep FAIL | head -5\` from \`npm test | grep FAIL | head -5\`.`

**示例：** `vitest run | tail -n 10`
- 如果 vitest 在 10 秒内完成 → 对结果运行 `tail`（如果已截断则对完整输出文件运行），通知 UI
- 如果 vitest 运行缓慢 → 原样返回结果，通知 UI，向 LLM 追加慢速命令提示

**检测的提取器：** `head`, `tail`, `grep`, `egrep`, `fgrep`, `rg`, `sed`, `awk`, `cut`, `sort`, `uniq`, `wc`, `less`, `more`, `column`, `jq`, `yq`, `tr`

所有尾部提取器都会被剥离：`npm test | grep FAIL | head -5` → 剥离 `grep FAIL | head -5`

**耗时拆分：** pi 内置渲染器只打印一行不透明的 `Took <总耗时>`。当 guard 运行了被剥离的提取器（总耗时因此包含 guard 的投影开销）时，该行会被替换为 SoL-Pi 风格的收据：

```
🛡 pi-tool-guard · grep FAIL | head -5
   Context saved · 1,234 → 20 lines · 98% smaller · 19 KiB saved
   Took 6.5s  ██████████████░░░░  cmd 5.0s · filter 1.5s
```

进度条按比例绘制——accent `█` 表示清洗后的命令，warning `░` 表示 guard 的提取器。慢速命令不运行提取器，因此保留原有行。

**无声空操作：** 当应用提取器后输出没有任何变化时（例如对 2 行结果执行 `tail -20`），guard 不显示 UI 通知也不渲染收据——保留 pi 原始的 `Took` 行。只有投影确实改变内容时才提示。

---

## 架构

别名规范化使用 `prepareArguments` 来覆盖 `edit`/`write`/`read` 工具——这是 pi 扩展进行参数纠正的最简洁模式：

- **edit/write/read**: `createXxxToolDefinition(cwd)` + `prepareArguments` 在 schema 验证前规范化别名

Bash 使用自定义 `execute` 覆盖：

1. `execute` 使用 [unbash](https://github.com/nicolo-ribaudo/unbash) 解析命令，剥离尾部提取器。剥离发生在这里（而非 `prepareArguments`），以便 `tool_result.input.command` 保留用户编写的原始命令。
2. 剥离后的命令通过原始内置 execute 运行
3. 如果快速（< 10秒）且已截断 → 通过 `pi.exec` 在完整输出文件上运行提取器
4. 如果快速（< 10秒）且未截断 → 通过 `pi.exec` 将结果通过管道传递给提取器
5. 如果慢速（无论是否截断）→ 原样返回结果并附带通知

无错误恢复，无会话扫描。

---

## 互操作：`details.piToolGuard`

当 guard 剥离提取器时，会在 `details.piToolGuard` 上打上版本化记录，以便其他 `tool_result` 处理器——尤其是 [SoL-Pi](https://github.com/earendil-works/soL-pi) 的证据保留 reducer——判断可见内容的真实含义：

```ts
interface PiToolGuardDetails {
  version: 1;
  originalCommand: string;   // 例如 "npm test | tail -20"
  cleanedCommand: string;    // 例如 "npm test"
  removed: string[];         // 例如 ["tail"]
  removedPipeline: string;   // 例如 "tail -20"
  outcome: "projection-applied" | "full-output";
  sourcePath?: string;       // Pi 生成时，未截断输出的路径
  timing?: {                 // guard 生效时的分阶段墙钟耗时
    commandMs: number;       // 清洗后命令的执行耗时
    extractorMs: number;     // guard 的提取器投影耗时（未运行则为 0）
    totalMs: number;         // commandMs + extractorMs
  };
  projection?: {             // 可测量时的投影前后大小
    inputLines: number;
    inputBytes: number;
    outputLines: number;
    outputBytes: number;
  };
  noop?: boolean;            // 投影未改变输出
}
```

- `outcome: "projection-applied"` — `content` 是用户的投影视图，作为回退应用。guard **保留** `details.fullOutputPath`/`truncation`（使 reducer 仍能归档完整日志），并将路径镜像为 `piToolGuard.sourcePath`。SoL-Pi 的 reducer 会读取 `fullOutputPath`，缩减完整日志，并用收据覆盖 guard 的投影。
- `outcome: "full-output"` — `content` 是剥离后命令的完整输出，保留 `details.fullOutputPath`。
- 未剥离提取器 → 不打记录；`details` 保持不变。

该契约是增量式且版本化的。使用者必须通过 `readPiToolGuardDetails`（从 `contract.ts` 导出）解析，并在遇到未知版本时回退到内联内容。

## 开发

```bash
pnpm install
pnpm test        # 运行所有测试
pnpm typecheck   # 类型检查
```

## 许可证

MIT
