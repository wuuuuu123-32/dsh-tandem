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
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, openSync, closeSync, existsSync, renameSync, unlinkSync, readdirSync, statSync, linkSync } from 'node:fs';
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
  portdan: { provider: 'portdan', model: 'gpt-6.1-sol', envKey: 'PORTDAN_API_KEY', baseURL: 'https://portdan.com/v1' },
  tokenfuture: { provider: 'tokenfuture', model: 'gpt-6.1-sol', envKey: 'TOKENFUTURE_API_KEY', baseURL: 'https://tokenfuture.si/v1' },
  aisz: { provider: 'aisz', model: 'gpt-6.1-terra', envKey: 'AISZ_API_KEY', baseURL: 'https://api1.aisz.mom/v1' },
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

/* ───────────────────────── 会审后端状态（2026-11-07） ─────────────────────────
 * 用户定的优先级：每天第一次会审用 portdan；其余优先 tokenfuture（免费额度）；
 * tf 余额烧完回到 portdan；portdan 也不行才到 aisz。
 *
 * 两个必须落盘的状态：
 *   ① 当天是否已经用过 portdan —— 否则并发两个会审都会把自己当「今天第一次」；
 *   ② tf 何时被判定没余额 —— 否则每一次会审都要先撞一次 402 才降级，白等十几秒。
 *
 * 为什么用「按天命名的锁文件」而不是读改写 JSON：JSON 的 read-modify-write 不是原子操作，
 * 两个进程同时读到「今天还没用过」就都会去用 portdan。openSync(..., 'wx') 创建失败即 EEXIST，
 * 这个判定是内核级的，天然互斥，不需要额外加锁文件或抢占逻辑。
 */
export const TF_EXHAUST_TTL = 24 * 3600 * 1000;

/** 本地时区的 YYYY-MM-DD。用 toISOString 会按 UTC 切天，东八区会把凌晨 8 点算成前一天。 */
export function localDay(ts = Date.now()) {
  const d = new Date(ts);
  const z = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
}

/**
 * 状态拆成两个文件，不是一个 provider-state.json。
 *
 * 原因：读—合并—写不是原子操作。两个会审同时结束，一个写 lastPortdanDay、另一个写
 * tfExhaustedAt，后写的那次会用旧快照覆盖掉前一个字段 —— 冷却状态就这么丢了。
 * 拆开之后两个字段各写各的文件，rename 是原子的，互不覆盖。
 * （会话锁 portdan-day-*.lock 本来就独立，不受影响。）
 */
export function providerStatePath(base) { return join(base, 'provider-state.json'); }
export function portdanUsedPath(base) { return join(base, 'portdan-used.json'); }
export function tfExhaustedPath(base) { return join(base, 'tf-exhausted.json'); }

function readJson(file) {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch { return null; }
}

/** 原子写（临时文件 + rename）：写一半断电不会留下半个 JSON 让下次启动直接崩。 */
function atomicWrite(file, value) {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    // 状态写不进去只影响「下次优先谁」，不该让会审本身失败。
    console.error('[tandem] 写 ' + file + ' 失败：' + e.message);
  }
}

export function readProviderState(base) {
  const out = {};
  const used = readJson(portdanUsedPath(base));
  // 按天文件是更权威的来源：有它就意味着今天已经认领过（哪怕 portdan-used.json 还没写）
  if (portdanDayUsed(base)) { out.lastPortdanDay = localDay(); }
  if (used && used.day) { out.lastPortdanDay = used.day; out.lastPortdanAt = used.at; }
  const tf = readJson(tfExhaustedPath(base));
  if (tf && tf.at) { out.tfExhaustedAt = tf.at; out.tfExhaustedReason = tf.reason; }
  // 兼容 0.7.0 早期版本写的单文件（升级后第一次读还能认出当天的记录）
  // 只在「新文件根本不存在」时才看旧文件。若新文件在但字段是 null（明确清除过），
  // 再用旧文件兜底等于把刚清掉的冷却又复活回来。
  const legacy = readJson(providerStatePath(base));
  if (legacy) {
    if (!existsSync(portdanUsedPath(base)) && legacy.lastPortdanDay) { out.lastPortdanDay = legacy.lastPortdanDay; out.lastPortdanAt = legacy.lastPortdanAt; }
    if (!existsSync(tfExhaustedPath(base)) && legacy.tfExhaustedAt) { out.tfExhaustedAt = legacy.tfExhaustedAt; out.tfExhaustedReason = legacy.tfExhaustedReason; }
  }
  return out;
}

