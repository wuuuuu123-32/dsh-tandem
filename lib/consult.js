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
import { loadCredentialRef } from './env.js';

export const MODES = ['compare', 'review', 'arbitrate', 'crosscheck'];

/**
 * 会审可用的上游（2026-10-28 加）。
 *
 * 为什么不写在 ~/.codex/config.toml 就完事：Codex 的全局配置只能有一套 model/model_provider，
 * 而双轨对照要「同一个问题、两种上游、同一次调用里都跑到」。所以这里用 -c 覆盖，
 * 并把 env_key 对应的凭据直接从 ~/.dsh/.credentials.yaml 补进子进程环境。
 *
 * portdan 是历史唯一路径（默认）；aisz 是第二条线，用于比较失败率与速度。
 */
export const CONSULT_PROVIDERS = {
  portdan: { provider: 'portdan', model: 'gpt-6.1-sol', envKey: 'PORTDAN_API_KEY' },
  aisz: { provider: 'aisz', model: 'gpt-6.1-terra', envKey: 'AISZ_API_KEY' },
};

/**
 * 名字 → profile；空名字返回 null。
 * ❗null 不等于「沿用 Codex 全局配置」：runConsult 见到 null 会直接用表内固定的 portdan（gpt-6.1-sol），
 * 不会去读 ~/.codex/config.toml 里的 model。旧注释写成「沿用全局配置」是错的，
 * 会让人以为改全局配置能换掉会审的上游。
 */
export function resolveProvider(name) {
  const key = String(name || '').trim();
  if (!key) return null;
  const p = CONSULT_PROVIDERS[key];
  return p ? { ...p, name: key } : null;
}

