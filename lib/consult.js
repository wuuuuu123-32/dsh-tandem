/**
 * 会审：让 Codex(GPT) 作为「第二个有边界的判断者」回答一个问题。
 *
 * 它不写文件、不动仓库，只做判断——这是刻意的边界：
 *  - 执行类任务走 delegate.js（并行派活）；
 *  - 判断类任务走这里（方案比较 / 盲审 / 冲突裁定 / 交叉核验）。
 *
 * 失败降级（实测依据）：回答必须含「结论/证据/反例/验证方式」，
 * 缺任一段或解析失败，一律标记 ok=false 并保留原文，不重试——
 * 重试只会重复同样的坏答案，还多花钱。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, openSync, closeSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { killTree } from './delegate.js';

export const MODES = ['compare', 'review', 'arbitrate', 'crosscheck'];

const MODE_HINTS = {
  compare: '用户在多个方案之间犹豫。分别指出每个方案的代价与失败模式，然后明确选一个并说明为什么；不要给「看情况」式的折中。',
  review: '这是对一份改动或需求的盲审。只挑问题：正确性、边界条件、误伤风险、缺失的验收。不要重写方案。',
  arbitrate: '存在至少两条互相矛盾的要求。说明哪条应当优先（依据：用户明确意愿 > 可复现的测试结果 > 权威原始资料 > 你的判断），并说明被牺牲那条如何补偿。',
  crosscheck: '把给出的材料互相核对，指出冲突与缺口。每条结论都要注明依据来自哪份材料或哪条要求。',
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['conclusion', 'evidence', 'counterexamples', 'verification'],
  properties: {
    conclusion: { type: 'string', description: '一句话明确结论；信息不足就写「信息不足」' },
    evidence: { type: 'array', items: { type: 'string' }, description: '支撑结论的证据，每条开头标注来源' },
    counterexamples: { type: 'array', items: { type: 'string' }, description: '结论可能错的反例或风险，至少一条' },
    verification: { type: 'string', description: '别人如何复核：命令、查看路径或核对方式' },
  },
};

function buildPrompt({ mode, question, context, options }) {
  const parts = [
    '你是一个有边界的判断者，不是执行者：不要修改任何文件、不要执行仓库里的命令，只做判断并按要求输出。',
    '任务类型：' + mode + '。' + (MODE_HINTS[mode] || ''),
    '',
    '问题：' + String(question || '').trim(),
  ];
  if (Array.isArray(options) && options.length) {
    parts.push('', '候选方案：', ...options.map((o, i) => (i + 1) + '. ' + String(o)));
  }
  if (context && String(context).trim()) {
    parts.push('', '材料：', String(context));
  }
  parts.push(
    '',
    '输出必须是单一 JSON 对象，符合给定 schema，不要包 markdown 代码块：',
    '{"conclusion": string, "evidence": string[], "counterexamples": string[], "verification": string}',
    'counterexamples 至少 1 条；确实没想到就写「未发现，但这不代表不存在」。',
  );
  return parts.join('\n');
}

/** 从 --json 事件流里取最后一条 agent_message 文本。 */
export function extractAnswer(logText) {
  const lines = String(logText || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const item = ev.item || (ev.msg && ev.msg.item);
    if (item && item.type === 'agent_message' && typeof item.text === 'string') return item.text;
  }
  return null;
}

export async function runConsult({ mode, question, context = '', options = [], timeoutMs = 180000, cwd = '', config }) {
  const started = Date.now();
  // 临时目录（prompt / schema / 日志）放 stateDir 下，不污染用户的工作根。
  // stateDir 未配置时退回第一个工作根，保持老版本行为。
  const base = config.stateDir || config.workRoots[0] || '.';
  const dir = join(base, '_tandem', 'consult-' + started);
  mkdirSync(dir, { recursive: true });
  const schemaPath = join(dir, 'schema.json');
  writeFileSync(schemaPath, JSON.stringify(SCHEMA, null, 2), 'utf8');
  const promptPath = join(dir, 'prompt.txt');
  const prompt = buildPrompt({ mode, question, context, options });
  writeFileSync(promptPath, prompt, 'utf8');
  const logPath = join(dir, 'consult.log');
  const fd = openSync(logPath, 'w');

  // 审查某个真实目录时，让 Codex 以它为工作目录：read-only 沙箱下读文件不受限，
  // 但 cwd 决定了它的相对路径基准与它「看得到哪个项目」的第一印象。
  // 目录不存在就退回临时目录，避免因为一个笔误让整次会审失败。
  let targetCwd = dir;
  if (cwd && String(cwd).trim()) {
    const want = resolve(String(cwd).trim());
    if (existsSync(want)) targetCwd = want;
  }

  // ❗只有配了 model 才传 -m：无条件传会让 config.model 缺失时变成 "-m undefined"，
  // Codex 直接 404（Model "undefined" is not supported ...）。不传时用 codex 自己的 config.toml。
  const modelArgs = config.model ? ['-m', String(config.model)] : [];
  const args = [
    'exec', '--skip-git-repo-check',
    '-s', 'read-only',
    '-c', 'approval_policy=never',
    ...modelArgs,
    '-C', targetCwd,
    '--json',
    '--output-schema', schemaPath,
  ];

  const result = await new Promise(resolve => {
    let child;
    try {
      child = spawn(config.codexCommand, args, {
        cwd: targetCwd, stdio: ['pipe', fd, fd], env: process.env, windowsHide: true,
      });
    } catch (error) {
      closeSync(fd);
      return resolve({ ok: false, error: '启动失败：' + error.message });
    }
    let settled = false;
    const finish = patch => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { closeSync(fd); } catch {}
      let text = '';
      try { text = readFileSync(logPath, 'utf8'); } catch {}
      let answer = null;
      if (patch.ok) {
        const raw = extractAnswer(text);
        if (raw) {
          try {
            answer = JSON.parse(raw);
          } catch {
            answer = null;
            patch.note = '模型输出不是合法 JSON，已保留原文';
            patch.raw = raw;
          }
        } else {
          patch.note = '未能从事件流提取最终回答';
        }
      }
      resolve({ ...patch, answer, dir, log: logPath, ms: Date.now() - started, tail: text.slice(-3000) });
    };
    const timer = setTimeout(async () => {
      await killTree(child.pid);
      finish({ ok: false, timedOut: true, error: '超时 ' + timeoutMs + 'ms，已杀进程树' });
    }, timeoutMs);
    child.on('error', error => finish({ ok: false, error: 'spawn 出错：' + error.message }));
    child.on('exit', code => finish(code === 0 ? { ok: true, code } : { ok: false, code, error: 'codex 退出码 ' + code }));
    try {
      child.stdin.end(prompt);
    } catch {}
  });
  return result;
}
