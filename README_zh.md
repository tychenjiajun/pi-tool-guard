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

**四种情况策略：**

| 场景 | UI 通知 | LLM 响应 |
|---|---|---|
| 快速命令（< 10秒），已截断 | —（无；与内置 bash 工具完全一致） | 仅返回过滤后的结果 |
| 快速命令（< 10秒），未截断 | —（无；与内置 bash 工具完全一致） | 仅返回过滤后的结果 |
| 慢速命令（无论是否截断） | `The full output is above...` + guard 收据 | 投影视图 + **完整输出回读（Full-Output Readback）** 通知（内联保存路径，并告知读取该文件而非重新运行） |
| 错误（非零退出） | `Filtered via ...` | 投影文本 + `[Command exited with code N. Full output: <path>]` |

> **通知格式**: UI 通知会显示完整的原始命令和提取的管道。示例：`Removed trailing pipeline commands: \`grep FAIL | head -5\` from \`npm test | grep FAIL | head -5\`.` 快速命令不显示通知也不渲染收据，因此与内置工具完全一致。

**示例：** `vitest run | tail -n 10`
- 如果 vitest 在 10 秒内完成 → 对结果运行 `tail`（如果已截断则对完整输出文件运行），无 UI
- 如果 vitest 运行缓慢 → 将完整的、未提取的输出持久化到临时文件，返回投影视图，通知 UI，向 LLM 追加完整输出回读通知（路径 + “读取它而非重新运行”）
- 如果 vitest 非零退出 → 从错误中恢复输出和 `Full output: <path>` 指针，对可用完整输出应用 `tail`，抛出错误，消息为投影文本后跟 `[Command exited with code N. Full output: <path>]`

**提取器分类：** 并非所有尾部管道命令都会被剥离。guard 区分：

- **视图提取器**（可安全剥离；guard 会重新应用）：`head`、`tail`、`grep`、`egrep`、`fgrep`、`rg`、`less`、`more`
- **转换提取器**（不剥离）：`sed`、`awk`、`cut`、`sort`、`uniq`、`wc`、`column`、`jq`、`yq`、`tr`

如果尾部管道包含任何转换提取器，guard 会完全保留命令不变并原样运行（由 shell 应用转换）。剥离转换会静默丢弃用户请求的转换。

仅剥离视图提取器：`npm test | grep FAIL | head -5` → 剥离 `grep FAIL | head -5`

**多语句安全：** 仅当尾部视图的 stdout 就是整条命令的 stdout 时才尝试剥离。单独的管道，或前面只有**静默前缀**（`cd`、裸赋值、`true`、`:`、`test`、`[`，且无重定向——例如 `cd /tmp && npm test | tail`）的管道，才有资格。其他情况一律保持原样：对于 `a && b | head`，剥离后再重新应用 `head` 会返回 `a` 的前几行，而不是 `b` 的。这覆盖了 `;`/`&&`/`||` 语句列表、分组 `(...)`/`{ ...; }` 命令，以及被后台化的前置语句。

**快速路径保真度：** 对于快速命令，guard 执行*清洗后的*命令，并将被剥离的提取器重新应用到 pi 格式化后的结果上，而非运行原生的 `cmd | extractor` 管道。在常见场景下这是忠实的，但存在三个已接受的、已记录的偏差：guard 投影前 pi 会将 stdout 与 stderr 合并，因此被剥离的 `grep`/`head` 也会过滤 stderr 行（真实 shell 管道不会这样）；guard 会修剪投影的尾部空白；运行期间 pi 的实时 `onUpdate` 流显示的是清洗后命令的未过滤输出——只有返回的内容是投影。这些是已知的局限性，并非缺陷。

**退出码：** 提取器退出码现在会透传，与 pi 自身的 `cmd | extractor` 行为一致：如果重新应用的提取器以非零退出码结束（例如 `cmd | grep no-match`，其中 grep 退出码为 1），命令会以 `Command exited with code 1` 失败，而不是返回空成功结果。慢速命令的错误信息会追加 `Full output: <path>`。

**空输出：** 空的内联投影渲染为 `(no output)`，与 pi 自身的空结果渲染一致。

**慢速命令：** 对于慢速命令（≥ 10秒），即使输出低于 pi 的 50KB/2000 行截断限制，guard 也会将完整的、未提取的输出持久化到临时文件（`pi-bash-guard-<hex>.log`，位于 OS 临时目录；后续持久化时以 `FULL_OUTPUT_TTL_MS`（24小时）为上限尽力清除旧文件），并返回投影视图（结果 `projection-applied`）而非转储整个输出。`pi-bash-` 名称加上 `details.fullOutputPath` 指针使该文件可被 SoL-Pi 的证据保留 reducer 读取，因此即使 pi 未截断，完整日志仍可缩减。如果完整输出无法持久化(文件系统错误)且 pi 未截断,guard 会回退为返回完整输出(结果 `full-output`)而非投影,以免回读通知产生误导。LLM 通知内联该文件路径,告知 agent 按需读取--例如 `read` 工具配合 offset/limit,或 `sed -n 'START,ENDp' <path>`--而不是重新运行开销大的命令。guard 从不重放先前的运行;每次调用都会重新执行命令。

