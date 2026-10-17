# dsh-tandem

让 DSH 主 agent 与本地 Codex（GPT）形成**双 agent 协作**：主 agent 负责跟你沟通、拆任务、做最终决定；Codex 负责并行执行与方案会审。

机制由插件保证，不靠 agent「记得」——参数不合法的派活会被**当场拒绝**。

## 三个工具

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `tandem_status` | 查看当前是否可用：Codex 路径、模型、并发上限、允许派活的目录根、凭据是否就绪 | 第一次派活前、或派活报错后先看它 |
| `tandem_delegate` | 把 N 个互不依赖的子任务并行交给 Codex | 每项必须给 `timeoutMs` 和 `acceptance`（怎么算干完了），缺失直接拒绝；`dir` 必须在白名单根内且互不重复 |
| `tandem_consult` | 让 Codex 作为「第二个有边界的判断者」回答一个问题 | 只判断、不写文件；必须回「结论 / 证据 / 反例 / 验证方式」四段，缺段即判无效 |

## 什么时候该用

**delegate（并行执行）**——同时满足才派：
- 有 ≥2 个产物，各自能独立验收；
- 写入路径不重叠、彼此不依赖；
- 都不要本对话的上下文。

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

# 2) 把插件链进桌面端 profile
cd ~/.dsh/profiles/desktop
# package.json: dependencies 里加 "dsh-tandem": "link:变更/发布后的路径"
#               dsh.profile.bundles 里追加 "dsh-tandem"
# 在 profile 目录下建目录联接（PowerShell）
New-Item -ItemType Junction -Path node_modules\dsh-tandem -Target <插件目录>
# 等价 cmd 写法：mklink /J node_modules\dsh-tandem <插件目录>

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
  "stateDir": "D:/dsh/config/dsh-tandem/state",
  "envKey": "PORTDAN_API_KEY"
}
```

- `codexCommand`：留 `codex` 即可，插件会自动探测 npm 全局安装位置，并优先用 `.exe`（Windows 下 spawn `.cmd` 需要额外包一层 cmd.exe）。
- `workRoots`：允许派活的目录白名单，防止 Codex 在工作区外乱写。
- `maxParallel`：**上限 3**，实测超过 3 会被上游挂住。

## 凭据

Codex 需要 `PORTDAN_API_KEY`。插件启动时若发现环境变量缺失，会自动从 `~/.dsh/.credentials.yaml` 的 `refs` 段补齐；补不到就在 `tandem_status` 里明确报出来。

## 已知限制

- Codex 非 tty 时输出会被吞，所以日志直接写文件（结果里给日志路径）。
- 上游缓存命中率不可控（实测 0~80% 波动），同一任务重复跑成本不是线性的。
- 超时按整棵进程树杀，避免 codex 子进程残留。
- `tandem_consult` 用 `read-only` 沙箱，它物理上改不了文件——这是刻意的。

## 装不上 / 工具不出现时先看这里

DSH **不写运行日志**，插件加载失败在界面上毫无提示（工具就是静默消失）。本插件在启动时写探针：

```
~/.dsh/tandem-state/load.log
```

正常应当长这样（三个工具各一行 `registered`）：

```
... module evaluated
... apply start, codex=...\codex.exe, tools service=object
... registered tandem_status
... registered tandem_delegate
... registered tandem_consult
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
# 假 ctx 走一遍 apply，确认三个工具都注册成功
node -e "import('./index.js').then(m=>{const r=[];m.apply({tools:{register:d=>{r.push(d.name);return()=>{}}}});console.log(r)})"
```
