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
  "envKey": "PORTDAN_API_KEY",
  "reviewGuard": true,
  "autoRescue": true,
  "rescueAfterCalls": 15,
  "rescueAfterMin": 10,
  "rescueCooldownMin": 20,
  "rescueMaxPerSession": 3
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

## 自动求援：转久了主动问一次 Codex（v0.5.0）

不是「卡住检测」—— 是「到点问一句」。判据故意宽，判断交给外部模型。

**为什么这么做**：真实样本（一个 145 次工具调用、57 分钟没解决的 APK 逆向会话）里，显式失败只有 5 次且全是孤立的（连续失败段长度恒为 1），同一命令重复最多 6 次。任何「按重复次数 / 报错次数」写的判据在那个样本上都不会响。真正卡住的形态是：**一直在换动作、每一步都有局部结果、整体没推进、用户沉默**。

**什么时候响**（全部同时满足才问）：

- 当前 turn 还在跑（在等用户时不打扰）
- 自最后一条**真实用户消息**以来 ≥ 15 次工具调用
- 且距那条消息 ≥ 10 分钟
- 且距上次求援 ≥ 20 分钟
- 且本会话求援次数 < 3

「连续 ≥3 次异常输出」只用来写触发原因，**不单独触发**（60 个历史会话里连续异常段 ≥3 只出现 4 次，而 ≥30 次调用无用户消息的占 15/60 —— 两个信号单独用都脏）。

**怎么给**：插件把最近 30 步（工具名 + 命令首行 + 结果首行 + 异常标记）加用户最后一条消息，发给 Codex 复核。触发当下先注入一句「已发出求援」，结论回来后在下一次工具调用时注入；正文第一句明写「这次不是用户说话」，并允许忽略。Codex 认为在正常推进时只回 `NO_STUCK`，那条注入会缩成一句背景提示。

**拿不到结论也说话**：高峰时段 Codex 会空转或超时（实测 `empty_response` 和 40 秒流断开都出现过），这时注入「没有拿到结论」加失败原因，不会静默。

**不注入的情况**：结论超过 30 分钟（挂死场景要等工具超时回来，别给太短）、或用户在求援期间开口（可能已经换了任务）—— 旧建议不许塞进新任务。

**重启就清零**（已知边界）：触发计数、正在跑的求援、待交付的结论都只在内存里，DSH 重启即丢。迟到的结论本来也不该跨重启塞进新会话，所以不为此加持久化；代价是重启后同一会话可能再问一次（同一会话每进程仍最多 3 次）。

**关掉**：`"autoRescue": false`。只调阈值就改上面几个字段，重启 DSH 生效。

排查：`~/.dsh/tandem-state/load.log` 里有 `auto rescue installed (...)`，之后每次 `rescue fire / announce / deliver / drop` 都有一行。

## 跨厂商并行会审 + 材料注入（v0.8.0）

v0.7 及以前，一次 `tandem_consult` 就是「问一条链路里的一位」。v0.8 把两件事拆开重做：**问谁**可以多家并行，**给它看什么**由插件负责而不是靠调用方复述。

### 默认两家，一 GPT 一 Claude

```text
DEFAULT_JUDGES = ['portdan', 'quna-sonnet']
       portdan      → gpt-6.1-sol       vendor: openai
       quna-sonnet  → claude-sonnet-5-5 vendor: anthropic
```

理由不是「多一个模型更保险」，而是**跨厂商**：portdan / tokenfuture / aisz 全是 GPT 系，它们的一致不构成独立复核。quna-sonnet 与 quna-opus 虽然共用同一个中转站，但 vendor 都是 `anthropic`，`vendorCount` 会如实算成 **1 家**——同时选这两家不构成跨厂商意见，插件会在 note 里明说。

用法与互斥：

| 参数 | 含义 |
|---|---|
| `judges: ["portdan","quna-sonnet"]` | 显式指定；恰好一个元素时退化为单路（走 `runConsult`，不要求跨厂商） |
| 不传 `judges` | 走 `DEFAULT_JUDGES` |
| `provider: "portdan"` | 钉死单路，与 `judges` 互斥（同传直接报错，不静默二选一） |
| `dual: true` / `failover: false` | 与 `judges` 同传同样报错 |