/** 子进程环境：缺哪个 key 就补哪个，不覆盖已有的。 */
function profileEnv(profile) {
  if (!profile || !profile.envKey) return process.env;
  const env = { ...process.env };
  if (!env[profile.envKey]) {
    const v = loadCredentialRef(profile.envKey);
    if (v) env[profile.envKey] = v;
  }
  return env;
}

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
  missing_env: '上游 key 没进到子进程环境：在 ~/.dsh/.credentials.yaml 的 refs 段补上对应的 KEY（consult.js 的 CONSULT_PROVIDERS 里写着各上游要哪个键），或设成同名用户环境变量。',
  rate_limited: '上游限流。等一会儿再试，不要连发。',
  model_not_found: '模型名不被上游接受。核对 tandem_status 里的 model 与上游可用模型列表。',
  empty_response: '进程正常退出但没有任何回答（空转）。已自动重试过一次；仍为空就换一种问法再试。',
  timeout: '超时已杀进程树。缩小材料体积或提高 timeoutMs 后重试。',
  spawn_failed: 'Codex 启动失败。核对路径与全局安装。',
  invalid_answer: '回答不合法（不是 JSON 或缺四段之一）。原文在 tail 里，据此判断要不要重新提问。',
  budget_exhausted: '总预算已耗尽，这次没有真正跑完。不是没有意见：要么提高 deadlineMs / timeoutMs，要么缩减材料，再单独问一次。',
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
  // ❗策略拦截的措辞各家不一样，只认 portdan 那一种会把别家的拦截推进 unknown，
  // 而 unknown 既可重试又可切换 —— 对内容拦截来说，重试和换后端都是在绕策略。
  if (/flagged as potentially violating|usage polic|content polic|violates our|safety system|content[ _-]?filter|moderation|invalid[ _-]?prompt/i.test(msg)) return 'policy_blocked';
  // 缺环境变量要在 auth 之前判：它的原文是 Missing environment variable: `X`，
  // 归到 auth_failed 会让人去查 key 对不对，其实是 key 根本没传进子进程。
  if (/missing environment variable/i.test(msg)) return 'missing_env';
  // insufficient balance/quota 也归这里：凭据本身没错，但这家已经不能用，换后端是真的有意义。
  if (/401|unauthorized|invalid[^,]*api[ _-]?key|incorrect api key|no api key|authentication/i.test(msg)) return 'auth_failed';
  if (/insufficient (balance|quota)|quota exceeded|billing_error/i.test(msg)) return 'auth_failed';
  if (/429|rate[ _-]?limit|too many requests|concurrency[ _-]?limit|too many concurrent/i.test(msg)) return 'rate_limited';
  if (/is not supported|model[^\n]*not found|unknown model|not available for this group|model[^\n]*does not exist/i.test(msg)) return 'model_not_found';
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
async function attemptOnce({ mode, question, context, options, timeoutMs, cwd, config, base, attempt, profile, deadlineAt = 0 }) {
  const started = Date.now();
  // ❗后缀必须唯一：dual 会并行起两个进程，Date.now() 同毫秒命中时
  // 两条会用同一个目录，prompt.txt 与 consult.log 互相覆盖，日志里读到的可能是另一条的回答。
  const dir = join(base, '_tandem', 'consult-' + started + '-' + attempt + '-' + Math.random().toString(36).slice(2, 6));
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
  // profile 给定时用 -c 覆盖 provider 与模型（双轨对照）；否则沿用 Codex 全局配置。
  const modelArgs = profile
    ? ['-c', 'model_provider=' + profile.provider, '-m', profile.model]
    : (config.model ? ['-m', String(config.model)] : []);
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

  // ❗准备阶段（建目录、写 prompt、算 cwd）也要花时间：入口检查过预算，不等于现在还有。
  // 起进程前再核一次，已经不够就按预算耗尽返回，别让调用方干等一个注定超时的进程。
  if (deadlineAt && Date.now() > deadlineAt - 5000) {
    try { closeSync(fd); } catch {}
    return { ok: false, reason: 'budget_exhausted', notStarted: true, note: '准备阶段已耗尽总预算，没有启动 Codex', dir, log: logPath, ms: Date.now() - started, tail: '' };
  }

  return await new Promise(resolveOnce => {
    let child;
    try {
      child = spawn(config.codexCommand, args, {
        cwd: targetCwd, stdio: ['pipe', fd, fd], env: profileEnv(profile), windowsHide: true,
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
    // ❗超时与 exit 存在竞态：killTree 是异步的，exit 事件可能在它完成之前先到。
    // 旧写法先 await killTree 再 finish，于是 exit 抢先 finish，超时被按「退出码非 0」分类成
    // unknown → 触发一次毫无意义的同后端重试，而下一个进程可能在旧进程树还没清干净时就启动。
    // 现在超时一触发就先占位（timedOutFired），之后所有 finish 一律按超时归类，并且等进程树清完才返回。
    let timedOutFired = false;
    let killing = null;
    const timer = setTimeout(() => {
      timedOutFired = true;
      // killTree 的结果要分三种，不能一律当成功：
      // ① 真的清完了 ② 清理本身报错 ③ 迟迟不返回。三种对调用方意味着不同的残余风险。
      let killState = 'pending';
      let killError = '';
      killing = Promise.resolve()
        .then(() => killTree(child.pid))
        .then(() => { killState = 'done'; })
        .catch(e => { killState = 'failed'; killError = (e && e.message) || String(e); });
      // ❗清理不能无限等：killTree 若卡住（taskkill 挂起、系统资源耗尽），
      // finish 永远不执行，调用方会被拖过 deadline —— 那就把「到点就收手」变成了空话。
      // 兜底时长还要服从总预算：预算里只给清理留了 3 秒，这里最多再等 min(5s, 剩余到 deadline 的时间)。
      const graceMs = deadlineAt ? Math.max(0, Math.min(5000, deadlineAt - Date.now())) : 5000;
      const cleared = Promise.race([
        killing.then(() => ({ elapsed: true })),
        new Promise(r => setTimeout(() => r({ elapsed: false }), graceMs)),
      ]);
      cleared.then(() => {
        const msg = killState === 'done'
          ? '超时 ' + timeoutMs + 'ms，已杀进程树'
          : killState === 'failed'
            ? '超时 ' + timeoutMs + 'ms，杀进程树失败（' + killError + '），可能仍有残余 Codex 进程'
            : '超时 ' + timeoutMs + 'ms，进程树 ' + graceMs + 'ms 内未清理完（可能仍有残余 Codex 进程）';
        finish({ ok: false, timedOut: true, error: msg });
      });
    }, timeoutMs);
    // spawn 阶段的 ENOENT/EACCES 必须明确归 spawn_failed：它是本机执行器的问题，
    // 让 classifyFailure 猜成 unknown 会触发一次毫无意义的跨后端切换。
    child.on('error', error => finish({ ok: false, reason: 'spawn_failed', error: 'spawn 出错：' + error.message }));
    child.on('exit', code => {
      if (timedOutFired) {
        // 超时之后才退：结论是「超时」，不是退出码。等清理完成再落定，避免两个进程重叠。
        (killing || Promise.resolve()).then(() => finish({ ok: false, timedOut: true, error: '超时 ' + timeoutMs + 'ms，已杀进程树' }));
        return;
      }
      finish(code === 0 ? { ok: true, code } : { ok: false, code, error: 'codex 退出码 ' + code });
    });
    try { child.stdin.end(prompt); } catch {}
  });
}

/**
 * 会审入口。
 *
 * 失败处理（2026-10-28 双轨会审后的定论，改之前先看这段）：
 *  - RETRYABLE：同一后端重试一次有意义（瞬时/偶发）—— 空转、限流、未知、模型未找到、四段不齐。
 *  - SWITCHABLE：换到另一个后端有意义（provider 级故障）。
 *  - timeout 不重试：再给一整个 timeoutMs 大概率仍不够，总时长翻倍 → 直接把预算让给备用后端。
 *  - spawn_failed / missing_env / policy_blocked 既不重试也不切换：前两个是本机执行器与共享配置的问题，
 *    换后端只会用同样方式再失败一次；policy_blocked 是内容级拦截，换个后端再问等于绕过策略，不做。
 *  - 只有「没显式指定 provider」才跨后端切换；显式指定视为钉死，failover:true 可强制打开。
 *  - 全程受一个总 deadline 约束，切换只花剩余预算，不把单次超时简单累加成总时长。
 */
const RETRYABLE = new Set(['empty_response', 'rate_limited', 'unknown', 'model_not_found', 'invalid_answer']);
const SWITCHABLE = new Set(['empty_response', 'rate_limited', 'unknown', 'model_not_found', 'invalid_answer', 'auth_failed', 'timeout']);
const FAILOVER_TIMEOUT_CAP = 120000;
// 给「后面还有后端」预留的预算。默认总预算 360s，主端两次各能吃到 180s，正好把预算吃干 ——
// 备用一次都启动不了，于是配了故障切换却永远切不过去；只有快速失败（几秒）时看着像能用。
const FAILOVER_RESERVE = 90000;

export async function runConsult({ mode, question, context = '', options = [], timeoutMs = 180000, cwd = '', paths = [], config, provider = '', failover = null, deadlineMs = 0 }) {
  const started = Date.now();
  const base = config.stateDir || config.workRoots[0] || '.';
  const profile = resolveProvider(provider);
  // 总预算：显式给了就用，否则按「两次单次尝试」估，上下夹住。
  const deadline = Math.min(Math.max(Number(deadlineMs) || Number(timeoutMs) * 2 || 360000, 60000), 900000);
  const remaining = () => deadline - (Date.now() - started);

  const stages = [];
  if (profile) {
    stages.push({ tag: profile.name, profile, maxAttempts: 2, single: true });
    // 显式指定 provider 默认视为钉死。但参数说明里写着「传 failover:true 可强制打开」，
    // 旧代码却始终只建单后端 —— 说得到做不到。现在按说明真的补上另一条后端。
    if (failover === true) {
      const other = profile.name === 'portdan' ? 'aisz' : 'portdan';
      stages.push({ tag: other, profile: CONSULT_PROVIDERS[other], maxAttempts: 1 });
    }
  } else {
    stages.push({ tag: 'portdan', profile: CONSULT_PROVIDERS.portdan, maxAttempts: 2 });
    if (failover !== false) stages.push({ tag: 'aisz', profile: CONSULT_PROVIDERS.aisz, maxAttempts: 1 });
  }

  const attemptsLog = [];
  let last = null;
  let attempts = 0;
  let failoverFrom = null;
  let stoppedBy = null;

  outer: for (let si = 0; si < stages.length; si++) {
    const stage = stages[si];
    // 还没轮到的后端要留预算：不留就会出现「主端慢失败吃掉全部预算、备用一次没启动」。
    const reserve = si < stages.length - 1 ? FAILOVER_RESERVE : 0;
    for (let i = 1; i <= stage.maxAttempts; i++) {
      const left = remaining() - 3000;   // 留出进程清理与写盘的余量
      // 预算不够（含给后续后端留的那份）就别起了，起了也是白烧
      if (left - reserve < 15000) { stoppedBy = 'budget'; break outer; }
      const cap = stage.single
        ? (Number(timeoutMs) || 180000)
        : (stage.tag === 'aisz' ? Math.min(Number(timeoutMs) || 180000, FAILOVER_TIMEOUT_CAP) : Number(timeoutMs) || 180000);
      const useTimeout = Math.max(15000, Math.min(cap, left - reserve));
      attempts++;
      const t0 = Date.now();
      last = await attemptOnce({ mode, question, context, options, timeoutMs: useTimeout, cwd, config, base, attempt: attempts, profile: stage.profile, deadlineAt: started + deadline });
      // 「发生过切换」必须以真的启动过进程为准：attemptOnce 可能在建目录/写文件/读凭据阶段
      // 就因为预算不够返回 notStarted。放在调用之前会把「备用一次都没起」记成已切换。
      if (si > 0 && !last.notStarted && !failoverFrom) failoverFrom = stages[0].tag;
      // reason 用条件展开而不是 null：output.schema 里是可选的 string，null 会被校验拒
      attemptsLog.push({
        provider: stage.tag,
        ok: !!last.ok,
        ms: Number.isFinite(last.ms) ? last.ms : (Date.now() - t0),
        timeoutMs: useTimeout,
        ...(last.ok ? {} : { reason: last.reason || 'unknown' }),
        // false = 进程根本没起来（准备阶段就发现预算不够）。不标出来的话，
        // 历史里这一条和「真的调用了上游但失败」长得一样，预算问题会被误读成上游问题。
        ...(last.notStarted ? { started: false } : {}),
      });
      if (last.notStarted) {
        // 进程没起来就不算一次尝试：回退计数，避免「预算截停」被统计成「上游失败」。
        attempts--;
        stoppedBy = 'budget';
        break outer;
      }
      if (last.ok) {
        if (stage !== stages[0]) failoverFrom = stages[0].tag;
        break outer;
      }
      if (i < stage.maxAttempts && RETRYABLE.has(last.reason)) { await sleep(2000); continue; }
      break;
    }
    // 走到这里说明当前后端没成：本地/共同问题就直接收手，不再浪费另一个后端的时间
    if (!last || !SWITCHABLE.has(last.reason)) break outer;
  }

  // 只有真拿到有效四段答案才签发 reviewId。它标的是「这块内容被独立复核过」，
  // 不是使用配额：同一个 id 可以在它覆盖的路径上反复派活、反复检查。
  // id 由本进程随机生成，模型写不出真的 —— 伪造的 id 在 delegate/check 时查不到，当场暴露。
  let review = null;
  let reviewWriteError = null;
  const coveredPaths = normalizePaths(paths);
  // paths 为空不签发：没有覆盖范围，这张标记就对任何任务都成立，等于发了个万能章。
  if (last && last.ok && base && coveredPaths.length > 0) {
    review = {
      reviewId: newReviewId(),
      at: new Date().toISOString(),
      mode,
      questionHead: String(question || '').slice(0, 200),
      paths: coveredPaths,
      fingerprint: fingerprintPaths(coveredPaths),
      ms: Date.now() - started,
    };
    // 票据写不进去时**不签发**：reviewId 的唯一用途是「被派活/被查验时能查到这个 id」，
    // 没落盘就返回一个查不到的 id，等于给了张空头凭证，调用方会以为这部分内容审过了。
    // 会审本身仍然算成功（ok/答案不变），只是没有凭证。
    try { appendReview(base, review); } catch (e) {
      console.error('[tandem] appendReview 失败，本次不签发 reviewId：' + e.message);
      reviewWriteError = e.message;
      review = null;
    }
    try {
      // 轮转时保住仍被票据引用的凭证：票据是「这次改动经过会审」的证据链，不能因轮转断掉。
      const keep = new Set();
      for (const t of Object.values(loadTickets(base))) if (t && t.reviewId) keep.add(t.reviewId);
      pruneReviews(base, { max: 200, keep });
    } catch {}
  }
  const finalProvider = attemptsLog.length ? attemptsLog[attemptsLog.length - 1].provider : (profile ? profile.name : 'default');
  const record = {
    at: new Date(started).toISOString(),
    mode,
    question: String(question || '').slice(0, 120),
    ok: !!(last && last.ok),
    reason: last && last.ok ? null : (last ? (last.reason || 'unknown') : 'budget_exhausted'),
    attempts,
    provider: finalProvider,
    failoverFrom,
    attemptsLog,
    ms: Date.now() - started,
    dir: last ? last.dir : null,
    reviewId: review ? review.reviewId : null,
    // 预算挡下后续尝试时要说清楚：否则调用方看到 reason=model_not_found，
    // 会以为是「主端挂了备用也不行」，实际是备用根本没被启动过。
    ...(stoppedBy ? { stoppedBy } : {}),
  };
  const historyFile = appendHistory(base, record);
  const reviewNote = last && last.ok && !review
    ? (reviewWriteError
      ? '票据写入失败（' + reviewWriteError + '），本次不签发 reviewId：没落盘的标记查不到，返回它等于空头凭证'
      : '未指定 paths，未签发 reviewId：没有覆盖范围的标记无法证明任何内容是审过的')
    : null;
  const budgetNote = stoppedBy === 'budget'
    ? '总预算不足，后续的重试或换后端已被预算挡下；这里的 reason 只代表最后一次真正跑完的尝试，不代表备用后端也失败'
    : null;
  return {
    ...last,
    // ms 必须是整次会审的墙钟（含重试与切换），不是最后一次尝试的耗时。
    // 曾经漏了这一行，failover 场景下 54 秒的会审上报成 14 秒，会把「切换很便宜」这个假象写进统计。
    ms: Date.now() - started,
    attempts,
    provider: finalProvider,
    failoverFrom,
    attemptsLog,
    deadlineMs: deadline,
    history: historyFile,
    reviewId: review ? review.reviewId : null,
    review,
    reviewNote,
    budgetNote,
    ...(stoppedBy ? { stoppedBy } : {}),
    // 零次尝试（预算一开始就不够）时 last 是 null，展开后没有 ok/reason：
    // 那会让调用方拿到一个既没 ok 也没 reason 的对象，看起来像成功。
    ...(last ? {} : { ok: false, reason: 'budget_exhausted' }),
  };
}
