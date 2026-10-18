/**
 * 会审：让 Codex(GPT) 作为「第二个有边界的判断者」回答一个问题。
 *
 * 它不写文件、不动仓库，只做判断——这是刻意的边界：
 *  - 执行类任务走 delegate.js（并行派活）；
 *  - 判断类任务走这里（方案比较 / 盲审 / 冲突裁定 / 交叉核验）。
 *
 * ❗失败必须「有名有姓」（2026-10-17 加固）：
 * 老版本失败只返回「codex 退出码 1」，真实原因（上游内容策略拦截）躺在日志里没人看，
 * 调用方于是把「会审失败」当成「会审没意见」，直接跳过继续改代码。现在：
 *   ① 从 --json 事件流里解析 turn.failed 的真因，给出 reason；
 *   ② 空转（进程 0 退出但没有任何回答）单独识别，并自动重试一次；
 *   ③ 回答必须四段齐全且非空，缺段判 invalid_answer；
 *   ④ 每次结果追加到 <stateDir>/consult-history.jsonl，tandem_status 能回看最近一次。
 * 只有「空转」会自动重试——内容策略拦截重试必然同样被拦，模型名/凭据错重试也毫无意义。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, openSync, closeSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { killTree } from './delegate.js';
import { newReviewId, appendReview, pruneReviews, normalizePaths, fingerprintPaths } from './reviews.js';
import { loadTickets } from './tickets.js';

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

/** 四段齐全 + 非空才算有效回答。缺任一段 = 没有独立复核。 */
export function validAnswer(a) {
  if (!a || typeof a !== 'object') return false;
  if (typeof a.conclusion !== 'string' || a.conclusion.trim() === '') return false;
  if (!Array.isArray(a.evidence) || a.evidence.length === 0) return false;
  if (!Array.isArray(a.counterexamples) || a.counterexamples.length === 0) return false;
  if (typeof a.verification !== 'string' || a.verification.trim() === '') return false;
  return true;
}

