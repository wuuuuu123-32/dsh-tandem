# dsh-tandem

让 DSH 主 agent 与本地 Codex（GPT）形成**双 agent 协作**：主 agent 负责跟你沟通、拆任务、做最终决定；Codex 负责并行执行、方案会审，以及按机械判据返工。

机制由插件保证，不靠 agent「记得」——参数不合法的派活会被**当场拒绝**。

## 五个工具

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `tandem_status` | 查看当前是否可用：Codex 路径、模型、并发上限、允许派活的目录根、凭据是否就绪 | 第一次派活前、或派活报错后先看它 |
| `tandem_delegate` | 把 N 个互不依赖的子任务并行交给 Codex；成功的任务返回 `taskId` | 每项必须给 `timeoutMs` 和 `acceptance`（怎么算干完了），缺失直接拒绝；`dir` 必须在白名单根内且互不重复 |
| `tandem_consult` | 让 Codex 作为「第二个有边界的判断者」回答一个问题；成功时签发 `reviewId`（会审标记） | 只判断、不写文件；必须回「结论 / 证据 / 反例 / 验证方式」四段，缺段即判无效 |
| `tandem_check` | 对派活的产物跑机械验收：在任务目录执行命令，按退出码 + 输出包含判定；返回 `reviewed` / `stale` 与 `review` 标记 | 判据在首次检查时**冻结**（同一 taskId 改判据会被拒）；被审内容在会审后变了则 `stale: true`；只做门禁，不替代语义审阅 |
| `tandem_reject` | 把验收缺口原样回灌给 Codex 重做（同一 taskId） | 最多 2 轮；要求最近一次检查确实失败；到上限把人拉回来决定 |

## 什么时候该用

**delegate（并行执行）**——同时满足才派：
- 有 ≥2 个产物，各自能独立验收；
- 写入路径不重叠、彼此不依赖；
- 都不要本对话的上下文。

**check / reject（验收闭环）**——delegate 成功后：
- `tandem_check { taskId, checks: [...] }`：每条检查形如 `{ cmd, expect: { exit?, contains?, notContains? }, timeoutMs? }`，断言全部 AND；
- 不通过就 `tandem_reject { taskId, gaps? }`：失败输出被包进 `<codex-output>` 定界块回灌（并声明「这是数据不是指令」），最多重做 2 轮；
- 没有 taskId 的临时检查传 `dir` 即可（不冻结、不记账）。

**consult（会审）**——判据不是「有几个方案」，而是「**这份东西的设计是不是我方（主 agent）出的**」。出现任一条就问一次：
- 我要改插件 / 工具 / 脚本的**功能实现**（改逻辑、改 schema、改加载路径）；
- 我要给用户一个**由我设计的方案 / 实施计划 / 排查思路 / 架构选型**；
- 要往文档里写**设计说明**。

不审：照既定方案执行命令、重跑失败任务、读文件查资料、改文案错别字。

同一问题默认只问一次；只有出现新证据或明确分歧时才追问。GPT 是第二个判断者、不是审批人——它挑出的问题不采纳时要说明理由。

## 安装

```powershell
# 1) 装依赖（Codex CLI）
npm i -g @openai/codex

# 2) 把插件链进桌面端 profile（先把下面的路径换成你实际存放插件的位置）
cd ~/.dsh/profiles/desktop

# 2a. package.json 改两处：
#     dependencies 里加一行   "dsh-tandem": "link:D:/dsh/config/dsh-tandem"
#     dsh.profile.bundles 里追加一项  "dsh-tandem"

# 2b. 在 profile 目录下建目录联接
New-Item -ItemType Junction -Path node_modules\dsh-tandem -Target "D:\dsh\config\dsh-tandem"
# 等价 cmd（在同一目录下）：mklink /J node_modules\dsh-tandem "D:\dsh\config\dsh-tandem"

# 3) 重启 DSH（插件在启动时加载，热重载不会加载新插件）
```

## 配置

默认值 → `~/.dsh/tandem.json` → 插件 config，后者覆盖前者。见 `config.example.json`。