并行的是**请求**，不是结论：顶层 `ok` = 至少一家成功，`partial` = 部分成功，`results[]` 逐家给 `ok/ms/conclusion/evidence/counterexamples/verification/verdict/source/log`，`failed[]` 给 `reason/hint/log`。一个反直觉但重要的推论：**两路里至少一路失败的概率 ≈ 35%，三路 ≈ 48%**（按单路成功率 80.3% 算），所以「多上几家」并不会自动让结论更可靠，只让等待更久、失败面更大。

### 材料注入：把「我说它看了」变成「它真的看了」

改之前，`paths` 只用于签凭证，内容从不进 prompt。于是会出现这种自欺：凭证声称覆盖了 `config.js`，而 judge 只看到调用方在 `context` 里复述的片段。这正是 10 月两次事故的病根——**凭证比证据强**。

现在：

- `material: ["a.js", "b.js"]` 显式指定要注入的文件；
- **`paths` 里的文件默认也会被注入**（`materialStats.auto = true`），因为「声称审过却从未给对方看」本身就是矛盾的；
- 注入的文件必须是受审路径的**完整内容**才算覆盖：截断的不算；**目录型 paths 一律不算覆盖**——目录里只要有一个文件进了 prompt，凭证就会声称「这个目录被审过」，那种凭证比没有更坏（要审目录请把文件逐个列进 `paths`）；
- 用 diff 覆盖也可以，但**必须能与工作区对上**：每份像 diff 的材料都会跑 `git apply --check --reverse`（先规范化 CRLF），结果分 `ok / mismatch / unavailable`，只有 `ok` 才算覆盖。过期 diff、伪造 diff（`+++ b/x` 加一个 `@@` 就想蒙）都会被拒——否则随手编一份 diff 就能替任何文件作证；
- 覆盖只说明「字节进了 prompt」，还要证明**是 judge 看的那一版**：`collectMaterials` 对自己读入的那段字节算 sha1，签发前 `checkMaterialFreshness` 重新读文件比对 sha 与长度（未截断时也比长度，否则「后面追加一段」察觉不到）。

限制与拒绝（`collectMaterials`，纯函数、可单测）：

| 项 | 值 / 规则 |
|---|---|
| 单文件 | 60 KB，超出截断并标记 `truncated`（**截断的文件不算覆盖**） |
| 总量 | 200 KB |
| 文件数 | 40 个，超出的合并成一条「因总量/文件数封顶未读取」而不是逐个报 |
| 越界 | 只认 `workRoots`；**没配 `workRoots` 时 cwd 也不许当白名单根**（否则传 `cwd: "C:/Users/me"` 整棵主目录都能读） |
| 禁止目录 | 按路径**段**判 `.git / node_modules / .ssh / .aws / .docker / .kube / .gnupg / .azure / .gcloud / .terraform / .vault`，另有裸名 `gcloud`（真实路径是 `.config/gcloud`），并覆盖 8.3 短名（`GIT~1`、`SSH~1`、`CONFIG~1.JSO`） |
| 凭据 | `.env*`、`.envrc`、`credentials*`（含 `credentials.db`/`credentials.toml`）、`npmrc/netrc/pypirc/git-credentials`、`auth.json`、`id_(rsa\|dsa\|ecdsa\|ed25519)`、`*.pem/key/pfx/p12/p8/ppk/jks/keystore/tfstate/tfvars/kubeconfig/ovpn`、`service-account*.json`、`secrets.{yaml,yml,json,txt}`、`access_tokens*.db`、`msal_token_cache.bin`、`tandem.json`、`provider-state.json` |
| Windows 变形 | 结尾点/空格（`key.pem.` 与 `key.pem` 等价）、8.3 短名前缀表（`CREDEN~1.YAM`、`ENV~1`）、**basename 里带任何冒号都拒**（`notes.txt:secret` 是 NTFS 命名流）；`README.md:Zone.Identifier` 放行（浏览器下载标记，不是凭据） |
| 硬链接 / 竞态 | `nlink > 1` 直接拒；`open` 之后 `fstat` 比对 `dev/ino/size`，不一致就拒（挡住「检查完再换成别的文件」） |

围栏长度自适应：文件内容里出现连续 4 个以上反引号时，包裹用的围栏会比它更长——否则被注入的内容可以提前闭合围栏，把自己抬成指令。

### 凭证判据：从「有没有意见」改成「能不能背书」

旧的签发条件只有「全部成功 + 无冲突 + 有 paths」。这条在实测里立刻露馅：两位 judge 都说「存在严重缺陷，必须修改」时冲突数为 0，凭证照样签发，而 `tandem_delegate` 会把它显示成「这部分审过」。**否决是结论，不是「没意见」。**

