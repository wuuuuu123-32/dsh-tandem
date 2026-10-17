# 变更记录

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