/** 每种失败该让调用方做什么——没有行动指令的报错等于没报。 */
const HINTS = {
  policy_blocked: '上游内容策略拦下了提示词。改写措辞（去掉可能触发的技术细节，改成中性描述）后重试一次；仍被拦就直接报告「未获独立复核」，不要跳过会审继续实施改动。',
  auth_failed: 'Codex 凭据无效或缺失。先跑 tandem_status 核对，修好凭据再试——这不是「没有意见」。',
  rate_limited: '上游限流。等一会儿再试，不要连发。',
  model_not_found: '模型名不被上游接受。核对 tandem_status 里的 model 与上游可用模型列表。',
  empty_response: '进程正常退出但没有任何回答（空转）。已自动重试过一次；仍为空就换一种问法再试。',
  timeout: '超时已杀进程树。缩小材料体积或提高 timeoutMs 后重试。',
  spawn_failed: 'Codex 启动失败。核对路径与全局安装。',
  invalid_answer: '回答不合法（不是 JSON 或缺四段之一）。原文在 tail 里，据此判断要不要重新提问。',
  unknown: '未能识别失败原因，原文在 tail 里。不要假设它通过。',
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

/** 从事件流里取 turn.failed 的错误原文（老版本只报了退出码，原因丢在这里）。 */
export function extractFailure(logText) {
  for (const line of String(logText || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{') || t.indexOf('turn.failed') < 0) continue;
    try {
      const ev = JSON.parse(t);
      if (ev.type === 'turn.failed' && ev.error && typeof ev.error.message === 'string') return ev.error.message;
    } catch { /* 不是完整 JSON 就跳过 */ }
  }
  return '';
}

/** 把失败归类成可行动的 reason。 */
export function classifyFailure({ code, logText, timedOut, error }) {
  if (timedOut) return 'timeout';
  if (error && /spawn|启动失败/i.test(error)) return 'spawn_failed';
  const msg = extractFailure(logText);
  if (/flagged as potentially violating|usage polic|content policy/i.test(msg)) return 'policy_blocked';
  if (/401|unauthorized|invalid[^,]*api[ _-]?key|authentication/i.test(msg)) return 'auth_failed';
  if (/429|rate[ _-]?limit|too many requests/i.test(msg)) return 'rate_limited';
  if (/is not supported|model[^\n]*not found|unknown model/i.test(msg)) return 'model_not_found';
  if (code !== 0 && msg === '' && !extractAnswer(logText)) return 'empty_response';
  return 'unknown';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 历史记录：每行一条 JSON，便于 status 回看「最近一次到底成没成」。 */
export function appendHistory(base, record) {
  const file = join(base, 'consult-history.jsonl');
  try { appendFileSync(file, JSON.stringify(record) + '\n', 'utf8'); } catch { /* 审计写不进去不该让会审本身失败 */ }
  return file;
}

export function readLastConsult(base) {
  const file = join(base, 'consult-history.jsonl');
  if (!existsSync(file)) return null;
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* 跳过坏行 */ }
  }
  return null;
}

/** 单次尝试：跑一次 codex，返回结构化结果。 */
async function attemptOnce({ mode, question, context, options, timeoutMs, cwd, config, base, attempt }) {
  const started = Date.now();
  const dir = join(base, '_tandem', 'consult-' + started + '-' + attempt);
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
  let targetCwd = dir;
  if (cwd && String(cwd).trim()) {
    const want = resolve(String(cwd).trim());
    if (existsSync(want)) targetCwd = want;
  }

  // ❗只有配了 model 才传 -m：无条件传会让 config.model 缺失时变成 "-m undefined"，
  // Codex 直接 404（Model "undefined" is not supported ...）。
  const modelArgs = config.model ? ['-m', String(config.model)] : [];
  const args = [
    'exec', '--skip-git-repo-check',
    '-s', 'read-only',
    '-c', 'approval_policy=never',
    // ❗Codex 0.163 默认开启 multi_agent（features list 里 stable=true）：在非交互 exec 下
    // 模型会调用协作工具 collab wait（receiver_thread_ids 为空）然后永久挂起 —— 实测一条
    // 2K 字符的评审 prompt 172s 无任何输出。必须显式关掉，否则会审和交付都会卡到超时。
    '--disable', 'multi_agent',
    // 同 delegate.js：禁用全局 MCP，避免非交互 exec 里反复启动失败的 MCP 工具拖慢/污染输出。
    '-c', 'mcp_servers={}',
    ...modelArgs,
    '-C', targetCwd,
    '--json',
    '--output-schema', schemaPath,
  ];

  return await new Promise(resolveOnce => {
    let child;
    try {
      child = spawn(config.codexCommand, args, {
        cwd: targetCwd, stdio: ['pipe', fd, fd], env: process.env, windowsHide: true,
      });
    } catch (error) {
      closeSync(fd);
      return resolveOnce({ ok: false, reason: 'spawn_failed', error: '启动失败：' + error.message, dir, log: logPath, ms: Date.now() - started, tail: '' });
    }
    let settled = false;
    const finish = patch => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { closeSync(fd); } catch {}
      let text = '';
      try { text = readFileSync(logPath, 'utf8'); } catch {}
      const out = { ...patch, dir, log: logPath, ms: Date.now() - started, tail: text.slice(-3000) };
      if (out.ok) {
        const raw = extractAnswer(text);
        if (!raw) {
          out.ok = false;
          out.reason = 'empty_response';
          out.note = '进程退出 0，但没有取到任何 agent_message';
        } else {
          let answer = null;
          try { answer = JSON.parse(raw); } catch { answer = null; }
          if (answer === null) {
            out.ok = false;
            out.reason = 'invalid_answer';
            out.note = '模型输出不是合法 JSON，已保留原文';
            out.raw = raw;
          } else if (!validAnswer(answer)) {
            out.ok = false;
            out.reason = 'invalid_answer';
            out.note = '回答缺四段之一或某段为空（结论/证据/反例/验证方式）';
            out.answer = answer;
          } else {
            out.answer = answer;
          }
        }
      } else {
        out.reason = out.reason || classifyFailure({ code: out.code, logText: text, timedOut: out.timedOut, error: out.error });
      }
      // 只有失败才给行动指令：成功时挂一条「未能识别失败原因」会误导调用方。
      if (!out.ok) out.hint = HINTS[out.reason] || HINTS.unknown;
      resolveOnce(out);
    };
    const timer = setTimeout(async () => {
      await killTree(child.pid);
      finish({ ok: false, timedOut: true, error: '超时 ' + timeoutMs + 'ms，已杀进程树' });
    }, timeoutMs);
    child.on('error', error => finish({ ok: false, error: 'spawn 出错：' + error.message }));
    child.on('exit', code => finish(code === 0 ? { ok: true, code } : { ok: false, code, error: 'codex 退出码 ' + code }));
    try { child.stdin.end(prompt); } catch {}
  });
}

/**
 * 会审入口。
 * 只有「空转」会自动重试一次（瞬时故障）；其余失败原样返回 reason + hint，
 * 让调用方知道「这不是没意见，是没审成」。
 */
export async function runConsult({ mode, question, context = '', options = [], timeoutMs = 180000, cwd = '', paths = [], config }) {
  const started = Date.now();
  const base = config.stateDir || config.workRoots[0] || '.';
  const MAX_ATTEMPTS = 2;
  let last = null;
  let attempts = 0;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    attempts = i;
    last = await attemptOnce({ mode, question, context, options, timeoutMs, cwd, config, base, attempt: i });
    if (last.ok) break;
    if (last.reason === 'empty_response' && i < MAX_ATTEMPTS) { await sleep(2000); continue; }
    break;
  }
  // 只有真拿到有效四段答案才签发 reviewId。它标的是「这块内容被独立复核过」，
  // 不是使用配额：同一个 id 可以在它覆盖的路径上反复派活、反复检查。
  // id 由本进程随机生成，模型写不出真的 —— 伪造的 id 在 delegate/check 时查不到，当场暴露。
  let review = null;
  const coveredPaths = normalizePaths(paths);
  // paths 为空不签发：没有覆盖范围，这张标记就对任何任务都成立，等于发了个万能章。
  if (last.ok && base && coveredPaths.length > 0) {
    review = {
      reviewId: newReviewId(),
      at: new Date().toISOString(),
      mode,
      questionHead: String(question || '').slice(0, 200),
      paths: coveredPaths,
      fingerprint: fingerprintPaths(coveredPaths),
      ms: Date.now() - started,
    };
    appendReview(base, review);
    try {
      // 轮转时保住仍被票据引用的凭证：票据是「这次改动经过会审」的证据链，不能因轮转断掉。
      const keep = new Set();
      for (const t of Object.values(loadTickets(base))) if (t && t.reviewId) keep.add(t.reviewId);
      pruneReviews(base, { max: 200, keep });
    } catch {}
  }
  const record = {
    at: new Date(started).toISOString(),
    mode,
    question: String(question || '').slice(0, 120),
    ok: !!last.ok,
    reason: last.ok ? null : (last.reason || 'unknown'),
    attempts,
    ms: Date.now() - started,
    dir: last.dir,
    reviewId: review ? review.reviewId : null,
  };
  const historyFile = appendHistory(base, record);
  const reviewNote = last.ok && !review
    ? '未指定 paths，未签发 reviewId：没有覆盖范围的标记无法证明任何内容是审过的'
    : null;
  return { ...last, attempts, history: historyFile, reviewId: review ? review.reviewId : null, review, reviewNote };
}
