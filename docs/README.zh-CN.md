# pi-tool-guard

[English](../README.md) | 简体中文

<p align="center">
  <img src="https://raw.githubusercontent.com/tychenjiajun/pi-tool-guard/main/assets/preview.png" alt="pi-tool-guard 让昂贵的 bash 命令只跑一次，把完整日志留在磁盘上，只返回模型所要的 head/tail/grep 投影" width="880">
</p>

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![npm](https://img.shields.io/npm/v/pi-tool-guard.svg)](https://www.npmjs.com/package/pi-tool-guard)
[![Release](https://img.shields.io/github/v/release/tychenjiajun/pi-tool-guard)](https://github.com/tychenjiajun/pi-tool-guard/releases/latest)
[![pi extension](https://img.shields.io/badge/pi-extension-7c3aed.svg)](https://pi.dev/docs/latest/extensions)
[![pi package](https://img.shields.io/badge/pi-package-7c3aed.svg)](https://pi.dev/docs/latest/packages)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](../tsconfig.json)
[![Tests](https://img.shields.io/badge/tests-268%20passing-brightgreen.svg)](../package.json)
[![CI](https://github.com/tychenjiajun/pi-tool-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/tychenjiajun/pi-tool-guard/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/pi-tool-guard.svg)](https://www.npmjs.com/package/pi-tool-guard)
[![pnpm](https://img.shields.io/badge/package%20manager-pnpm-f69220.svg)](https://pnpm.io)

> **一句话：** *pi-tool-guard 给每次工具调用两次机会——一条要跑几分钟的命令
> **只跑一次**并留住完整日志，从此不必为了看另一段而重跑；一次参数名写错的
> 调用会被改写，从此不会失败。*

**安装：** `pi install npm:pi-tool-guard` —— 在
[pi.dev 包画廊](https://pi.dev/packages/pi-tool-guard)与
[pi 包文档](https://pi.dev/docs/latest/packages)中可见。

**pi-tool-guard** 是一个开源（MIT）、TypeScript 编写的
[pi](https://github.com/earendil-works/pi) AI 编码代理扩展。它给每个会话带来两个
独立、同样重要的价值：

| # | 故障 | guard 做什么 |
|---|---|---|
| **1. 昂贵的命令** | 一次 `vitest` 要跑几分钟，同一行反复输出；你只想看其中几项测试的结果，为此重跑纯属浪费。 | 清洗后的命令**只跑一次**，留住完整日志，只返回所要的 `head`/`tail`/`grep` 视图，并告知去读日志而不是重跑。 |
| **2. 写错的参数** | 模型知道要做什么，却猜错了字段名——`file`、`old_str`、`contents`、顶层的 `oldText`——调用在执行前就被拒绝。 | 在 **schema 校验之前**把参数改写成标准字段名——不报错、不重试。 |

## 价值一 —— 慢命令只跑一次，之后读它的日志

`vitest` 是最典型的场景：几分钟的逐测试重复输出，而真正想要的只是其中几项结果。

```bash
# 模型写的是
npx vitest run 2>&1 | grep -E '✓|×|FAIL' | tail -40

# guard 只跑一次 `npx vitest run`，把每一行留在
# pi-bash-guard-<hex>.log，只返回匹配的 40 行。
# 还想看另一段？grep 日志即可——几分钟的测试套件永不重跑。
```

pi 内置的 bash 工具只有在结果超过 50 KB / 2000 行时才会保留完整输出文件——而且
一个 `grep`/`head` 视图仍可能藏住它没有选中的行。guard 会为每一条被它投影的慢
命令保留完整日志：

| 步骤 | guard 做什么 |
|---|---|
| **1. 只跑一次** | 清洗后的命令只执行一次。 |
| **2. 留住日志** | 完整的、未提取的输出写入 OS 临时目录的 `pi-bash-guard-<hex>.log`——即使 pi 本不会截断。 |
| **3. 返回视图** | 模型得到的正是它所要求的那段 `head`/`tail`/`grep` 投影。 |
| **4. 读，而不是重跑** | **完整输出回读**通知内联路径，并告知按需读取——`read` 工具配合 offset/limit，或 `sed -n 'START,ENDp' <path>`——而不是重跑命令。 |

省下的是墙钟时间，不只是 token：agent 可以翻阅或 grep 一份跑完的批处理日志，
而不必再付一次费用。guard 从不伪造缓存结果——新的调用仍会执行命令——但被持久化
的日志让重跑变得没有必要，这正是重点。这和批处理作业是同一笔交易：提交一次，
然后读日志。

## 价值二 —— 写错的调用照样能跑通

模型很少一次就把 schema 写对。`file` 当成 `path`、`old_str` 当成 `oldText`、
`contents` 当成 `content`，或者用简写 `{ oldText, newText }` 而不是
`{ edits: [...] }`——这些都是合理的猜测，而 pi 在每个扩展看到调用之前就拒绝了
它们。

```jsonc
// 模型发送
{ "file": "src/app.ts", "old_str": "foo", "new_str": "bar" }
// guard 校验并运行
{ "path": "src/app.ts", "edits": [{ "oldText": "foo", "newText": "bar" }] }
```

这一个例子背后，是 `edit`、`write`、`read` 三套真实的别名映射，外加三种形态修复：
顶层的 `oldText`/`newText`（或其别名）会被包进 `edits`，JSON 字符串形式的
`edits` 会被解析，`read` 上字符串型的 `offset`/`limit` 会被转成数字。无需重新
提示、无需重试、不会出现 `Error: invalid arguments`。只要模型能发起调用，guard
就让它通过。

两个价值指向同一件事：模型应该把回合花在任务上，而不是重跑昂贵命令、或反复改写
一个被拒绝的工具调用。

## 安装

```bash
# 来自 npm（推荐）
pi install npm:pi-tool-guard

# 来自 git
pi install git:github.com/tychenjiajun/pi-tool-guard

# 来自本地检出
pi install ./pi-tool-guard

# 仅在本次会话试用，不写入 settings
pi -e npm:pi-tool-guard
```

扩展通过公开的 `registerTool` API 覆盖内置工具定义，因此没有需要从 pi 卸载的
东西，也没有任何配置。`pi list` 查看已配置的包；`pi remove <source>` 移除。

## 它做什么

两个独立守卫，都会在会话启动时自动安装：

| 守卫 | 工具 | 触发条件 | 效果 |
|---|---|---|---|
| **参数别名规范化** | `edit`、`write`、`read` | 别名字段名、顶层 `oldText`/`newText`、JSON 字符串形式的 `edits`、字符串型 `offset`/`limit` | 通过 `prepareArguments` 原地重写参数，发生在 schema 校验之前 |
| **Bash 管道投影** | `bash` | 尾部的**视图提取器**（`head`、`tail`、`grep`、`rg`……） | 运行清洗后的命令，重新应用视图，并把完整输出留在磁盘上 |

## 之前 → 之后

<img src="https://raw.githubusercontent.com/tychenjiajun/pi-tool-guard/main/assets/demo.gif" alt="演示：没有 guard 时，几分钟的 vitest 套件为了看另一段输出而重跑；有 guard 时它只跑一次、留住完整日志，后续切片即刻读取" width="880">

**别名修复**——不报错、不重试：

```jsonc
// 模型发送
{ "file": "src/app.ts", "old_str": "foo", "new_str": "bar" }
// guard 校验并运行
{ "path": "src/app.ts", "edits": [{ "oldText": "foo", "newText": "bar" }] }
```

**Bash 投影**——模型保留它的管道，上下文不再为它付费：

```bash
# 模型写的是
npm test 2>&1 | grep -E 'FAIL|Tests' | tail -5

# guard 运行后只返回
Tests  12 failed | 4 passed (16)
```

**慢速命令会得到 guard 收据**，取代 pi 那行不透明的 `Took`：

```
🛡 pi-tool-guard · grep FAIL | head -5
   Context saved · 1,234 → 20 lines · 98% smaller · 19 KiB saved
   Took 6.5s  ██████████████░░░░  cmd 5.0s · filter 1.5s
```

进度条按比例绘制——accent `█` 表示清洗后的命令，warning `░` 表示 guard 的
提取器。快速命令完全不变，与内置 bash 工具一模一样。

## 实测效果

以下数据测量自本地 pi 会话中带 guard 戳记的结果（38 个项目、2264 次受控 bash
调用）：

| 指标 | 数值 |
|---|---|
| 应用的投影 | **2235**（98.7%） |
| 回退为完整输出 | 29 |
| 投影的输出行数 | **102,966 → 42,105，减少 59%** |
| 投影的输出字节数 | **6.56 MB → 2.91 MB，缩小 56%** |
| 提取器耗时中位数 | **+33 ms**（p90 +73 ms） |
| 展示收据的慢速运行 | 344 |
| 无声空操作（无 UI、内容未变） | 1092 |
| 附加的完整输出回读通知 | 293 |

最常见的被剥离管道是 `head -40`、`head -20`、`head -30`、`tail -20` 和
`grep -v node_modules`；单次最大投影把一份 **1462 行**的日志压到模型所要的
**20 行**。guard 从不删除任何一个字节：每条被投影的慢命令都会保留一份完整批处理
日志，不受 pi 截断限制约束，因此 agent 可以重读一次已完成运行的任意片段，而不必
再付一次费用。

## 参数别名规范化

字段别名由覆盖后的 `edit`/`write`/`read` 定义上的 `prepareArguments` **原地**
重命名——这是 pi 扩展做参数纠正最干净的模式，发生在 pi 的 schema 校验之前。
除简单的键重命名外，还修复三种形态：

- **顶层简写**：`{ oldText, newText }`（或其别名）会包装成
  `{ edits: [{ oldText, newText }] }`。
- **JSON 字符串 edits**：以字符串给出的 `edits` 会被解析为数组。
- **`read` 类型转换**：字符串型 `offset` / `limit` 转为整数。

| 工具 | 标准字段 | 接受的别名 |
|---|---|---|
| `edit` | `path` | `file`、`filePath`、`file_path`、`target`、`filename`、`file_name` |
| `edit` | `edits[].oldText` | `old_str`、`old_string`、`old_text`、`oldStr`、`oldString`、`oldContent`、`old_content`、`old`、`original`、`search` |
| `edit` | `edits[].newText` | `new_str`、`new_string`、`new_text`、`newStr`、`newString`、`newContent`、`new_content`、`new`、`replacement`、`replace` |
| `write` | `path` | `file`、`filePath`、`file_path`、`target`、`filename`、`file_name` |
| `write` | `content` | `text`、`body`、`code`、`data`、`fileContent`、`file_content`、`contents` |
| `read` | `path` | `file`、`filePath`、`file_path`、`target`、`filename`、`file_name` |
| `read` | `offset` | `start`、`startLine`、`start_line`、`from`、`line` |
| `read` | `limit` | `lines`、`maxLines`、`max_lines`、`count`、`numLines`、`num_lines` |

## Bash 管道投影

bash 命令借助 [unbash](https://github.com/nicolo-ribaudo/unbash) 解析，尾部管道
被归类为**视图**或**转换**：

| 类别 | 命令 | 行为 |
|---|---|---|
| **视图**（剥离） | `head`、`tail`、`grep`、`egrep`、`fgrep`、`rg`、`less`、`more` | 移除后由 guard 对完整输出重新应用 |
| **转换**（保留） | `sed`、`awk`、`cut`、`sort`、`uniq`、`wc`、`column`、`jq`、`yq`、`tr` | 留在命令中；shell 应用它，guard 不插手 |

只剥离视图提取器：`npm test | grep FAIL | head -5` 变为 `npm test`，guard 自己
重新应用 `grep FAIL | head -5`。剥离发生在 `execute`（而非 `prepareArguments`），
因此 `tool_result.input.command` 保留用户真正写下的命令。

### 多语句安全（外提）

仅当尾部视图的 stdout 就是整条命令的 stdout 时才尝试剥离。窗口周围的语句会被
**外提（hoist）**到临时旁路 sink（`{ <text>\n} >> '<sink>' 2>&1`），让 shell
逐字节保留它们，再由 guard 把这段文本接回投影前后：

```bash
cd x && echo "=== build ===" && npm test | tail -12
# →
cd x && { echo "=== build ==="
} >> '<sink>' 2>&1 && npm test
```

可证明**静默的前缀**（`cd`、裸赋值、`true`、`:`、`test`、`[`，且无重定向）完全
不需要 sink。无法保证保真时 guard 会保持命令原样：

- 自带提取器的语句（`a | head && b | tail`）；
- **后台化**的最终语句（`… &`）——切掉视图会同时丢掉 `&`，把作业悄悄前台化；
- 含 **here-document** 的命令（其正文位于语句跨度之外）；
- 读取 `$?`、`${?}` 或 `PIPESTATUS` 的尾部语句——被移除的视图不再是管道的最后
  一条命令，guard 宁可整条透传，也不输出错误状态：

  ```bash
  printf 'a\n' | grep nomatch; echo "R=$?"   # bash 输出 R=1；剥离后会输出 R=0
  ```

### 退出码与空输出

提取器退出码会透传，与 pi 自身的 `cmd | extractor` 行为一致：
`cmd | grep no-match` 会以 `Command exited with code 1` 失败，而不是返回空成功。
这只在提取器是命令最后一条命令时成立；若后面还有语句
（`cmd | grep x; echo done`），bash 以*那条*语句的状态退出，因此 guard 返回投影
而不抛错。空的内联投影渲染为 `(no output)`，与 pi 自身的空结果渲染一致。

pi 的 bash 从不因非零退出抛错（pi ≥ 0.99）：它以 `isError: true` 返回，内容末尾
追加 `Command exited with code N`。该状态属于*清洗后的*命令，因此 guard 会在视图
读取输出前把它剥离，并报告**视图**的退出码——与 pi 自己对 `cmd | view` 的语义
一致。当没有东西可以重新裁定时（窗口后还有语句，或视图根本没运行），状态行与
`isError` 标志按 pi 给出的原样保留。pi bash `outputSchema` 的 `structuredContent`
会被围绕投影重新盖章（`output`、`exit_code`、`wall_time_seconds`）而非丢弃；
`truncated`/`full_output_path` 仍指向未投影的完整日志。

### 快速与慢速路径

| 命令 | 行为 |
|---|---|
| **快速**（< 10 秒） | 运行清洗后的命令，把视图应用到 pi 格式化后的结果上，返回投影。**无通知、无收据——与内置 bash 工具视觉上完全一致。** |
| **慢速**（≥ 10 秒） | 把完整的、未提取的输出持久化到 OS 临时目录的 `pi-bash-guard-<hex>.log`，应用视图，返回投影，并附加一条**完整输出回读**通知（内联路径）。 |

即使 pi 自身没有截断，慢速日志也会存在；其 `pi-bash-guard-*.log` 名称——作为
`details.fullOutputPath` 发布——让它可被
[SoL-Pi](https://github.com/NVlabs/SoL-Pi) 的证据保留 reducer 读取。超过 24 小时
（`FULL_OUTPUT_TTL_MS`）的日志会在后续持久化时尽力清除。若持久化失败且 pi 未
截断，guard 回退为返回完整输出而非投影，以免通知产生误导。

### 无声空操作

当应用提取器后输出没有任何变化时（例如对 2 行结果执行 `tail -20`），guard 不显示
通知也不渲染收据——保留 pi 原始的 `Took` 行。空操作检测仅针对内联（非截断）
投影计算。

## 互操作：`details.piToolGuard`

当 guard 剥离提取器时，会在 `details.piToolGuard` 上打上版本化记录，便于其他
`tool_result` 处理器——尤其是 SoL-Pi 的证据保留 reducer——判断可见内容的真实
含义：

```ts
interface PiToolGuardDetails {
  version: 1;
  originalCommand: string;   // 例如 "npm test | tail -20"
  cleanedCommand: string;    // 例如 "npm test"
  removed: string[];         // 例如 ["tail"]
  removedPipeline: string;   // 例如 "tail -20"
  outcome: "projection-applied" | "full-output";
  sourcePath?: string;       // pi 生成时，未截断输出的路径
  timing?: {                 // 分阶段墙钟耗时
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
  slow?: boolean;            // 清洗后命令运行 ≥ 10 秒；仅慢速运行展示 guard UI
}
```

- `outcome: "projection-applied"` — `content` 是用户的投影视图，作为回退应用。
  guard **始终保留** `details.fullOutputPath` / `truncation`，并把路径镜像为
  `piToolGuard.sourcePath`，使下游 reducer 能读取精确的完整日志、用自己的收据
  覆盖 guard 的投影。
- `outcome: "full-output"` — `content` 是清洗后命令的完整输出，保留
  `details.fullOutputPath`。当慢速命令的完整输出无法持久化且 pi 未截断时，也作为
  回退结果。
- `slow` — 清洗后的命令运行至少 `FAST_THRESHOLD_MS` 时为 `true`。仅慢速运行会
  展示 guard UI（通知、页脚状态、收据）。
- 未剥离提取器 → 无记录；`details` 保持不变。
- **错误路径**（非零退出）无法携带 `details`，因此不发布契约——这是已记录的
  局限性。

契约是增量式且版本化的。使用者必须通过 `readPiToolGuardDetails`（从
`contract.ts` 导出）解析，并在遇到未知版本时回退到内联内容。

## 架构

```
index.ts       扩展入口；注册 edit/write/read/bash 覆盖
aliases.ts     edit / write / read 的参数规范化
pipeline.ts    基于 unbash 的 bash 解析与提取器剥离
execute.ts     核心 bash 执行：剥离、运行、投影、持久化、通知
contract.ts    版本化的 details.piToolGuard 互操作契约
bash.ts        提取器运行器 + 通知构建
timing.ts      时长格式化与比例进度条拆分
format.ts      纯文本测量、节省量/计数/字节格式化
render.ts      用 guard 收据替换 pi 的尾部 Took 行
tui.ts         SoL-Pi 风格收据组件与瞬态页脚状态
```

Bash 流程：

1. `execute` 解析命令并剥离尾部**视图**提取器，外提必须保留的非静默语句。
2. 清洗后的命令通过原始内置 execute 运行。
3. 快速 + 已截断 → 通过 `pi.exec` 对 pi 的完整输出文件运行提取器。快速 + 内联 →
   将结果通过管道传给提取器。
4. 慢速 → 持久化完整的、未提取的输出，投影，并附加完整输出回读通知。
5. 非零退出 → pi 以 `isError` 结果返回，内容末尾是
   `Command exited with code N`（它从不因退出码抛错）。guard 剥离该状态、应用视图，
   并报告**视图**的退出码——与 pi 自身对 `cmd | view` 的语义一致。*视图*非零会抛出
   携带投影与 `[Command exited with code N. Full output: <path>]` 的错误；
   不带退出码的抛出错误（超时/中止）原样重抛。

## 兼容性与局限性

以下都是有意为之、已记录的行为，并非缺陷：

- **快速路径合并 stderr。** guard 投影前 pi 会合并 stdout 与 stderr，因此被剥离
  的 `grep`/`head` 也会过滤 stderr 行；真实 shell 管道不会这样。guard 会修剪投影
  的尾部空白。
- **实时流。** 快速运行期间 pi 的 `onUpdate` 流显示清洗后命令的未过滤输出；只有
  返回的内容是投影。
- **错误路径无契约。** 抛出的错误无法携带 `details`。
- **退出状态跟随视图。** 失败命令的 `Command exited with code N` 行在投影前被剥离；
  结果报告视图的退出码，与原生 `cmd | view` 管道一致。窗口后还有语句时，状态按
  pi 写入的原样保留。
- **`structuredContent` 被重新盖章而非丢弃。** bash `outputSchema` 载荷保留
  `truncated`/`full_output_path`（未投影的完整日志），并取投影后的 `output`、
  视图的 `exit_code` 与整个受守护运行的 `wall_time_seconds`。
- **转换提取器永不剥离。** `sed`、`awk`、`jq`、`sort`…… 有意留在命令里。
- **不扫描会话、不重放。** 每次调用都重新执行命令；guard 从不返回缓存结果。

## 常见问题

### pi-tool-guard 安全吗？

安全。guard 只重写工具的*参数*，并*重新应用模型本就要执行的 shell
命令*。它从不凭空造命令，从不运行模型没写的东西，也从不删除输出——慢速运行的
完整日志始终被持久化。

### 它会替换 pi 的内置工具吗？

它用一个很小的 `prepareArguments` / `execute`
垫片重新注册工具定义，保留原始 schema 与行为。禁用扩展，内置工具不受影响。

**为什么剥离 `head`/`tail`/`grep` 而不剥离 `sed`/`jq`？** 视图提取器只*过滤*
流，因此移除并重新应用是无损的。转换提取器*改变*数据，剥离它会悄悄丢掉转换。
guard 把它们留给 shell。

**模型没要的那部分输出去哪了？** 快速命令中它从未离开进程。慢速命令中它被写入
`pi-bash-guard-<hex>.log`，并由完整输出回读通知指向，模型可以按需 `read`，而
不是重跑昂贵命令。

### 这和 pi 内置的 `fullOutputPath` 有什么区别？

pi 只在结果大到需要截断时才写
这个文件。一条被投影的慢命令——比如 `npm run build | grep error`，完整输出仍不足
50 KB——原本就完全没有完整日志。guard 会为每一条被它投影的慢命令写一份，因此未
投影的输出始终可读。（没有视图的慢命令会直接透传；模型本就看到了它的完整输出，
超大的情形由 pi 的截断文件覆盖。）

**能与其他扩展共存吗？** 可以——它发布 `details.piToolGuard`，让 SoL-Pi 的证据
保留 reducer 等下游消费者互操作；它从不扫描会话，也不改动其他工具。

### 需要配置吗？

不需要。装上即用。`FAST_THRESHOLD_MS`（10 秒）与
`FULL_OUTPUT_TTL_MS`（24 小时）是目前仅有的两个内部常量。

## 相关 pi 扩展

- [pi-codemode-guard](https://github.com/tychenjiajun/pi-codemode-guard) —— 在脚本
  进入沙箱前编译 LLM 编写的 codemode 脚本。
- [pi-codemode-snippets](https://github.com/tychenjiajun/pi-codemode-snippets) ——
  把一个带 `// @snippet:` 的 `.js` 文件变成具名、可组合的 pi 工具。
- [pi-skill-guard](https://github.com/tychenjiajun/pi-skill-guard) —— 守护技能的
  加载与调用。
- [pi-voice](https://github.com/tychenjiajun/pi-voice) —— pi 的语音输入。
- [SoL-Pi](https://github.com/NVlabs/SoL-Pi) —— 证据保留的上下文缩减；读取本扩展
  的 `details.piToolGuard` 契约。

## 开发

```bash
pnpm install
pnpm test        # 268 个单元测试
pnpm typecheck
pi -e .          # 把本检出作为扩展加载，仅本次会话
```

架构与设计说明见 [`AGENTS.md`](../AGENTS.md) 与 [`CONTEXT.md`](../CONTEXT.md)。pi
官方文档：[扩展](https://pi.dev/docs/latest/extensions) ·
[Pi 包](https://pi.dev/docs/latest/packages)。

## 许可证

MIT