现在签发判据收敛到一个纯函数 `decideReview({verdicts, failedCount, judgeCount, conflicts, paths, changedDuring, vendors, materialCoverage, fingerprintUnknown})`，八条依次拦：

| # | 拒绝条件 | note 里的原话（节选） |
|---|---|---|
| 1 | 没指定 `paths` | 没有覆盖范围的标记无法证明任何内容是审过的 |
| 2 | 有 judge 失败，或 `verdicts.length !== judgeCount` | 部分意见不足以声称这段内容被复核过 |
| 2b | 有**未知的** verdict 值 | 未知判定值既不是通过也不是否决，不能放行 |
| 3 | judge 之间结论冲突 | 冲突本身就是要停下来看的东西 |
| 4 | 有任何一家判 fail | 否决是结论，不是「没意见」 |
| 5 | 没有任何一家判 pass | 全都没表态不等于审过 |
| 6 | 多路且 `vendors < 2` | 同一厂商的多个模型共享训练与偏好，不构成独立复核 |
| 7 | `materialCoverage.ok === false` | 凭证不能为一篇没人看过的文件作证 |
| 8 | `changedDuring` 或 `fingerprintUnknown` | 受审文件在会审期间发生了变化 |

第 6、7 条只对多路生效（单路豁免），否则所有既有的单路调用会永远签不出凭证，闸门变成死锁。第 7 条在 v0.8 里取消了「单路不看材料」的旧豁免——这条限制的是**证据**，与「独立厂商有几家」无关。

**判「通过 / 否决」以声明为准，正则是只能否决不能放行的兜底。** judge 的 JSON 里多一个字段：

```json
{ "verdict": "pass" | "fail" | "unclear", "conclusion": "...", "evidence": [...], "counterexamples": [...], "verification": "..." }
```

- 有声明就听声明（`source: "declared"`）；
- 声明 `fail` / `unclear` 直接采纳；
- 声明 `pass` 时正则仍可否决（正文说「不行」而字段写 pass，按不行算）；
- **没有声明时，正则最多把回答读成 fail 或 unclear，永远读不出 pass**。

最后这条是整次改造里最值钱的性质：一张凭证背后的「通过」，一定是某个模型显式写了 `"verdict": "pass"`，不是从散文里猜的。判方向靠正则读自由文本永远追不上措辞空间——本会话第 3、5、6、8、9、10 轮，每一轮都能找出一句新说法绕过词表（「当前版本不可用，修好后可以上线」「I would not approve this」「说它可以直接用是错误的」），这正是改用声明式字段的原因。

签发失败时 note 说明是哪一条拦的；成功时 note 写明「已签发：A=pass、B=unclear，1 家厂商」，乙语义下 `unclear` 不挡路但不背书，结论原样带回。

### 这套判据被自己审了 12 轮

