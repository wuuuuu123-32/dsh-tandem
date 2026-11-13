# 变更记录

## 0.8.0 — 2026-11-13

### 会审从「问一条链」变成「问几家 + 给它看真材料」，凭证判据重做

用户的原话分三次给：「可以先再跑5次会审看看，三个都上。然后多给材料确实可以，改一下插件吧（这个改动的会审也作为测试让三个模型跑）」「加入用来会审的话，价格是不是可以接受的」「我们tandem目前日常就用portdan的gpt6.1sol和这里的claude sonnet 5.5就行」。第三句定了默认组合。

**一、默认跨厂商双跑。** `DEFAULT_JUDGES = ['portdan', 'quna-sonnet']`，前者 gpt-6.1-sol（vendor `openai`），后者 claude-sonnet-5-5（vendor `anthropic`）。新增 `judges` 参数；与 `provider` / `dual` / `failover` 同传**直接报错**而不是静默选一个——被问的那一家不能在我们看不见的地方被换掉，而会审的价值全在问的是谁。

`quna-sonnet` 与 `quna-opus` 虽然共用同一个中转站，`vendorCount` 会如实算成 1 家；同时选它们不构成跨厂商独立意见，note 里会写出来。

**二、材料注入。** 旧的 `paths` 只用于签凭证，内容从不进 prompt，于是会出现「凭证说覆盖了 config.js，而 judge 只看到调用方复述的片段」——凭证比证据强，这是 10 月两次事故的共同病根。现在 `material` 显式指定、`paths` 里的文件默认注入（`materialStats.auto`），并且：

| 项 | 值 |
|---|---|
| 单文件 | 60 KB，超出截断且**截断不算覆盖** |
| 总量 / 文件数 | 200 KB / 40 个 |
| 白名单 | 只认 `workRoots`；**没配时 cwd 也不许当根**（原来没配等于全放开，传 `cwd: "C:/Users/me"` 整棵主目录都能读） |
| 禁止目录 | `.git / node_modules / .ssh / .aws / .docker / .kube / .gnupg`，按路径段判，覆盖 `GIT~1` 这类 8.3 短名 |
| 凭据 | `.env*`、`credentials*`、`*.pem/key/p12/p8/ppk/jks/tfstate/kubeconfig`、`service-account*.json`、`id_ed25519` 等一长串；Windows 的结尾点（`key.pem.`）、8.3 短名（`ENV~1`）、NTFS 命名流（`notes.txt:secret`）都挡，但放行 `README.md:Zone.Identifier`（浏览器下载标记） |
| 硬链接 / 竞态 | `nlink > 1` 拒；`open` 后 `fstat` 比对 `dev/ino/size`，不一致就拒 |

围栏长度自适应：内容里出现连续 4 个以上反引号时，包裹围栏比它更长，否则被注入的内容能提前闭合围栏、把自己抬成指令。

**三、凭证判据从「有没有意见」改成「能不能背书」。** 旧条件只有「全部成功 + 无冲突 + 有 paths」，实测立刻露馅：两位 judge 都说「存在严重缺陷，必须修改」时冲突数为 0，凭证照发，而 `tandem_delegate` 会显示成「这部分审过」。

判据收敛成纯函数 `decideReview(...)`，八条：没 paths / 有失败或数量不符 / 有未知 verdict 值 / 有冲突 / 有否决 / **没有任何一家判 pass** / 多路须 `vendors >= 2` / 材料未覆盖或指纹未知或在会审期间变化。第 6、7 条只对多路生效，否则既有单路调用永远签不出凭证，闸门变成死锁。

**判「通过/否决」以声明为准，正则只能否决不能放行。** judge 的 JSON 多一个 `verdict: pass|fail|unclear`；没有声明时，正则最多读出 fail 或 unclear，**永远读不出 pass**。这条最值钱：一张凭证背后的「通过」一定是模型显式写的，不是从散文里猜的。原因是补词循环根本收敛不了——第 3、5、6、8、9、10 轮，每轮都能找出一句新说法绕过词表（「当前版本不可用，修好后可以上线」「I would not approve this」「说它可以直接用是错误的」）。

