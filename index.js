/**
 * dsh-tandem —— 双 agent 协作插件。
 *
 * 分工：DSH 主 agent 负责跟你沟通、拆解任务、做最终决定；
 *       本机 Codex（GPT）负责并行执行与方案会审。
 *
 * 本文件只做两件事：
 *  1. 把「并行派活」变成一等公民工具，参数不合法当场拒绝（不靠 agent 记忆）；
 *  2. 暴露 tandem_status，让主 agent 随时能核对当前配置是否真的可用。
 *
 * 设计取舍（有实测依据）：
 *  - 不在这里做 PreToolUse 阻断。参数校验已经天然强制，hook 只该拦不可逆操作，
 *    否则 agent 被拦后会改写命令重试，形成死循环。
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { validateTasks, normalizeRoots, runTasks, summarize } from './lib/delegate.js';
import { runConsult, MODES } from './lib/consult.js';
import { ensureEnv, credentialsPath } from './lib/env.js';
import { resolveCodexCommand } from './lib/codex-path.js';

export const name = 'dsh-tandem';
export const inject = ['tools'];

// 不 import @deepseek-ai/dsh-tools（profile 的 node_modules 里没有这个包，解析必失败）。
// 但它的 defineTool 做了两件必须的事：把作者写法里的「属性级 required: true」编译成
// 标准 JSON Schema 的顶层 required 数组，并校验 schema —— 缺这一步，register() 会抛
// "required is not supported on type boolean"（2026-10-17 实测，三个工具全部注册失败）。
// 下面按官方 compilePropertyMap / compileValueSchema 的规则复刻，保持零依赖。
export function compileSpec(node) {
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required') {
      // 属性级的 required: true 由父级的 properties 收集；若已经是标准 required 数组则原样保留，
      // 否则重复编译一份已编译过的 schema 会把必填约束静默丢掉（GPT 盲审指出，2026-10-17）。
      if (Array.isArray(value)) out.required = value.slice();
      continue;
    }
    if (key === 'properties') {
      const props = {};
      const required = [];
      for (const [name, child] of Object.entries(value || {})) {
        props[name] = compileSpec(child);
        if (child && child.required === true) required.push(name);
      }
      out.properties = props;
      if (required.length > 0) out.required = required;
      continue;
    }
    if (key === 'items') {
      out.items = compileSpec(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** 参数是隐式对象根：作者写的是属性表，不是完整 schema。 */
export function compileParameters(spec) {
  // 防御：若调用方传的已经是完整 schema（带 type/properties），按值 schema 编译，别再套一层对象根。
  if (spec && spec.type === 'object' && spec.properties) return compileSpec(spec);
  const props = {};
  const required = [];
  for (const [name, child] of Object.entries(spec || {})) {
    props[name] = compileSpec(child);
    if (child && child.required === true) required.push(name);
  }
  return { type: 'object', properties: props, ...(required.length > 0 ? { required } : {}) };
}

const defineTool = options => ({
  ...options,
  parameters: compileParameters(options.parameters),
  output: { ...options.output, schema: compileSpec(options.output.schema) },
});

// 加载探针：DSH 不写运行日志，插件加载失败时界面上什么也看不到。
// 这里把「模块已求值 / apply 开始 / 每个工具注册结果」写进固定文件，
// 是唯一能在重启后判断"到底哪一步断了"的依据。失败绝不抛出。
const PROBE_FILE = join(homedir(), '.dsh', 'tandem-state', 'load.log');
function probe(msg) {
  try {
    mkdirSync(join(homedir(), '.dsh', 'tandem-state'), { recursive: true });
    appendFileSync(PROBE_FILE, new Date().toISOString() + ' ' + msg + '\n');
  } catch {}
}
probe('module evaluated');

const DEFAULTS = {
  codexCommand: 'codex',
  model: 'gpt-6.1-sol',
  maxParallel: 3,
  workRoots: ['D:/dsh/work'],
  taskTimeoutMs: 300000,
  envKey: 'PORTDAN_API_KEY',
  configFile: join(homedir(), '.dsh', 'tandem.json'),
};