/** 按字段分派到各自的文件；传 undefined 表示清掉该字段。 */
export function writeProviderState(base, patch) {
  // ❗缺的字段写 null，**不**从磁盘抄旧值。
  // 抄旧值等于「A 读到旧冷却 → 暂停 → B 清除 → A 把旧值写回」，冷却会复活（会审 b4）。
  // 宁可少记一次冷却（下次还会再撞一次余额错误），也不要因为一次部分更新把 tf 白停 24 小时。
  if ('lastPortdanDay' in patch || 'lastPortdanAt' in patch) {
    atomicWrite(portdanUsedPath(base), { day: patch.lastPortdanDay || null, at: patch.lastPortdanAt || null });
  }
  if ('tfExhaustedAt' in patch || 'tfExhaustedReason' in patch) {
    atomicWrite(tfExhaustedPath(base), { at: patch.tfExhaustedAt || null, reason: patch.tfExhaustedReason || null });
  }
  return readProviderState(base);
}


/**
 * 认领「今天的首次会审」。返回 true 表示本进程拿到，其余并发进程返回 false。
 * 注意：拿到认领 ≠ 已经用过 —— 如果 portdan 因为预算不足根本没启动，
 * 调用方不应把 lastPortdanDay 写死（否则当天后续都跳过 portdan，而它一次都没跑过）。
 *
 * 锁里写 pid 与时间戳，解决两个只有崩溃/极端时序才会暴露的问题：
 *   ① 进程在认领后、释放前被杀 → 锁永久留在磁盘上，当天再也轮不到 portdan；
 *      超过 STALE_LOCK_MS 的锁视为陈旧，删掉重认。
 *   ② 陈旧锁被回收后由别的进程重新认领，而「复活」的旧进程按路径去 unlink，
 *      会把别人的锁删掉 —— 所以释放前必须确认这把锁仍是自己那把。
 */
/**
 * 「今天是否已经用过 portdan」= 当天那份认领文件存在。
 * 认领是**按天命名的一次性文件**：openSync(file,'wx') 成功即拥有，EEXIST 即别人拥有。
 * 一个系统调用就是全部判定 —— 没有「先读后删」的窗口，也没有谁都删不掉对方的可能。
 *
 * 之前用「rename 抢占 + linkSync 放回」来回收陈旧锁，代价是 rename 会把原路径腾空：
 * 第三人可以在那个空档里 openSync 成功，于是 A 和 C 都以为自己拥有当天资格（会审 a4）。
 * 按天分文件后谁也不删谁的文件，这个交错不存在了。
 */
export function portdanDayPath(base, day = localDay()) { return join(base, `portdan-used-${day}.json`); }
export function portdanDayUsed(base, day = localDay()) { return existsSync(portdanDayPath(base, day)); }

/** 顺手清掉一周前的认领文件（只清确定过期的，今天的绝不动）。 */
function prunePortdanDays(base, keepDay) {
  try {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of readdirSync(base)) {
      const m = /^portdan-used-(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (!m || m[1] === keepDay) continue;
      const full = join(base, f);
      try { if (statSync(full).mtimeMs < cutoff) unlinkSync(full); } catch { /* 忽略 */ }
    }
  } catch { /* 目录不存在就算了 */ }
}

