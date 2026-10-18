# dsh-tandem

让 DSH 主 agent 与本地 Codex（GPT）形成**双 agent 协作**：主 agent 负责跟你沟通、拆任务、做最终决定；Codex 负责并行执行、方案会审，以及按机械判据返工。

机制由插件保证，不靠 agent「记得」——参数不合法的派活会被**当场拒绝**。

## 四个工具

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `tandem_status` | 查看当前是否可用：Codex 路径、模型、并发上限、允许派活的目录根、凭据是否就绪 | 第一次派活前、或派活报错后先看它 |
| `tandem_delegate` | 把 N 个互不依赖的子任务并行交给 Codex；成功的任务返回 `taskId` | 每项必须给 `timeoutMs` 和 `acceptance`（怎么算干完了），缺失直接拒绝；`dir` 必须在白名单根内且互不重复 |
| `tandem_consult` | 让 Codex 作为「第二个有边界的判断者」回答一个问题 | 只判断、不写文件；必须回「结论 / 证据 / 反例 / 验证方式」四段，缺段即判无效 |
| `tandem_check` | 对派活的产物跑机械验收：在任务目录执行命令，按退出码 + 输出包含判定 | 判据在首次检查时**冻结**（同一 taskId 改判据会被拒）；只做门禁，不替代语义审阅 |
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
# 机械验收 + 票据单测（含会审给的反例：echo PASS && exit 1、notContains 假阳性、超时）
node test/acceptance.mjs
# 假 ctx 走一遍 apply，确认五个工具都注册成功
node -e "import('./index.js').then(m=>{const r=[];m.apply({tools:{register:d=>{r.push(d.name);return()=>{}}}});console.log(r)})"
```