```json
{
  "codexCommand": "codex",
  "model": "gpt-6.1-sol",
  "maxParallel": 3,
  "workRoots": ["D:/dsh/work"],
  "taskTimeoutMs": 300000,
  "requireCompletionMarker": true,
  "stateDir": "D:/dsh/config/dsh-tandem/state",
  "envKey": "PORTDAN_API_KEY"
}
```

- `codexCommand`：留 `codex` 即可，插件会自动探测 npm 全局安装位置，并优先用 `.exe`（Windows 下 spawn `.cmd` 需要额外包一层 cmd.exe）。
- `workRoots`：允许派活的**目录白名单**——插件会拒绝工作根之外的 `dir`、互相包含或重复的 `dir`。注意它限制的是「任务从哪儿起步」，不是文件写入范围：Codex 以 `danger-full-access` 运行（Windows 沙箱实测会把 `workspace-write` 静默降级成只读，改不了文件），所以白名单挡得住手滑与误配，挡不住任务提示词里明目张胆的越界写入。要真正限制写入，得在 `checks` 里自己核验产物路径。
- `maxParallel`：**上限 3**，实测超过 3 会被上游挂住。
- `requireCompletionMarker`：默认 `true`。Codex 退出码 0 之后，还会检查日志里有没有它固定打印的 `tokens used` 完成标记，没有就判「空跑」并按失败重派。实测过同一份 prompt 一次 37 秒空跑（退出码 0、一个文件没改）、一次 117 秒正常改完，光看退出码分不出来。这是人类可读输出、不是稳定接口，换版本后若失效就设成 `false`。
  - 0.163 的结尾格式变了（2026-10-18 实测）：`tokens used` 之后还有一段**重复的最后消息**，所以匹配允许标记后跟最多 4000 字符收尾文本，仍锚定日志末尾。

## 验收闭环（v0.2.0）

`tandem_delegate` 成功的任务会返回一个 `taskId`，后续验收就是围绕它走：

```
delegate 成功 → taskId 写进票据（<stateDir>/tickets.json）
tandem_check { taskId, checks }   ← 首次调用冻结判据（checks 的哈希）
   ├─ 全部通过 → 结束
   └─ 有失败   → tandem_reject { taskId, gaps? }（最多 2 轮）
                    └─ 重做成功后 lastCheck 清空，再 check
```

**判据冻结**：同一 taskId 只有第一次 `tandem_check` 能定义 `checks`，之后传不同判据会被拒绝。这是为了防止「跑完发现没过、回头把验收条件改松」——会审明确指出这是最容易被钻的空子。

**明确的能力边界**（也是会审要求写清的）：
- 插件只提供**执行器**，不提供独立 oracle；`checks` 由主 agent 写，语义验收仍由主 agent 负责；
- 不防「Codex 改测试文件/测试脚本」——那只能靠对 diff 的代码审阅；
- 轮次上限按 taskId 计数，防的是同一任务无限循环，**不是安全边界**（新开任务会重置）。

## 会审标记 reviewId（v0.3.0）

`tandem_consult` 成功（Codex 真回了有效四段答案）时，插件在**本进程内**随机签发一个 `reviewId`（`rv-` + 16 位十六进制），并记下这次会审覆盖的路径。

它标的是**内容**，不是使用配额：

- 同一个 `reviewId` 可以在它覆盖的路径上反复派活、反复检查——没有「一次只能开一个新任务」这种限制；
- 下次改动不带标记，验收结果就是 `reviewed: false`，明摆着「这段没经过独立复核」；
- 模型自己编的 id 查不到（`tandem_delegate` 当场拒绝），因为它不在 `reviews.jsonl` 里。

```text
tandem_consult { mode: "review", question: "...", paths: ["D:/dsh/config/dsh-tandem"] }
→ { ok: true, reviewId: "rv-1a2b3c4d5e6f7a8b", reviewedPaths: [...] }

tandem_delegate { tasks: [...], reviewId: "rv-1a2b3c4d5e6f7a8b" }
→ 票据带上标记；tandem_check 返回 reviewed: true 和 review 摘要
```