export function claimPortdanDay(base, day = localDay()) {
  const file = portdanDayPath(base, day);
  try {
    mkdirSync(base, { recursive: true });
    const fd = openSync(file, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), started: false }));
    closeSync(fd);
    prunePortdanDays(base, day);
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;          // 今天已经有人认领了
    console.error('[tandem] 认领当日首选失败：' + (e && e.message));
    return false;
  }
}

/** portdan 真的起来了：标成 started，此后不允许再归还（它已经花过钱了）。 */
export function markPortdanStarted(base, day = localDay()) {
  const file = portdanDayPath(base, day);
  try {
    if (!existsSync(file)) return;
    writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), started: true }));
  } catch (e) { console.error('[tandem] 标记当日首选失败：' + (e && e.message)); }
}

/**
 * 归还当天资格：只在文件还是认领时那副 `started:false` 的样子才删。
 * 删除不需要抢占 —— 最坏是两个人同时归还同一个文件，删两次结果一样。
 */
export function releasePortdanDay(base, day = localDay()) {
  const file = portdanDayPath(base, day);
  try {
    const o = JSON.parse(readFileSync(file, 'utf8') || '{}');
    if (o && o.started) return false;                    // 真跑过，不放
    unlinkSync(file);
    return true;
  } catch { return false; }
}