**耗时拆分：** pi 内置渲染器只打印一行不透明的 `Took <总耗时>`。对于 guard 运行了被剥离提取器的**慢速**命令，该行会被替换为 SoL-Pi 风格的收据。快速命令保留 pi 的原始行——无收据、无 UI：

```
🛡 pi-tool-guard · grep FAIL | head -5
   Context saved · 1,234 → 20 lines · 98% smaller · 19 KiB saved
   Took 6.5s  ██████████████░░░░  cmd 5.0s · filter 1.5s
```

进度条按比例绘制——accent `█` 表示清洗后的命令，warning `░` 表示 guard 的提取器。

**无声空操作：** 当应用提取器后输出没有任何变化时（例如对 2 行结果执行 `tail -20`），guard 不显示 UI 通知也不渲染收据——保留 pi 原始的 `Took` 行。只有投影确实改变内容时才提示。空操作检测仅针对内联（非截断）投影计算；对于来自已保存文件的投影，guard 无法廉价地与完整文本比较，因此不会声称空操作。

---

## 架构

别名规范化使用 `prepareArguments` 来覆盖 `edit`/`write`/`read` 工具——这是 pi 扩展进行参数纠正的最简洁模式：

- **edit/write/read**: `createXxxToolDefinition(cwd)` + `prepareArguments` 在 schema 验证前规范化别名

Bash 使用自定义 `execute` 覆盖：

1. `execute` 使用 [unbash](https://github.com/nicolo-ribaudo/unbash) 解析命令，剥离尾部**视图**提取器（转换提取器保留不变）。它仅剥离单独的最后一条管道，或位于静默前缀之后的管道；多语句、分组和后台化命令原样传递。剥离发生在这里（而非 `prepareArguments`），以便 `tool_result.input.command` 保留用户编写的原始命令。
2. 剥离后的命令通过原始内置 execute 运行
3. 如果快速（< 10秒）且已截断 → 通过 `pi.exec` 在完整输出文件上运行提取器
4. 如果快速（< 10秒）且未截断 → 通过 `pi.exec` 将结果通过管道传递给提取器
5. 如果慢速(无论是否截断)→ 将完整的、未提取的输出持久化到临时文件(`pi-bash-guard-<hex>.log`，OS 临时目录；后续持久化时以 `FULL_OUTPUT_TTL_MS`（24小时）为上限尽力清除旧文件),运行提取器,返回投影视图 + 完整输出回读通知(持久化失败且 pi 未截断时回退为结果 `full-output`)
6. 如果命令非零退出 → 从错误中恢复输出和 `Full output: <path>` 指针，对可用完整输出应用被剥离的（视图）提取器，抛出错误，消息为投影文本后跟保留退出码和完整输出路径的括号注释

无会话扫描。错误路径：抛出的错误无法携带 `details`，因此错误路径上不发布 `piToolGuard` 契约——这是已记录的局限性。

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
  noop?: boolean;            // 投影未改变输出（仅内联投影）
  slow?: boolean;            // 清洗后命令运行 ≥ 10秒；仅慢速运行展示 guard UI
}
```

- `outcome: "projection-applied"` — `content` 是用户的投影视图，作为回退应用。guard **始终保留** `details.fullOutputPath`/`truncation`（使 reducer 仍能归档完整日志），并将路径镜像为 `piToolGuard.sourcePath`。当 pi 未截断但 guard 持久化了自己的慢速日志时，guard 还会将该 `pi-bash-guard-*.log` 路径发布为 `details.fullOutputPath`。SoL-Pi 的 reducer 会读取 `fullOutputPath`，缩减完整日志，并用收据覆盖 guard 的投影。
- `outcome: "full-output"` — `content` 是剥离后命令的完整输出，保留 `details.fullOutputPath`。当慢速命令的完整输出无法持久化（文件系统错误）且 pi 未截断时，也作为回退结果返回完整输出而非投影。
- `slow` — 可选布尔值；`true` 表示清洗后的命令运行至少 `FAST_THRESHOLD_MS`。仅慢速运行会展示 guard UI（通知、页脚状态、收据）；快速命令与内置 bash 工具完全一致。
- 未剥离提取器 → 无记录；`details` 保持不变。

该契约是增量式且版本化的。使用者必须通过 `readPiToolGuardDetails`（从 `contract.ts` 导出）解析，并在遇到未知版本时回退到内联内容。

## 开发

```bash
pnpm install
pnpm test        # 运行所有测试
pnpm typecheck   # 类型检查
```

## 许可证

MIT