**标记会过期。** 签发时同时记下被审路径的内容指纹（源码文件内容 sha1，最多 300 个 / 单文件 1MB 以上退回大小+时间）。之后这些文件被改动，`tandem_check` 就把 `reviewed` 翻成 `false`、给出 `stale: true` 和一句说明——标的是内容，内容变了标记就该失效（盲审指出的假信号：只绑路径的话，换了内容它照样说「审过」）。验收本身照跑，只是不再声称「这段审过」。

指纹只算 `CODE_EXT` 里的扩展名（`.js .mjs .cjs .ts .tsx .jsx .json .md .yml .yaml .py .rs .go .toml .css .html .sh`）。一个目录里没有这类文件时指纹恒定——那种情况下它什么也判断不了，别指望它。

落盘：`<stateDir>/reviews.jsonl`（一行一条，只追加）。轮转保留最近 200 条，且**被票据引用的凭证不会被清掉**——否则证据链会在某次清理后突然断掉。覆盖路径与任务目录不符只提示、不阻断。

边界：这仍然只是**标记**。它证明「有人独立审过」，不证明「审得对」；`reviews.jsonl` 能被手工改写（本机信任模型）。

## 会审闸：让「改了没审」自己冒出来（v0.4.x）

前面的 `reviewId` 是**自愿**机制——agent 自己要带上标记。实测的失效方式很朴素：主 agent 一口气改完代码、直接回复用户，全程没想起会审，而任何人（包括用户）当场都看不出来。

会审闸把这件事改成插件负责：**每个会话维护一份改动账本，未经会审的改动会在提醒、拦截、留痕三个位置自己暴露。**

| 位置 | 干什么 |
|---|---|
| `fs/write-intent` / `fs/edit-intent` | **记账**。任何走 DSH fs 服务的写入 / 编辑都记下绝对路径，PTC 嵌套调用里的写操作同样经过这条线。这是主数据源——不从工具参数里猜路径 |
| `tools/post-execute` | **提醒**。未审文件数到阈值就注入一条 user 消息（`source.kind = "dsh-tandem"`，不会被当成真人发言），点名具体文件 |
| `tools/pre-execute` | **拦截**。`present` 在还有未审改动时被拒一次，带机器可读的 `code: "REVIEW_REQUIRED"` |

配置（`config.example.json` 里都有）：

```json
{
  "reviewGuard": true,
  "reviewGuardFirst": 2,
  "reviewGuardEvery": 4,
  "reviewGuardGate": "deny"
}
```

`reviewGuardFirst` 是第一次提醒的未审文件数（**不是等到第 3 个**——第一次出现未审改动就该说话），之后按 `reviewGuardEvery` 递增再提醒。`reviewGuardGate` 设成 `"off"` 则只提醒、不拦 `present`。

**闸只拦一次，但放行不沉默。** 第二次 `present` 放行——否则 agent 重试一下就永远交付不出去，闸会变成死锁而不是约束。代价是「拦一次」本身拦不住决心要交付的人，所以放行时补两件事：

- 往对话里注入一条明示「这次交付含 N 个未经会审的改动」，让这件事出现在用户眼前，而不是烂在插件内部；
- 往 `<stateDir>/deliveries.jsonl` 落一条 `{at, session, action, count, files}`，事后可查。

**重启不洗白。** 账本落盘在 `<stateDir>/ledger.jsonl`（一行 `{path, t}`，超过 400 行压到最近 200 条），插件启动时读回。DSH 重启一次就把未审状态清零，是这套机制最容易被打穿的地方——重启后一样拦得住、一样认那次已经发生过的会审。

### 判定规则

每个改动文件取 `t = max(记账时刻, 当前 mtime)`；从最新的会审记录往前扫，找到一条 `at > t` 且覆盖该路径的会审就算已审，扫到 `at <= t` 就停。