/** tf 是否还在「没余额」的退避期内。缺值/坏值一律当没耗尽（宁可多撞一次 402 也别长期停用）。 */
export function tfCoolingDown(state, now = Date.now()) {
  const at = Number(state && state.tfExhaustedAt);
  return Number.isFinite(at) && at > 0 && now - at < TF_EXHAUST_TTL;
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
  // ❗限流的「强信号」必须先判：很多网关把限流也写成 "quota exceeded"，
  // 若先跑余额正则，一句 "429 rate limit: quota exceeded; retry after 60" 就会把 tf 停用 24 小时。
  // 只有「限流措辞 + 明确余额措辞」同时出现时才继续往下判余额（例如 429 insufficient_quota）。
  const BALANCE = /insufficient[ _-]?(balance|quota|credit|funds)|billing_hard_limit|insufficient_quota|exceeded your current quota|credit balance is too low|no available balance|payment required|(balance|credits?|quota|account|funds?)(\s+(has been|have been|is|are|was|were|been))?\s+(exhausted|depleted|empty|zero|used up)|out of credit|余额为\s*0|余额为\s*零|余额不足|额度不足|余额已用完|余额.{0,4}耗尽/i;
  if (!BALANCE.test(msg) && /rate[ _-]?limit|too many requests|concurrency[ _-]?limit|too many concurrent/i.test(msg)) return 'rate_limited';
  // 余额耗尽单独成一类（2026-11-07）：它和 auth_failed 的处理完全不同 ——
  // 凭据没错，只是这家暂时不能用，应当**立刻**换下一家用，且要把这家停用一段时间；
  // 归进 auth_failed 会让人去查 key，还会每次会审都先撞一次同样的墙。
  if (BALANCE.test(msg)) return 'no_balance';
  if (/401|unauthorized|invalid[^,]*api[ _-]?key|incorrect api key|no api key|authentication/i.test(msg)) return 'auth_failed';
  if (/billing_error/i.test(msg)) return 'auth_failed';
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
  // ❗自带 base_url/env_key，不依赖 ~/.codex/config.toml：
  // 会审要在同一次调用里换 3 家上游，而全局 config 只能有一套 provider 定义；
  // 靠用户手工在各机器上补 [model_providers.x] 也不现实（换台机器就静默走错网关）。
  const providerArgs = profile
    ? [
      '-c', 'model_provider=' + profile.provider,
      ...(profile.baseURL ? ['-c', 'model_providers.' + profile.provider + '.base_url=' + profile.baseURL] : []),
      ...(profile.envKey ? ['-c', 'model_providers.' + profile.provider + '.env_key=' + profile.envKey] : []),
      ...(profile.baseURL ? ['-c', 'model_providers.' + profile.provider + '.wire_api=responses'] : []),
      ...(profile.baseURL ? ['-c', 'model_providers.' + profile.provider + '.name=' + profile.provider] : []),
    ]
    : (config.model ? ['-m', String(config.model)] : []);
  const modelArgs = profile ? [...providerArgs, '-m', profile.model] : providerArgs;
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
// no_balance 要切（换一家就有钱了），但不重试（同一家再问还是没余额）。
const SWITCHABLE = new Set(['empty_response', 'rate_limited', 'unknown', 'model_not_found', 'invalid_answer', 'auth_failed', 'timeout', 'no_balance']);
const FAILOVER_TIMEOUT_CAP = 120000;
// 给「后面还有后端」预留的预算。默认总预算 360s，主端两次各能吃到 180s，正好把预算吃干 ——
// 备用一次都启动不了，于是配了故障切换却永远切不过去；只有快速失败（几秒）时看着像能用。
const FAILOVER_RESERVE = 90000;

/**
 * 决定这次会审依次问哪几家。抽成纯函数是为了能单测「当天第一次」这类规则 ——
 * 否则每条规则都要真起一个 codex 进程才能验，等于没法验。
 *
 * 顺序（用户 2026-11-07 定）：
 *   当天第一次        portdan → tokenfuture → aisz
 *   当天其余          tokenfuture → portdan → aisz
 *   tf 在没余额退避中  跳过 tokenfuture，其余不变
 */
export function planStages(base, { profile = null, failover = null } = {}) {
  if (profile) {
    // 显式指定 provider 默认视为钉死。但参数说明里写着「传 failover:true 可强制打开」，
    // 旧代码却始终只建单后端 —— 说得到做不到。现在按说明真的补上另一条后端。
    const stages = [{ tag: profile.name, profile, maxAttempts: 2, single: true }];
    if (failover === true) {
      const other = profile.name === 'portdan' ? 'aisz' : 'portdan';
      stages.push({ tag: other, profile: CONSULT_PROVIDERS[other], maxAttempts: 1 });
    }
    return stages;
  }
  // failover:false 的语义是「只问这一家」，链不参与。
  if (failover === false) return [{ tag: 'portdan', profile: CONSULT_PROVIDERS.portdan, maxAttempts: 2 }];

  const state = readProviderState(base);
  const cooling = tfCoolingDown(state);
  // ❗认领前必须先看「今天是不是已经用过 portdan」。
  // 只用锁判断是不够的：portdan 第一次真跑过（已写 lastPortdanDay），若同一次调用里
  // 还试了第二次并因预算不足被截停，释放逻辑把锁还回去，下一次 planStages 又会首选 portdan
  // —— 当天就变成「每天两次首选」。锁只负责并发互斥，日期事实以 lastPortdanDay 为准。
  // ❗认领的日期在这里就定下来，后面释放/标记全用这一个 day。
  // 每次重新 localDay() 会让跨午夜的调用去删「明天」那份文件（会审 a4 的跨日反例）。
  const day = localDay();
  const usedToday = state.lastPortdanDay === day || portdanDayUsed(base, day);
  const claimed = usedToday ? false : claimPortdanDay(base, day);
  const stages = [];
  if (claimed) {
    stages.push({ tag: 'portdan', profile: CONSULT_PROVIDERS.portdan, maxAttempts: 2, dailyPick: true, day });
  } else {
    if (!cooling) stages.push({ tag: 'tokenfuture', profile: CONSULT_PROVIDERS.tokenfuture, maxAttempts: 2 });
    stages.push({ tag: 'portdan', profile: CONSULT_PROVIDERS.portdan, maxAttempts: 1 });
  }
  // 当天第一次那条链里，portdan 失败后先去 tf 再回 aisz；tf 冷却时 tf 缺席，直接 aisz。
  if (claimed && !cooling) stages.push({ tag: 'tokenfuture', profile: CONSULT_PROVIDERS.tokenfuture, maxAttempts: 2 });
  stages.push({ tag: 'aisz', profile: CONSULT_PROVIDERS.aisz, maxAttempts: 1 });
  return stages;
}

export async function runConsult({ mode, question, context = '', options = [], timeoutMs = 180000, cwd = '', paths = [], config, provider = '', failover = null, deadlineMs = 0 }) {
  const started = Date.now();
  const base = config.stateDir || config.workRoots[0] || '.';
  const profile = resolveProvider(provider);
  // 总预算：显式给了就用，否则按「两次单次尝试」估，上下夹住。
  const deadline = Math.min(Math.max(Number(deadlineMs) || Number(timeoutMs) * 2 || 360000, 60000), 900000);
  const remaining = () => deadline - (Date.now() - started);

  const stages = planStages(base, { profile, failover });

  const attemptsLog = [];
  // 「今天这次 portdan 真的启动过」，只用于决定要不要归还当天的锁。
  let dailyPickUsed = false;
  let last = null;
  let attempts = 0;
  let failoverFrom = null;
  let stoppedBy = null;

  // 外层按 stages 数组推进，数组长度有界（最多 3），所以「预算跳过」不会形成死循环 ——
  // 每次 break 出去都是真的换了后端或收手，不存在原地打转的分支。
  outer: for (let si = 0; si < stages.length; si++) {
    const stage = stages[si];
    // 还没轮到的后端要留预算：不留就会出现「主端慢失败吃掉全部预算、备用一次没启动」。
    // 按**剩余后端个数**放大，而不是固定一份 —— 三阶段链里只留 90s 的话，
    // 主端吃满 180s 后只剩不到一个备用份，第二个备用等于不存在。
    const reserve = Math.max(0, stages.length - 1 - si) * FAILOVER_RESERVE;
    for (let i = 1; i <= stage.maxAttempts; i++) {
      const left = remaining() - 3000;   // 留出进程清理与写盘的余量
      // 预算不够（含给后续后端留的那份）就别起了，起了也是白烧
      if (left - reserve < 15000) {
        stoppedBy = 'budget';
        // 这里是最容易漏的一处：planStages 为了防并发已经认领了当天的锁，
        // 但预算不够时我们一个进程都没起 —— 资格必须原样还回去，
        // 否则今天剩下的时间里 portdan 只能当兜底（会审 a 指的就是这个）。
        if (stage.dailyPick && !dailyPickUsed) releasePortdanDay(base, stage.day);
        // ❗只跳过这一家，不是结束整条链（continue outer）。
        // 用 break 会掉到循环末尾的「!last || !SWITCHABLE → break outer」，
        // 那一句会把后两家一起掐掉，「主端吃光预算、备用一次没启动」照样发生（会审 d4）。
        continue outer;
      }
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
        // ❗预算截停的那次不能把当天的首选资格用掉。
        // planStages 为了防并发是「先认领锁、再起进程」，认领成功但一次都没启动时，
        // 锁必须放回去，否则今天剩下的时间里 portdan 只能当兜底，永远排不到第一位。
        if (stage.dailyPick && !dailyPickUsed) releasePortdanDay(base, stage.day);
        continue outer;
      }
      // 当天首选那次 portdan 只有真的启动过才算「今天用过了」。上面已排除 notStarted，
      // 所以预算截停不会把当天机会白扔掉。
      if (stage.dailyPick) {
        dailyPickUsed = true;
        markPortdanStarted(base, stage.day);
        writeProviderState(base, { lastPortdanDay: stage.day, lastPortdanAt: Date.now() });
      }
      // tf 明确没余额：记下来，后续 24h 不再拿它打头。只对 tokenfuture 生效 ——
      // 别的后端报余额错误（比如 portdan 欠费）不能写进 tf 的状态，否则会莫名其妙停用 tf。
      if (last.reason === 'no_balance' && stage.tag === 'tokenfuture') {
        writeProviderState(base, {
          tfExhaustedAt: Date.now(),
          tfExhaustedReason: String(last.message || last.error || last.reason || '').slice(0, 200),
        });
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
