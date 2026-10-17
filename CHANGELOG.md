# 变更记录

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