两个后果值得写清：**旧会审清不掉新改动**（时间条件天然挡住「拿一个月前的会审复用」）；**用 `utimesSync` 之类绕过 fs 钩子改 mtime 也会被重新判成未审**（mtime 越过会审时间即重新变脏）。

### 能力边界

- 只跟踪代码类扩展名（与 `reviewId` 的指纹用同一份 `CODE_EXT`：`.js .mjs .cjs .ts .tsx .jsx .json .md .yml .yaml .py .rs .go .toml .css .html .sh`），并跳过 `node_modules`、`.git`、`dist`、`build` 等目录段。只排除**插件自己的 stateDir**，别的同名目录照常记账（一刀切排除 `state` 目录段会让「改动正好落在这种目录下」变成直接绕过，会审挑出过这条）。
- 相对路径直接跳过：判不出它属于哪个工作目录，猜错会留下永远清不掉的假条目。fs 意图给的本来就是绝对路径。
- 路径是**词法**比较（`resolve` + win32 小写），不解析符号链接 / junction / subst 盘符 / UNC 别名。同一目录换个写法会被当成不同路径，方向是「多记账」而不是「漏记账」（`.jsonl` 本来就不在跟踪扩展名里，实际影响为零）。
- 它只知道「有没有一次成功会审覆盖了这个文件」，判断不了「审得够不够」。
- `present` 不是唯一的交付路径——结论直接写在回复里就不经过它。闸只能覆盖走 `present` 的交付。
- 账本文件能被手工改写（本机信任模型，与会审标记同一条边界）。
- 文件被删掉后从账本摘除（记账 10 秒后生效，窗口内可能短暂误报，取的是保守方向）。

## 会审失败 ≠ 没有意见

`tandem_consult` 不是「问了就有答案」。它失败时会给出 `reason` 和 `hint` 两个字段，**那不是在说「没问题」**：

| reason | 含义 | 该做什么 |
|---|---|---|
| `policy_blocked` | 上游内容策略拦下了提示词 | 改写措辞（去掉可能触发的技术细节）后重试一次 |
| `auth_failed` / `model_not_found` | 凭据或模型名不对 | 先跑 `tandem_status` 核对 |
| `rate_limited` | 上游限流 | 等一会儿，别连发 |
| `empty_response` | 进程正常退出但没产出（空转） | 已自动重试一次；仍空就换个问法 |
| `invalid_answer` | 不是合法 JSON，或缺四段之一 | 原文在 `tail` 里，据此决定要不要重问 |
| `timeout` / `spawn_failed` / `unknown` | 超时、启动失败、未能识别 | 缩小材料 / 查路径 / 读 `tail` |

**规则（写在这里就是把话说死）**：`ok:false` 时不许把它当成「审过了、没意见」继续实施改动。
要么改写措辞重试一次，要么在回复里明写「未获独立复核」并停下来问人。

每一次会审的结果（含失败）都会追加到 `<stateDir>/consult-history.jsonl`，`tandem_status` 的
`lastConsult` 直接显示最近一次的时间 / 是否成功 / 原因 / 尝试次数 —— 「上次到底审成没审成」不再靠记忆。

## 凭据

Codex 需要 `PORTDAN_API_KEY`。插件在**加载时**若发现环境变量缺失，会自动从 `~/.dsh/.credentials.yaml` 的 `refs` 段补齐；`tandem_delegate` / `tandem_consult` 每次执行前还会再补一次（幂等），所以后来才写进凭据文件的情况也能赶上。补不到就在 `tandem_status` 里明确报出来。

## 已知限制

- Codex 非 tty 时输出会被吞，所以日志直接写文件（结果里给日志路径）。
- 「退出码 0」不等于干完活：偶发空跑（进程正常退出、日志只有头部和 prompt、文件没动）。已用完成标记兜住并重派一次，但它只是启发式判定，最终仍要靠 `checks` 自己核验产物。
- 上游缓存命中率不可控（实测 0~80% 波动），同一任务重复跑成本不是线性的。
- 超时按整棵进程树杀，避免 codex 子进程残留。
- `checks` 的命令用 shell 执行，语义随平台而定（Windows 是 `cmd /c`）；总时限到点后剩余检查直接判失败。
- `tandem_consult` 用 `read-only` 沙箱，它物理上改不了文件——这是刻意的。
  代价：Windows 上 `read-only` 沙箱会把**读取也拦住**（`exec_command ... rejected: blocked by policy`，连 cwd 里的文件都读不到），`cwd` 参数因此在本机不起作用。要让 Codex 会审一个真实项目，就把关键文件的内容拼进 `context` 传给它——实测这样效果正常。这个怪癖只在 Windows 的 Codex 沙箱上出现。