改的是「判据」，而按工作区规则改完还要它审自己——所以这段代码同时是被审对象和判据本身。历史：第 1 轮推翻「Codex 接受 `wire_api=chat`」这个未验证前提（实测报错 `wire_api = "chat" is no longer supported`，而 qunaapi 其实**有** `/v1/responses`，于是不需要 Chat 适配器）；第 2 轮起逐轮被挑出真路径：零位 judge 也签发、`judges: []` 过滤后为空数组、claude 系习惯套 ```json 围栏、opus 照抄正则导致 `Bad escaped character`、`没有声明 → 正则给 pass`、非字符串 verdict 被 `typeof` 丢掉导致 bogus 闸门失效、单路指纹取三次的竞态……

已经**接受**的残留局限（不是漏审，是取舍）：

1. 乙语义下，一家 pass + 一家 unclear 会签发——`unclear` 不背书也不否决，这是用户 2026-11-13 拍板的语义；
2. 声明优先、正则兜底，于是「完全不给 verdict 字段」的回答只能表达否决或沉默，不能表达通过；
3. 单路凭证弱一档（judgeCount=1 不要求跨厂商），它本来就只代表「问了一家，那家说可以」。

### 自测

`npm test` 里有 12 份纯离线冒烟（不需要网络、不花钱）：判据词表 31 条、单向闸门 15 条、`decideReview` 21 条（含「两家都否决 → 不签发」「一家 pass 一家 unclear → 签发并点名」「非字符串声明 → 不签发」「未知值 → 不签发」「取指纹失败 → 不签发」）、材料覆盖 7 条、凭据黑名单 25 种名字加 Windows 三种变形、围栏长度 5 条、路径分隔符 5 条、状态并发 5 条。会真的起 Codex 的两份在 `npm run test:live` 里单独跑。

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

## 会审后端链路：当天首次用 portdan，其余优先免费额度（v0.7.0）

会审不再固定一条链路，而是按「今天是不是第一次」决定先问谁：

| 情形 | 顺序 |
|---|---|
| 当天第一次 | `portdan`（gpt-6.1-sol）→ `tokenfuture`（gpt-6.1-sol）→ `aisz`（gpt-6.1-terra） |
| 当天其余 | `tokenfuture` → `portdan` → `aisz` |
| `tokenfuture` 报了没余额之后的 24 小时内 | 跳过 `tokenfuture`，其余不变 |
| 显式传了 `provider` | 钉死那一家（要切换得再传 `failover:true`） |
| `failover:false` | 只问 `portdan` |

**为什么要有「当天第一次」这条**：两家跑的其实是同一个模型，质量实测同档（GPQA 80 题 93.75% 对 91.78%，McNemar p 约 0.68），差别只在钱 —— tokenfuture 是白送的额度，portdan 按量计费。所以默认先烧免费的，但每天留一次付费调用：一是确认 portdan 那条路还活着（它不会因为不用就一直被验证），二是免费额度哪天突然清零时，至少当天还有一次能用的会审。

**状态落在哪**：拆成两个文件，都在 `<stateDir>`（默认 `~/.dsh/tandem-state/`）里：

| 文件 | 内容 | 谁写 |
|---|---|---|
| `portdan-used.json` | `{"day":"2026-11-07","at":1793988494505}` | 当天首次 portdan 真的启动之后 |
| `tf-exhausted.json` | `{"at":1793990000000,"reason":"insufficient balance"}` | tokenfuture 报没余额时 |

拆开是因为两者的生命周期不同：日期每天翻、退避按 24 小时算。合在一个文件里，任何一次写入都会把另一半的快照带回去 —— 「A 读到旧冷却 → B 清掉 → A 又写回去」，冷却就复活了。同理，写任一文件时缺的那一半从**磁盘现值**补，不从内存快照补。

旧版的 `provider-state.json` 仍然能读，但只在对应的新文件不存在时兜底；两个新文件都在时完全不看它，否则显式清除掉的冷却会被旧文件里那份复活。

**并发怎么保证只有一个进程是「今天第一次」**：认领用 `openSync(<stateDir>/portdan-day-YYYY-MM-DD.lock, 'wx')` 建锁，这一步是内核级原子的。锁已经存在且 mtime 超过 30 分钟算陈旧，用 `renameSync` 把文件抢到一个随机名下 —— rename 同样是原子的，两个进程同时抢只有一个能改名成功，改成功的那个人独占那个 inode。

关键是不「先 stat 再删」：看和删之间别人可能已经把旧锁删掉、换成自己的新锁，你删的就是别人的。释放也走同一条路 —— 先 rename 抢过来，读里面的 pid，确认是自己的才 unlink，不是就 `linkSync` 放回去。读内容和删除从此作用于同一个 inode。

读改写 JSON 做不到这点：两个进程都会读到「今天还没用过」，然后都去用 portdan，付费次数直接翻倍。

**日期只按本地时区切**：用 `toISOString()` 会按 UTC 切天，东八区凌晨 8 点前都会被算成前一天，「每天一次」就变成「每 32 小时一次」。

**「今天用过了」只在 portdan 真的启动之后才写**：如果它因为预算不足压根没起来，写了等于把当天的付费名额扔掉，而它一次都没跑。锁文件留着（那是「谁抢到了」的凭据），但 `lastPortdanDay` 要等这一轮真的启动才落盘；同一天再调用时 `planStages` 先看 `lastPortdanDay`，看到是今天就根本不认领，因此也不会出现「同一天两轮都首选 portdan」。

**余额耗尽单独成一类 `no_balance`**：口令是 `insufficient balance/quota`、`insufficient_quota`、`exceeded your current quota`、`billing_hard_limit`、`payment required`、`out of credit`、`(balance|credit|account|funds) is (exhausted|depleted|used up|empty)`、`余额不足`、`额度不足`、`余额已用完`、`余额耗尽` 这些。它和 `auth_failed` 的区别很实际 —— 凭据没错，只是这家今天没钱了，应当立刻换下一家并把这家停用一阵；归成 `auth_failed` 会让人跑去查 key。`policy_blocked` 排在它前面判，内容拦截不会被余额正则抢走。

**裸的 `quota exceeded` 故意不算余额不足**：Codex 在普通限流时也会打 `429 rate limit: quota exceeded`，按余额处理会把白送的免费额度白停 24 小时。限流措辞先判，只有当整条信息不匹配任何限流词时才落到余额正则。

**`no_balance` 只对 `tokenfuture` 生效**：portdan 或 aisz 欠费时不能写进 tf 的退避状态，否则会因为一个不相干的错误把免费额度停用 24 小时。

**怎么手动恢复**：删掉 `tf-exhausted.json` 就立刻恢复使用 tf；删掉当天的 `portdan-day-*.lock` 会让下一次重新以 portdan 打头（`portdan-used.json` 也要一起清，否则 `planStages` 看到今天已用过还是不认领）。

**每家自带 base_url**：Codex 侧用 `-c model_providers.<name>.base_url=... / .env_key=... / .wire_api=responses` 传进去，不依赖 `~/.codex/config.toml` 里有没有声明。旧版靠全局配置，换台机器装插件就会静默走错网关或者直接 404。

## 失败自动换后端（v0.6.0）

主上游两次都失败时，自动换另一条上游再问一次。默认：`portdan`（gpt-6.1-sol）问 2 次 → `aisz`（gpt-6.1-terra）问 1 次。

**什么会切，什么不会**（这条表是刻意的，不是漏配）：

| 失败原因 | 重试同一后端 | 换后端 |
|---|---|---|
| `empty_response` / `rate_limited` / `unknown` / `model_not_found` / `invalid_answer` | 是 | 是 |
| `auth_failed` / `timeout` | 不重试 | 是 |
| `spawn_failed` / 缺环境变量 | 否 | **否** —— 本机执行器的问题，换后端只会用同样方式再失败 |
| `policy_blocked` | 否 | **否** —— 内容级拦截，换后端再问等于绕过策略 |

**预算**（不然「换后端」在长失败下永远是空话）：

- `deadlineMs`：整次会审的总预算，默认 `timeoutMs × 2`，夹在 60 到 900 秒。是所有尝试共享的一个总时钟，不是每次各自计时。
- 后面还有备用时，每次给主端算超时会先扣掉 90 秒预留。**这是「扣给后面」，不保证备用真能拿到 90 秒**：主端第一次仍可能占满 `timeoutMs`，预留只在后续每次计算时生效。
- 备用 `aisz` 单次上限 120 秒；剩余预算不足 18 秒时不再启动任何新尝试（其中 3 秒留给清理进程与写盘）。

**返回字段怎么读**：

- `attempts`：真的启动过 Codex 的次数。准备阶段就发现预算不够的那次不算，也不会计入。
- `attemptsLog`：每次尝试的明细。`started:false` 表示这一条**进程根本没起来**（预算问题），不是上游失败 —— 别把它统计成错误率。
- `failoverFrom`：只在备用后端**真的启动过**时才出现（值是让位的那个上游），成功失败都记。
- `stoppedBy:"budget"` + `budgetNote`：后续的重试或换后端被预算挡下了。此时 `reason` **只代表最后一次真正跑完的尝试**，不代表备用也失败。

**超时归因**（踩过的坑）：超时与进程退出有竞态，旧写法先等杀进程再落结论，会让退出事件抢先、把超时记成「退出码非 0」→ 触发一次毫无意义的同后端重试。现在超时一触发先占位，之后一律记 `timeout`。杀进程树有 5 秒兜底（且不超过剩余到 deadline 的时间），清不掉时如实写「可能仍有残余 Codex 进程」，不会假装清干净。

**关掉**：`failover:false`；或显式指定 `provider`（视为钉死，传 `failover:true` 可强制允许切换）。

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
# 会审链路单测：当天首次/非首次、tf 退避、跨天、pin 与 failover:false、状态文件损坏
node test/consult-chain.mjs
# 假 ctx 走一遍 apply，确认五个工具都注册成功
node -e "import('./index.js').then(m=>{const r=[];m.apply({tools:{register:d=>{r.push(d.name);return()=>{}}}});console.log(r)})"
```