function readJson(path) {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/** 默认 < ~/.dsh/tandem.json < 插件配置（后者优先）。 */
export function resolveConfig(pluginConfig = {}) {
  const file = readJson(pluginConfig.configFile || DEFAULTS.configFile);
  const merged = { ...DEFAULTS, ...file, ...pluginConfig };
  merged.workRoots = Array.isArray(merged.workRoots) ? merged.workRoots.map(String) : [...DEFAULTS.workRoots];
  merged.maxParallel = Number(merged.maxParallel) > 0 ? Math.min(Number(merged.maxParallel), 8) : DEFAULTS.maxParallel;
  merged.taskTimeoutMs = Number(merged.taskTimeoutMs) > 0 ? Number(merged.taskTimeoutMs) : DEFAULTS.taskTimeoutMs;
  merged.roots = normalizeRoots(merged.workRoots);
  return merged;
}

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];

export function apply(ctx, pluginConfig = {}) {
  const disposers = [];
  const cfg = resolveConfig(pluginConfig);
  cfg.codexCommand = resolveCodexCommand(cfg.codexCommand);
  probe('apply start, codex=' + cfg.codexCommand + ', tools service=' + (typeof ctx?.tools));

  // 单个工具注册失败不连累其它工具：记录后继续，至少让 tandem_status 能看到问题。
  function register(tool) {
    try {
      disposers.push(ctx.tools.register(tool));
      probe('registered ' + tool.name);
    } catch (error) {
      probe('REGISTER FAILED ' + tool.name + ': ' + (error && (error.stack || error.message) || error));
    }
  }

  const statusTool = defineTool({
    name: 'tandem_status',
    description: '查看 dsh-tandem 的当前配置与可用性：Codex 命令是否可解析、模型、并发上限、允许派活的工作根、单任务默认超时。在第一次派活之前或派活报错之后调用它确认配置。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          codexCommand: { type: 'string', required: true },
          model: { type: 'string', required: true },
          maxParallel: { type: 'integer', required: true },
          workRoots: { type: 'array', items: { type: 'string' }, required: true },
          taskTimeoutMs: { type: 'integer', required: true },
          configFile: { type: 'string', required: true },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: renderJson,
    },
    async execute() {
      const notes = [];
      const envState = ensureEnv(cfg.envKey);
      if (cfg.envKey && !envState.ok) {
        notes.push(`环境变量 ${cfg.envKey} 未设置，且 ${credentialsPath()} 里找不到该键；Codex 会因缺凭据启动失败`);
      }
      if (!existsSync(cfg.configFile)) {
        notes.push(`配置文件不存在（${cfg.configFile}），当前使用默认值`);
      }
      const value = {
        ok: notes.length === 0,
        codexCommand: cfg.codexCommand,
        model: cfg.model,
        maxParallel: cfg.maxParallel,
        workRoots: cfg.workRoots,
        taskTimeoutMs: cfg.taskTimeoutMs,
        configFile: cfg.configFile,
        notes,
      };
      return value; // DSH 用 output.schema 校验返回值本身（不是 {content, structuredContent}），渲染交给 render
    },
  });
  register(statusTool);

  const delegateTool = defineTool({
    name: 'tandem_delegate',
    description: '把多个互不依赖的子任务并行交给本机 Codex（GPT）执行，最多 maxParallel 路。每个任务必须给 acceptance（怎么算干完了），缺失会被当场拒绝——没有验收标准的派活不算完成。仅用于「产物能分别验收、互不依赖、不要我的对话上下文」的任务；需要我持续交互或改动同一批文件时不要用。',
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        description: '任务列表。每项：{ id, dir, prompt, timeoutMs, acceptance }。dir 必须是允许工作根内的绝对路径，且互不重复。',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', required: true, description: '短标识，用于汇总' },
            dir: { type: 'string', required: true, description: '该任务的独立工作目录（绝对路径，且在 workRoots 内）' },
            prompt: { type: 'string', required: true, description: '自包含的任务说明（Codex 看不到本对话）' },
            timeoutMs: { type: 'integer', required: true, description: '超时毫秒，≥10000；到点杀整棵进程树' },
            acceptance: { type: 'string', required: true, description: '一句可核对的验收判据，例如「node test.js 退出码 0」' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          ok: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                ms: { type: 'integer', required: true },
                dir: { type: 'string' },
                log: { type: 'string' },
                acceptance: { type: 'string' },
                code: { type: 'integer' },
                timedOut: { type: 'boolean' },
                error: { type: 'string' },
                tail: { type: 'string' },
              },
            },
          },
          rejected: { type: 'array', items: { type: 'string' } },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const tasks = args?.tasks;
      const errors = validateTasks(tasks, { roots: cfg.roots, maxParallel: cfg.maxParallel });
      if (errors.length > 0) {
        return { total: 0, ok: 0, failed: 0, results: [], rejected: errors };
      }
      const prepared = tasks.map(task => ({ ...task, timeoutMs: task.timeoutMs || cfg.taskTimeoutMs }));
      const results = await runTasks(prepared, cfg);
      const summary = summarize(results);
      return { ...summary, results, rejected: [] };
    },
  });
  register(delegateTool);

  const consultTool = defineTool({
    name: 'tandem_consult',
    description: '让本机 Codex（GPT）作为第二个有边界的判断者，复核我自己出的东西。凡是我设计的方案 / 实施计划 / 排查思路 / 架构选型，或要改插件、工具、脚本的功能实现，都在动手前或交付给用户前调它一次；它只挑问题、给反例，不写文件、不动仓库，回「结论/证据/反例/验证方式」四段。同一问题默认只问一次，出现新证据或明确分歧才追问。',
    parameters: {
      mode: { type: 'string', required: true, enum: MODES, description: '会审类型：compare 方案比较 / review 盲审 / arbitrate 冲突裁定 / crosscheck 交叉核验' },
      question: { type: 'string', required: true, description: '要判断的问题本身，需自包含（Codex 看不到本对话）' },
      context: { type: 'string', description: '材料：需求原文、diff 摘要、测试结果、来源摘录' },
      options: { type: 'array', items: { type: 'string' }, description: 'mode=compare 时的候选方案（每条一句话）' },
      timeoutMs: { type: 'integer', description: '超时毫秒；默认 180000，夹在 30000~300000' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          mode: { type: 'string', required: true },
          ms: { type: 'integer', required: true },
          conclusion: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          counterexamples: { type: 'array', items: { type: 'string' } },
          verification: { type: 'string' },
          note: { type: 'string' },
          error: { type: 'string' },
          log: { type: 'string' },
          tail: { type: 'string' },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const mode = args?.mode;
      const question = String(args?.question || '').trim();
      const rejected = [];
      if (!MODES.includes(mode)) rejected.push('mode 必须是 ' + MODES.join(' / '));
      if (question.length < 10) rejected.push('question 太短（<10 字符），问题必须自包含');
      if (rejected.length) {
        return { ok: false, mode: String(mode || ''), ms: 0, error: rejected.join('; ') };
      }
      const timeoutMs = Math.min(Math.max(Number(args?.timeoutMs) || 180000, 30000), 300000);
      const res = await runConsult({
        mode,
        question,
        context: args?.context,
        options: Array.isArray(args?.options) ? args.options : [],
        timeoutMs,
        config: cfg,
      });
      const answer = res.answer || {};
      // 不用 undefined 占位：快照要求无损 JSON，缺键比 undefined 安全。
      return {
        ok: res.ok,
        mode,
        ms: res.ms,
        ...(answer.conclusion === undefined ? {} : { conclusion: answer.conclusion }),
        ...(answer.evidence === undefined ? {} : { evidence: answer.evidence }),
        ...(answer.counterexamples === undefined ? {} : { counterexamples: answer.counterexamples }),
        ...(answer.verification === undefined ? {} : { verification: answer.verification }),
        ...(res.note === undefined ? {} : { note: res.note }),
        ...(res.error === undefined ? {} : { error: res.error }),
        ...(res.log === undefined ? {} : { log: res.log }),
        ...(res.ok || res.tail === undefined ? {} : { tail: String(res.tail).slice(-2000) }),
        ...(res.raw === undefined ? {} : { tail: String(res.raw).slice(0, 2000) }),
      };
    },
  });
  register(consultTool);

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch {}
    }
  };
}