签发失败时 note 说明是哪一条拦的；成功时写明「已签发：A=pass、B=unclear，1 家厂商」——乙语义下 unclear 不挡路，但也不背书。

**四、这套判据被自己审了 12 轮。** 第 1 轮就推翻了一个未验证前提：portdan 说 Codex 不接受 `wire_api=chat` 会失败、并建议写 Chat 适配器；实测报错 `wire_api = "chat" is no longer supported`，而 qunaapi 其实**有** `/v1/responses` 端点——不需要适配器，provider 表加一条即可。之后逐轮被挑出真路径并修掉：零位 judge 也签发、`judges: []` 过滤成空数组、claude 系习惯套 ```json 围栏、opus 在 JSON 里照抄正则导致 `Bad escaped character`、没有声明时正则给出 pass、非字符串 verdict 被 `typeof` 丢掉导致 bogus 闸门失效、单路指纹取三次的竞态（外部进程正好在两次读之间写文件，凭证会记下 judge 没看过的新版本指纹）。

**五、会审材料从「全量 diff」改成「要审那段的最新源码切片」。** 全量 diff 是 104 KB ≈ 2.8 万 token，其中大半是 `-U3` 的上下文行，对判逻辑没用；完整源码反而更小，因为不含重复上下文。判据段 335 行约 1.3 万字节。顺带解决两件事：claude 那个组对十万字节的请求直接报 high demand；一家扫 3 万 token 只会挑最刺眼的，范围缩小反而答得准。凭证的 `paths` 指向切片文件本身而不是源文件——凭证说的就是「这三个切片被审过」，与事实一致，不冒充整个文件。

**六、测试。** 12 份纯离线冒烟进 `npm test`（判据词表 31 条、单向闸门 15 条、`decideReview` 21 条、材料覆盖 7 条、凭据黑名单 25 种名字加 Windows 三种变形、围栏 5 条、分隔符 5 条、状态并发 5 条、JSON 修复 7 条、冲突 9 条）；会真起 Codex 的两份挪到 `npm run test:live`。

**七、发布前会审的第 15、16 轮又挑出三条真路径，都修了。**

到第 14 轮时两位 judge 都判「不能发」，其中两条是硬的：

- **diff 覆盖不验证内容**：`diffTargets` 只认 diff 头与 hunk，从不核对这份 diff 是否真的对应目标文件的当前内容。于是旧 diff、或者随手编的（`+++ b/src/critical.js` 加一个 `@@`）都能替一份 judge 从没见过的文件作证。现在每份像 diff 的材料都跑 `git apply --check --reverse`（先规范化 CRLF，否则 Windows 写的补丁会被误判成伪造），只有通过才算覆盖。文件、伪造、过期、无 hunk、被截断、目录型六种情况都有冒烟对应用例。
- **「注入了」不等于「注入的是那一版」**：`collectMaterials` 现在对自己读入的那段字节算 sha1，签发前 `checkMaterialFreshness` 重读文件比对 sha **与长度**（只比 sha 的话，「在后面追加一段」察觉不到）。两条分支都传 `materialItems` 下去。
- 另外两条较小的：目录型 `paths` 原来只要目录里任一文件进材料就算覆盖——现在**一律不算**（凭证会声称整个目录被审过，那种凭证比没有更坏）；`isUnder(stateKey, rk)` 会把包住 stateDir 的 workRoot 整个剔除，导致 `matRoots` 变空、一切材料被判越界——改成把 stateDir 当**拒绝根**传下去，只拦它自己下面的文件。

还有一条被判「不成立」而我保留意见的：portdan 说新增 provider 没展示 `wire_api`。`lib/consult.js` 里本来就有 `model_providers.<p>.wire_api=responses`（不加会被 Codex 0.163 直接拒绝），而那一轮会审本身就是经 Codex→quna 跑通的。

**已接受的残留局限**（不是漏审，是取舍）：乙语义下一家 pass 加一家 unclear 会签发；不给 `verdict` 字段的回答只能表达否决或沉默；单路凭证弱一档；基于文件名的黑名单追不上「把 .env 改名成 notes.txt」这种蓄意伪装——材料注入是给人用的工具，不是对抗有敌意的调用方，后者需要沙箱。

---

## 0.7.0 — 2026-11-07

### 会审后端改成「当天首次 portdan、其余优先免费额度」的链路

用户的原话是「每天第一次调用 codex 会审使用 portdan 的 gpt，其余的优先用 tf 的，tf 没余额了就用 pd，在此基础上 pd 出问题又我们之前测的那个 Terra 的站」。

链路（`planStages`，纯函数、可单测）：

| 情形 | 顺序 |
|---|---|
| 当天第一次 | portdan → tokenfuture → aisz |
| 当天其余 | tokenfuture → portdan → aisz |
| tf 在没余额退避期内 | 跳过 tokenfuture |
| 显式 `provider` | 钉死；`failover:true` 才补一条 |
| `failover:false` | 只问 portdan |

**并发认领**：<stateDir>/portdan-used-YYYY-MM-DD.json 用 `openSync(..., 'wx')` 建 —— 创建成功即「今天这一次归我」，EEXIST 即别人已经拿到。**一个系统调用就是全部判定**，没有「先读后删」或「先改名再放回」的窗口。

早先试过在单一锁文件上用 `rename` 抢占来回收崩溃残留，被会审指出致命交错：rename 会把原路径腾空，第三个进程能在那瞬间 `openSync` 成功，于是**两个进程都以为自己拥有当天资格**，付费次数翻倍。改成按天分文件后谁也不删谁的文件，这个交错不存在了。代价是崩溃残留会让那天剩下时间不再首选 portdan —— 只损失一次付费优先权，可以接受。

**日期按本地时区**（`localDay()`），不用 `toISOString()`：后者按 UTC 切天，东八区会把凌晨算成前一天。

**`lastPortdanDay` 只在 portdan 真的启动之后才写**：预算不足被截停时它一次都没跑，写了等于白扔当天的付费优先权。

### 新增失败类 `no_balance`

`insufficient balance/quota`、`insufficient_quota`、`exceeded your current quota`、`credit balance is too low`、`credits exhausted`、`余额不足`、`余额已耗尽` 等归到这里，**从 `auth_failed` 里拆出来**：凭据没错，只是这家今天没钱，应当立刻换下家并停用一阵。

**限流优先于余额**：`rate limit / too many requests / concurrency limit` 命中且不含明确的余额措辞时，一律判 `rate_limited`。否则一句 `429 rate limit: quota exceeded` 就会把 tokenfuture 停用 24 小时。裸的 `quota exceeded` 已从余额正则里删掉 —— 太泛，两个意思都占。

- 不重试同一后端（再问还是没钱），但会换后端。
- **只对 tokenfuture 生效**：别的后端欠费不会写进 tf 的退避状态。
- `policy_blocked` 仍排在它前面判 —— 内容拦截不会被余额正则抢走。

### 每家自带 base_url

Codex 侧改用 `-c model_providers.<name>.base_url / .env_key / .wire_api=responses` 传入，不再依赖 `~/.codex/config.toml`。旧写法在没声明过 provider 的机器上会直接 404 或静默走错网关。

### 实现复查后修正（同版本内）

第一轮实现被会审逐条挑出，改动如下：

- **当天已用过 portdan 就不再认领**。只用锁判断不够：portdan 第一次真跑过（已写 `lastPortdanDay`），同一次调用里第二次尝试因预算不足被截停会把锁还回去，下一次 `planStages` 又会首选 portdan —— 当天变成两次首选。现在先看 `lastPortdanDay`（以及当天认领文件是否存在）再决定要不要认领。
- **预算不足只跳过当前后端**。原来 `break` 会掉进循环末尾的 `!last || !SWITCHABLE → break outer`，把后两家一起掐掉 —— 配了故障切换却永远切不过去。现在 `continue outer`，剩余预算留给后面的备用。实测 180s 预算 + 三阶段：主端跳过，第二家拿到 87s。
- **状态拆成两个文件**：`portdan-used.json` 与 `tf-exhausted.json`，各自 pid 临时文件 + `renameSync` 原子写。原来单文件「读—合并—写」会让两个并发会审互相覆盖。
- **写入不抄磁盘旧值**：缺的字段写 `null`。原来「补缺失字段时读磁盘现值」仍有「A 读旧冷却 → B 清除 → A 落盘」的窗口，冷却会复活。宁可少记一次冷却，也不要白停 24 小时。
- **旧 `provider-state.json` 只在对应新文件不存在时才兜底**。
- **余额措辞补全**：`has been exhausted`、`funds have been depleted`、`余额为0` 此前会漏判（带着 429 就落进 `rate_limited`，永远不会冷却）。

### 其它

- `tandem_status` 新增 `consultChain`：今天是否已用过 portdan、下次会选谁、tf 是否在退避期及原因。
- 新增 `test/consult-chain.mjs`（20 条，不联网）：当日首次/非首次、tf 冷却与过期、跨天、pin 与 `failover:false`、状态文件损坏、时区切天、每家都有 baseURL。
- 新增 `test/chain-state.mjs`（37 条，不联网）：状态两文件互不覆盖、只给半个字段不复活冷却、单次 `wx` 认领只有一个成功、未标 started 可归还而跑过的不许归还、当天已用不再认领、180s 预算下主端不启动而第二家拿到机会。
- `consult-classify.mjs` 补 12 条 + 第四轮的 6 条（`has been exhausted`、`余额为0`、`funds have been depleted` 判 `no_balance`；`quota exceeded`、`Too Many Concurrent` 仍判 `rate_limited`），共 43 条。
- `failover-edge.mjs` 增断言：`attempts` 必须与「真正启动的条数」一致。

## 0.6.0 — 2026-10-28

### 新增：会审失败自动换后端（failover）

用户的原话是「如果遇到会审失败两次就该去问 terra」。原来的行为是两次失败就结束、把决定权交回给用户；现在默认会自己换到另一条上游再问一次：`portdan`（gpt-6.1-sol）两次 → `aisz`（gpt-6.1-terra）一次。

**切换表（刻意的取舍，不是漏配）**

| 失败原因 | 重试同一后端 | 换后端 |
|---|---|---|
| `empty_response` / `rate_limited` / `unknown` / `model_not_found` / `invalid_answer` | 是 | 是 |
| `auth_failed` / `timeout` | 不重试 | 是 |
| `spawn_failed` / 缺环境变量 | 否 | 否（本机执行器问题，换后端只会同样失败） |
| `policy_blocked` | 否 | 否（内容级拦截，换后端再问等于绕过策略） |

**预算**：`deadlineMs` 默认 `timeoutMs × 2`、夹在 60 到 900 秒，是所有尝试共享的一个总时钟。有备用在后面时，每次给主端算超时会扣掉 90 秒预留——这是「扣给后面」，不保证备用真能拿到 90 秒。备用单次上限 120 秒；剩余不足 18 秒不再启动新尝试（其中 3 秒留给清理与写盘）。

**新增返回字段**：`failoverFrom`（备用真的启动过才出现，成功失败都记）、`attemptsLog`（每条的 provider/ok/ms/timeoutMs/reason/started；`started:false` 表示进程没起来、不算一次尝试）、`stoppedBy` + `budgetNote`（后续尝试被预算挡下，此时 `reason` 只代表最后一次真跑完的尝试）、dual 模式下每项也带 `attemptsLog` 与 `failoverFrom`。

### 四轮会审修掉的缺陷（全部 ok:true，均落地）

1. **超时与退出有竞态**：旧写法先 `await killTree` 再落结论，退出事件可能先到，把超时记成「退出码非 0」→ 触发一次毫无意义的同后端重试。现在超时一触发先占位，之后一律记 `timeout`。
2. **deadline 只在尝试入口检查**：准备阶段（建目录、写文件、加载凭据、启动进程）没有截止约束。现在 spawn 之前再查一次，剩余不足 5 秒直接返回 `budget_exhausted` 且标 `notStarted`。
3. **慢失败耗光预算**：主端两次各占满 `timeoutMs` 后备用根本起不来。加了 90 秒预留与 15/18 秒门槛。
4. **预算阻止不可见**：只回上次失败 reason，看不出是预算挡的。加了 `stoppedBy` / `budgetNote`。
5. **killTree 无硬上限会让 deadline 失效**：清理加了 5 秒兜底（且不超过剩余到 deadline），并分三态如实报告「已杀 / 杀失败 / 未清完，可能仍有残余进程」。
6. **`killing.catch(() => {})` 吞掉拒绝**：原来杀失败也报「已杀进程树」，现在区分 `killState`。
7. **`failoverFrom` 语义**：原只在备用成功时设置，失败时漏统计「发生过切换」；且原在尝试前就设，预算挡下时会谎报已切换。现在只在该 stage 真的有尝试跑过之后才设。
8. **进程没起来却被记成一次尝试**：`attempts++` 后才发现 `budget_exhausted`，现改为回退 `attempts--` 并带 `started:false`。
9. **公开契约与实现矛盾**：参数说明称「显式 provider + `failover:true` 可强制切换」但代码只建单后端（已实现）；返回字段 `provider` 描述称「沿用 Codex 全局配置」但实际固定用表内 portdan（已改口）；双处 `attemptsLog` schema 补 `started`。
10. **`appendReview` 写失败仍签发 reviewId**：没落盘的标记查不到，等于空头凭证。现在写失败置 `review = null` 并在 `reviewNote` 说明原因。
11. **dual rejected 分支的 hint 断言不准**：`ms` 改标为「dual 到此刻的墙钟上界」，hint 改成「可能发生在真的调用上游之后」。
12. **分类漏检**：策略拦截、鉴权、限流、模型不存在的正则都扩了；策略关键词漏网会落进 `unknown` 导致重试并切换，等于绕过内容策略。分类单测 14 → 22 条。

### 测试

- `npm test` 58 条通过（含新 `test/failover-edge.mjs` 五个桩场景：默认三尝试 / `failover:false` 两尝试 / 钉死不切 / 强制切换 / 主动指定备用时 `failoverFrom=aisz`）。
- `test/register-smoke.mjs` 重写：五个工具与关键 schema 字段缺失即失败，hook 回调必须是函数（原来只记 event、静默通过）。
- 真上游端到端：T2 主端两次 `model_not_found`（23.4s + 23.4s）→ 备用 ok（21.2s），`failoverFrom=portdan`，`attempts=3`，总 70s。
- `test/failover-timeout.mjs` 两处踩坑后稳定：同一问题第二次问会命中上游缓存 15 秒内答完（假阳性失败）、短问题本来就可能 10 秒内答完 → 改成随机编号 + 240 条材料逐字复述。

## 0.5.0 — 2026-10-20

### 新增：自动求援（会话转久了主动问一次 Codex）

用户提的原话是「遇到困难任务、长任务，尤其反复处理无法解决时，应该主动去寻求 codex 意见」。设计不是拍脑袋定的，是从一个真实卡住的会话里反推出来的：**APK 逆向会话**（145 次工具调用 / 57 分钟，用户在第 137 次调用时才手动说「记得联合 gpt 解决」）。该轨迹的硬数据——显式失败仅 5 次且全是孤立（连续失败段恒为 1）、同一命令重复最多 6 次——证明「重复动作 / 相同报错」这类判据在真实卡住场景里**不响**。

最终形态：不做判定，只做到点问一句。

- `lib/rescue.js`（新，约 430 行）：`survey()` 从 `session.events` 现场重算统计与轨迹，`shouldFire()` 判据，`formatAnswer/formatFailure/formatAnnounce` 三段文案。
- `index.js`：挂独立 `tools/post-execute`（reviewGuard 关掉也照常工作）+ 60 秒 timer 补「单次调用自己挂死、post-execute 永不回来」的漏。
- 配置：`autoRescue`（默认开）、`rescueAfterCalls` 15、`rescueAfterMin` 10、`rescueCooldownMin` 20、`rescueMaxPerSession` 3、`rescueTtlMin` 30、`rescueTimeoutMs` 150000。

会审（review，`rv-4b18e531a8f380b4`，68.5 秒）挑出四个真缺陷，全部改掉并补了测试：

1. **turnOpen 只回看 400 条事件** —— 长 turn 的 `turn/start` 落到窗口外、又没有 `turn/end` 时会被判成「已结束」，最该求援的时候反而不问。改成反向扫到第一条 turn 边界就停。
2. **统计窗口 600 条** —— 用户消息滑出窗口后 `lastUserIdx` 保持 -1，调用数只按窗口内算，可能永远够不到阈值，用户目标也丢。改成先定位最后一条真实用户消息（最多回看 5000 条），窗口以它为下界。
3. **缺 `source.kind` 的消息被当用户开口** —— 系统注入会反复重置计时，把真正卡住的会话压住。改成只有 `kind === 'user'` 才算。
4. **pending 无条件交付** —— 用户在求援期间开口（可能换了任务）时，旧结论会被塞进新任务。改成交付前比对 `lastUserAt`，晚于求援发起就作废。

另外补了状态回收（两小时不活跃的会话从 `states` 里清掉，别一直攥着 session 引用），以及「触发当下先给一句即时提示」（用户要求触发后要看得见）。

`node test/rescue.test.mjs` 全绿（**41 项**），含真实会话轨迹、长 turn 边界、缺 kind、用户中途换任务、TTL、冷却、状态回收。

### 交付前第二次会审（review，`rv-b0e613504b6a75c2`，33.5 秒）

挑出五条，逐条核对后改了三条——都是「不修就会悄悄错」的那类：

1. **「已发出求援」会重复两遍** —— 原实现在 `fire()` 里把提示排进 `st.announce` 就返回 null，等下一次工具调用才交付；如果那之前又有别的路径取了一次，就会连喊两遍。改成**触发当轮直接交付并清空**：提示不再延迟一轮，也不可能重复。
2. **用户消息滑出回看窗口时把沉默当成「无限久」** —— 回看 5000 条内找不到 `source.kind==='user'` 时 `lastUserAt` 留 0，`shouldFire` 把 0 当 `Infinity`，于是「刚说过话、但消息已滑出窗口」和「沉默几小时」无法区分。改成拿窗口里最早一条事件的时间当**沉默下界**：新会话（才开两分钟）同样没有用户消息，但下界只有两分钟，不会触发。
3. **状态回收会把每会话上限清零** —— 两小时不活跃就从 `states` 删掉，重建后 `fired` 归零，同一会话可以无限次每两小时问一遍。改成**只回收从未触发过的**状态。

未采纳两条（都写了理由，不是忽略）：

- 「tick 用旧 survey 结果」——实际 `tick()` 每次都重算 `survey(session.events)`，不成立；
- 「进程重启丢 pending / inflight / fired」——确实会丢，但重启本身已经中断了那轮会话，丢一条迟到结论无害；为它加持久化不划算，写进 README 的边界。

另外把结论作废判据从 `lastUserAt > firedForUserAt` 改成 `!==`：同毫秒的用户消息也不漏。

测试从 41 项加到 **46 项**（新增「提示只出现一次」「无用户消息时下界取窗口起点 / 刚开的会话不触发」「触发过的状态不被回收」）。

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
