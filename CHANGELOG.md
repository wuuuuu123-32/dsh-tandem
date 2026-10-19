# 变更记录

## 0.4.2 — 2026-10-19

### 会审挑出的边界缺陷：stateDir 以分隔符结尾时排除失效

第四道会审（crosscheck，`rv-70008ad0f2ad87cf`）核验 state 收窄后挑出四条边界反例，其中一条是真缺陷：

- **`stateDir` 写成盘根（`D:\`）时 `key()` 保留尾分隔符**，拼出来的前缀带两个反斜杠，任何后代路径都匹配不上 → 「账本自己所在目录不记账」的意图落空。现在先归一首尾分隔符再拼前缀，并补了一条断言（`stateDir` 带尾分隔符时仍正确排除）。

另外三条是不会造成**绕过**的别名情形（junction / 符号链接、subst 盘符、UNC / 设备路径）：`key()` 只做词法规范化、不调 `realpath`，同一目录的另一种写法不会被认定为同一个。方向上是「该排除的没排除」（多记账），不是「该记账的没记账」（绕过）——而 `.jsonl` 本来就不在跟踪扩展名里，实际影响为零。写进 README 的边界，不为它加每次写入都要跑的 `realpath` 调用。

`npm test` 全绿（**58 项**）。

## 0.4.1 — 2026-10-19

### 按会审意见补两处：重启不洗白、放行不沉默

会审（crosscheck，`rv-8e867d42f6981f45`）的结论是「当前机制不能可靠证明『交付前已完成第二次会审』」，两条反例是真漏洞：

- **DSH 重启后账本清零** → 未审状态只存在内存里，重启一次全部洗白，闸形同虚设。现在账本落盘 `<stateDir>/ledger.jsonl`（一行 `{path, t}`，超 400 行压到最近 200 条），启动时读回。`test/guard.test.mjs` 的「账本落盘：DSH 重启不洗白」整块专测重启前后一致性，端到端也用真实文件系统验过（新实例打印 `restored 1 tracked path(s) from ledger`，重启后闸照样拦、照样认那次已经发生过的会审）。
- **`present` 拦一次、重试即放行** → 闸门形同虚设。保留「只拦一次」（第二次必须放行，否则重试一下就永远交付不出去，那是死锁不是约束），但**放行不再沉默**：往对话注入明示「这次交付含 N 个未经会审的改动」（附具体路径），并往 `<stateDir>/deliveries.jsonl` 落一条 `{at, session, action, count, files}`。

第三道会审（crosscheck，`rv-4452a40923a3422e`）又挑出一条真绕过路径，已修：

- **一刀切排除 `state` 目录段** → 改动正好落在某个名为 `state` 的目录下就不记账，等于留了个后门。改成**只排除插件自己的 `stateDir`**，别处的同名目录照常记账（新增三项断言：别的 `state` 目录里的源码仍算可跟踪 / 照常记账 / 账本自己所在目录不记账）。

`npm test` 全绿（**57 项**）。

### 未采纳的会审意见（附理由）

- 「会审时间未持久化，重启会把已审的重新判成未审」——**事实不符**：`reviews.jsonl` 一直落盘，`reviews()` 读的就是磁盘，是材料没写清而非缺陷。
- 「十秒窗口内删除文件可能短暂误报」——保守方向，接受。
- 「`deliveries.jsonl` 写入失败仍放行，交付记录可能缺失」——刻意如此：账本坏了不能反过来阻死交付，写入失败只打日志。
- 「路径前缀匹配在大小写上可能出错」——`key()` 在 win32 下统一小写，已有断言覆盖。

## 0.4.0 — 2026-10-19

### 会审闸：让「改了没审」自己冒出来

`reviewId`（0.3.0）是**自愿**机制——agent 自己要记得带上标记。实测的失效方式很朴素：主 agent 一口气改完代码、直接回复用户，全程没想起会审，而任何人（包括用户）当场都看不出来。性能优化那一轮就是这么过去的。

这次把责任挪到插件身上：每会话维护一份改动账本，未审改动在三个位置自己暴露。

| 位置 | 干什么 |
|---|---|
| `fs/write-intent` / `fs/edit-intent` | **记账**。任何走 DSH fs 服务的写入 / 编辑都记下绝对路径，PTC 嵌套调用里的写操作同样经过这条线。以此为主数据源，不从工具参数里猜路径 |
| `tools/post-execute` | **提醒**。未审文件数到阈值就注入一条 user 消息（`source.kind = "dsh-tandem"`），点名具体文件 |
| `tools/pre-execute` | **拦截**。`present` 在还有未审改动时被拒一次，带机器可读的 `code: "REVIEW_REQUIRED"` |

- 配置：`reviewGuard` / `reviewGuardFirst`（默认 2，**不等第 3 个**，第一次出现未审改动就该说话）/ `reviewGuardEvery`（默认 4）/ `reviewGuardGate`（`deny` | `off`）。
- 判定：每个文件取 `t = max(记账时刻, 当前 mtime)`，找一条 `at > t` 且覆盖该路径的会审记录；**旧会审清不掉新改动**，改 mtime 越过会审时间也会重新变脏。
- 只想读取的 `fs` 意图不记账；相对路径直接跳过（判不出属于哪个工作目录）；文件删除后从账本摘除。
- 新增 `lib/ledger.js`、`test/guard.test.mjs`（会审闸单测），`tandem_status` 暴露 `reviewGuard` 摘要（含 `lastDelivery`）。

## 0.3.0 — 2026-10-18

### 会审标记 `reviewId`：让「审过」这件事留下可查的凭证

以前 `tandem_consult` 通过与否只存在于对话里：代码改完、验收通过，事后没人能说清这段到底有没有经过独立复核。

- `tandem_consult` 成功（真回了有效四段答案）时签发 `reviewId`（`rv-` + 16 位十六进制），并记下这次会审覆盖的 `paths`（不指定就不签发，并明说原因）。
- `tandem_delegate` 接受 `reviewId`：**任务目录落在覆盖范围内**才把标记写进票据，否则照样派活但标 `reviewed:false`；伪造的 id 当场拒绝。
- `tandem_check` 返回 `reviewed`，附一行 `review` 摘要（id · 时间 · 模式 · 覆盖路径）。
- 落盘 `<stateDir>/reviews.jsonl`，轮转保留 200 条且**不清理被票据引用的凭证**。

**语义边界（写在代码和 README 里，防止被当成配额）**：标记的是内容，不是「一次只能开一个任务」的限制；同一个 id 可以在覆盖范围内反复用。

### 修掉盲审挑出的两个真问题

- **指纹只绑路径 = 假信号**：`reviewId` 原本只记路径，路径上内容换掉它照样说「审过」。现在签发时同时算内容指纹，之后文件变了 → `reviewed:false` + `stale:true` + 说明「标记已过期」。
- **指纹取 size+mtime 同样能骗过**（同尺寸改写 + 恢复时间）。改成逐文件内容 sha1（≤1MB；更大的文件退回大小+时间并标 `weak:`）。

新增 `test/reviews.mjs`（11 项）：id 格式、往返、坏行容错、路径前缀不误伤兄弟目录、Windows 大小写、轮转保护被引用凭证、指纹稳定性、**同尺寸同 mtime 的改写必须被指纹发现**、票据字段往返。`npm test` 全绿。

## 0.2.0 — 2026-10-17

### 验收闭环：派活 → 机械验收 → 回灌重做

- **`tandem_check`**：把验收标准写成可执行断言（`exit` / `contains` / `notContains`，全部 AND），在任务目录里串行跑。判据在首次检查时**冻结**，之后改判据会被拒——防止「跑不过就改验收」。
- **`tandem_reject`**：把失败输出原文回灌给 Codex 重做，最多 2 轮，到上限判 `rejected_exhausted` 交人。
- `tandem_delegate` 成功时返回 `taskId`（验收票据），票据由 check / reject 共用。
- **Codex 0.163 兼容**：`--disable multi_agent`（不关时模型会去等一个不存在的子线程，172 秒挂死）、`-c mcp_servers={}`（同样的活 130 秒降到 25 秒）；完成标记正则放宽到允许尾部内容（新版本会在 `tokens used` 之后重复最后一条消息，旧正则判空跑）。

## 0.1.5 — 2026-10-17

### 修复「会审失败被当成没有意见」

老版本 `tandem_consult` 失败时只回 `{"ok":false,"error":"codex 退出码 1"}`，真实原因
（上游内容策略拦截 `turn.failed`）躺在日志里没人看 —— 2026-10-17 就因此跳过了一次本该做的会审。

- **失败有名有姓**：从 `--json` 事件流里解析 `turn.failed` 的原文，归类为
  `policy_blocked` / `auth_failed` / `rate_limited` / `model_not_found` / `empty_response` /
  `timeout` / `spawn_failed` / `invalid_answer` / `unknown`，并附一条**可执行**的 `hint`
  （例如策略拦截时明确写「改写措辞后重试；仍被拦就报告未获独立复核，不要跳过会审继续改动」）。
- **空转自动重试一次**：进程 0 退出却没有任何回答，属瞬时故障，重试 1 次（间隔 2 秒）；
  其余失败一律不重试（策略拦截、凭据错、模型名错重试只会重复同样的结果）。
- **四段校验**：结论 / 证据 / 反例 / 验证方式缺任一段或为空 → `invalid_answer`，不算通过。
- **审计**：每次结果追加一行到 `<stateDir>/consult-history.jsonl`；`tandem_status` 新增
  `lastConsult`（时间 / 是否成功 / 原因 / 尝试次数 / 问题前 120 字），一眼看出上次到底审成没审成。
- 新增 `test/consult-classify.mjs`：14 条夹具（8 种失败分类 + 失败原文提取 + 四段校验），
  `npm test` 两个测试一起跑。

## 0.1.4 — 2026-10-17

两个都是「独立复审挑出来的、不修就会静默出错」的问题。

### 修复

- **完成标记判定太宽，日志内容能伪造它**：0.1.3 引入的 `tokens used` 匹配原来是「日志任意位置出现就行」。但 Codex 会把任务 prompt 原样回显进日志——只要 prompt 或模型正文里出现一行 `tokens used` 紧跟一行数字，失败任务也会被判成成功，重派逻辑就再也不触发。现在正则锚定到**日志结尾**（允许尾部空白）：prompt 里伪造的标记一定出现在真正的 summary 之前，不可能命中。已知限制写在测试里：prompt 恰好以 `tokens used` + 数字结尾、且模型一个字符都没输出时，仍然无法区分。
- **没配 `model` 时会传 `-m undefined`**：`consult.js` 与 `delegate.js` 原来无条件拼 `-m config.model`。插件内部调用总有默认值，所以这个问题一直没暴露；但用 `runConsult` / `runTasks` 从外部脚本直调（配置里没写 model）时，Codex 会拿 `undefined` 当模型名去请求上游，报 `404 Model "undefined" is not supported ...`，重试 5 次后失败。现在只在配置了 model 时才传 `-m`，否则交给 Codex 自己的 `config.toml`。

## 0.1.3 — 2026-10-17

派活跑批时抓到的两个真问题，都关于「怎么算跑完了」。

### 修复

- **空跑被当成成功**：原来的判定是 `child.on('exit', code => finish({ ok: code === 0 }))`，只信退出码。实测同一份 prompt 连派两次：第一次 37 秒就 `exit 0`、日志只有 Codex 头部和 prompt 原文（25 行）、一个文件都没改；第二次 117 秒、日志 867 行、三处修改全部到位。现在退出码 0 之后还要看日志里有没有 Codex 固定的 `tokens used` 完成标记，没有就判 `emptyRun`、按失败处理，交给重派逻辑再跑一次。
- **结算早于 stdio 排空**：退出回调从 `exit` 改为 `close`。`exit` 触发时子进程的输出可能还没写完，此刻读日志会读到残缺内容——在「靠日志判断结果」之后这就是个真 bug。

### 新增

- `requireCompletionMarker`（默认 `true`）：完成标记是 Codex 的人类可读输出，不是稳定接口，换版本后失效可关掉。正常结束但确实什么都没改的回合仍会打印 `tokens used`，所以不会被误判成空跑。

## 0.1.2 — 2026-10-17

一次独立盲审（把整个仓库的源码与文档交给另一个模型当"陌生人第一次安装"来读）挑出的问题，逐条核实后修的。

### 修复

- **凭据注入从来没在正确时机发生**：`ensureEnv()` 原来只在 `tandem_status` 的 `execute()` 里调用，而 README 承诺"插件启动时自动补齐"。结果是谁先调 `tandem_delegate` 而不是 `tandem_status`，就会撞上 Codex 缺 `PORTDAN_API_KEY` 启动失败。现在改成 `apply()` 里注入一次，`delegate` / `consult` 每次执行前再补一次（幂等）。
- **`stateDir` 是个文档里有、代码里没有的配置项**：`config.example.json` 和 README 都在教用户配它，而 `DEFAULTS` 里根本没有这个键、会审的临时目录写死在第一个工作根下。现在它是真的了：`stateDir` 决定 `_tandem/` 临时目录位置（探针 `load.log` 仍固定在 `~/.dsh/tandem-state/`，因为排障入口写死在文档里，不能跟着配置漂）。
- **README 的安装命令照抄会失败**：`New-Item -ItemType Junction -Target <插件目录>` 里的 `<>` 在 PowerShell 里是重定向符，不是占位符；上一行还写着 `"link:变更/发布后的路径"` 这种不成句的东西。已换成带真实示例的可复制命令。
- **README 夸大了 `workRoots` 的作用**：原文说它"防止 Codex 在工作区外乱写"。它其实只限制**任务从哪起步** —— Codex 以 `danger-full-access` 运行（Windows 沙箱会把 `workspace-write` 静默降级成只读），白名单挡得住手滑与误配，挡不住提示词里明目张胆的越界写入。已改成如实说明。

### 新增

- `tandem_consult` 增加可选 `cwd` 参数：让 Codex 以指定目录为工作目录（审查某个项目时用）。**在 Windows 的 `read-only` 沙箱下它不起作用**——那里的沙箱连读都拦（`exec_command ... rejected: blocked by policy`），要审真实项目得把文件内容拼进 `context`；这一点已写进 README 的已知限制。

> 0.1.1 未单独发版：你的 DSH 一直没重启，0.1.1 的改动（并行任务的目录互相包含也拒绝）已经并进这一版，重启一次即可。

## 0.1.1 — 2026-10-17

### 新增

- **并行任务的目录互相包含也拒绝**（父目录 / 子目录 / 仅大小写不同）。
  原来只查「dir 字符串是否重复」，但 A 的 `D:/x/a` 与 B 的 `D:/x/a/sub` 并不重复，两个 agent 却会写同一棵树、后写的覆盖先写的，而且事后无法归因。

### 记录一个未采纳的设计

曾计划加 `writeScopes`（声明允许写入的路径前缀）+ 运行前后快照对比，超出范围的文件记入结果。经独立评审后放弃：并行任务与外部进程都会在审计窗口内改文件，快照只能看到差异、无法归因，`mtime + size` 粒度还会漏掉同尺寸改写 —— 误报与漏报同时存在。改为只保证「目录互不重叠」这个可确定的事实，并把理由写进 `lib/delegate.js` 的注释。

## 0.1.0 — 2026-10-17

首个发布版本：三个工具（`tandem_status` / `tandem_delegate` / `tandem_consult`），零运行时依赖。

### 发布前实机调试修掉的两个真问题

1. **不能依赖 `@deepseek-ai/dsh-tools`**
   profile 的 `node_modules/@deepseek-ai/` 里没有这个包，插件 import 它会失败。因此插件自带 `compileSpec` / `compileParameters`，把「作者写法」编译成 DSH 接受的标准 JSON Schema（属性级 `required: true` → 对象节点的 `required` 数组）。缺这一步，`ctx.tools.register()` 会抛
   `JsonSchemaError: unsupported JSON schema: ... required is not supported on type "boolean"`，三个工具全部注册失败，且 DSH 不写运行日志、界面无任何提示。

2. **`execute` 的返回值就是被校验的 value**
   DSH 的 `createSuccessResult(exec, tool, returned)` 拿 `execute` 的**整体返回值**去校验 `output.schema`，渲染才由 `output.render(args, value)` 负责。返回 `{ content, structuredContent }` 会报
   `missing required property "value.ok"`。正确写法是直接返回纯数据对象。

### 诊断设施

插件启动时把「模块已求值 / apply 开始 / 每个工具注册结果」写进 `~/.dsh/tandem-state/load.log`——DSH 不写运行日志，这是唯一能判断插件加载到哪一步的依据。