### 与 Codex 0.163 的兼容性（2026-10-18）

- **必须 `--disable multi_agent`**：0.163 默认开启多 agent 协作工具，非交互 `exec` 下模型会调用 `collab wait`（等待一个不存在的子线程）然后永久挂起。实测一条 2K 字符的评审 prompt 挂 172 秒无输出；关掉后 27 秒正常返回。
- **必须 `-c mcp_servers={}`**：桌面端配置的 MCP 服务器（node_repl / computer-use）在非交互 exec 里反复启动失败，把一个 12 字节文件的活拖到 90~130 秒；只覆盖本次进程后降到 25 秒，且不改用户的 `~/.codex/config.toml`。

### 一个刻意的取舍：不做「跑完比对哪些文件被改」

只保证**各任务目录互不重叠**（重复、互相包含、越界都拒绝），不做运行前后快照对比。

原因是快照这条路两头都不讨好：并行任务和外部进程都会在同一个审计窗口里改文件，快照只能看到「差异」、看不到「谁改的」，归因错了就是误报；而 `mtime + size` 的粒度还会漏掉同尺寸改写。误报和漏报同时存在时，这个字段只会变成噪音，不如只保证「互不重叠」这个能确定的事实。

真需要知道改了哪些文件，就在 `checks` 里让任务自己 `git status --short` 并把输出写进产物。

## 装不上 / 工具不出现时先看这里

DSH **不写运行日志**，插件加载失败在界面上毫无提示（工具就是静默消失）。本插件在启动时写探针：

```
~/.dsh/tandem-state/load.log
```

正常应当长这样（五个工具各一行 `registered`）：

```
... module evaluated
... apply start, codex=...\codex.exe, tools service=object
... registered tandem_status
... registered tandem_delegate
... registered tandem_consult
... registered tandem_check
... registered tandem_reject
```

- 只有 `module evaluated` → `apply` 没被调用（插件未被激活 / 依赖的 `tools` 服务没起来）。
- 有 `REGISTER FAILED` → 那行后面跟着完整堆栈，是 schema 或定义不合法。

### 两个必须知道的坑（都实际踩过）

1. **不能 import `@deepseek-ai/dsh-tools`**：桌面端 profile 的 `node_modules/@deepseek-ai/` 里没有这个包，import 必失败。插件的 `defineTool` 是自带的 `compileSpec` / `compileParameters`（属性级 `required: true` → 对象节点 `required` 数组）。少了这层编译，`register()` 会抛 `required is not supported on type "boolean"`。
2. **`execute` 的返回值整体就是被校验的 value**：DSH 用 `createSuccessResult(exec, tool, returned)` 直接拿返回值去校验 `output.schema`，渲染才由 `output.render(args, value)` 做。返回 `{ content, structuredContent }` 会报 `missing required property "value.ok"`。

## 自测（不经过 DSH）

```bash
node --check index.js
node --check lib/consult.js
node --check lib/acceptance.js
node --check lib/ledger.js
# 机械验收 + 票据单测（含会审给的反例：echo PASS && exit 1、notContains 假阳性、超时）
node test/acceptance.mjs
# 会审闸单测：账本判定、重启不洗白、交付留痕、三个 hook 的装配
node test/guard.test.mjs
# 假 ctx 走一遍 apply，确认五个工具都注册成功
node -e "import('./index.js').then(m=>{const r=[];m.apply({tools:{register:d=>{r.push(d.name);return()=>{}}}});console.log(r)})"
```
