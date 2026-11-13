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
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, openSync, closeSync, existsSync, renameSync, unlinkSync, readdirSync, statSync, realpathSync, readSync, fstatSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
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
  portdan: { provider: 'portdan', vendor: 'openai', model: 'gpt-6.1-sol', envKey: 'PORTDAN_API_KEY', baseURL: 'https://portdan.com/v1' },
  tokenfuture: { provider: 'tokenfuture', vendor: 'openai', model: 'gpt-6.1-sol', envKey: 'TOKENFUTURE_API_KEY', baseURL: 'https://tokenfuture.si/v1' },
  aisz: { provider: 'aisz', vendor: 'openai', model: 'gpt-6.1-terra', envKey: 'AISZ_API_KEY', baseURL: 'https://api1.aisz.mom/v1' },
  // qunaapi：Anthropic 系模型的中转站（2026-11-13 接入）。
  // ❗两条共用 baseURL，所以 vendor 都标 anthropic —— 它们**不是**两家厂商，
  // 同时选两个只等于「同一家的两个模型」，不能算跨厂商独立意见（首轮会审指出的误读）。
  // ❗协议实测（codex-cli 0.163）：wire_api=chat 会被直接拒绝（"`wire_api = \"chat\"` is no longer
  // supported"），但这家**真的有** /v1/responses 端点（返回完整 Responses 结构，含 output[] 里的
  // reasoning/message 项），所以照常走 responses 即可，无需适配器。
  // 已知退化：① Codex 不认识这两个模型名，会报 "Model metadata not found, Defaulting to fallback
  // metadata"（只影响它的上下文窗口估算，不影响调用）；② --output-schema 在这家没有原生强制力，
  // 靠 buildPrompt 里显式写出的字段要求生效 —— prompt 不写就会自拟字段并套 markdown 围栏。
  'quna-sonnet': { provider: 'quna', vendor: 'anthropic', model: 'claude-sonnet-5-5', envKey: 'QUNA_API_KEY', baseURL: 'https://qunaapi.com/v1' },
    'quna-gpt': {
    provider: 'quna2', vendor: 'openai', model: 'gpt-6.1-sol',
    envKey: 'QUNA_API_KEY_2', baseURL: 'https://qunaapi.com/v1',
  },
'quna-opus': { provider: 'quna', vendor: 'anthropic', model: 'claude-opus-5-5', envKey: 'QUNA_API_KEY', baseURL: 'https://qunaapi.com/v1' },
};

/**
 * 默认并行会审的组合（2026-11-13 用户选定方案 B：默认双跑）。
 * 一 GPT 系 + 一 Anthropic 系 = 真正跨厂商；同为 quna 的两个模型不算。
 * ❗顺序固定：数组第一项是「主判」，其余是「副判」，汇总时按这个顺序排。
 */
export const DEFAULT_JUDGES = ['portdan', 'quna-sonnet'];

/** 这组 judge 里有几家不同厂商（按 vendor 字段去重）。用来发现「选了同厂两个模型还以为跨了厂商」。 */
export function vendorCount(names) {
  const set = new Set();
  for (const n of names) {
    const p = CONSULT_PROVIDERS[n];
    if (p && p.vendor) set.add(p.vendor);
  }
  return set.size;
}

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
  required: ['conclusion', 'evidence', 'counterexamples', 'verification', 'verdict'],
  properties: {
    // ❗让 judge **自己声明**结论方向，而不是让我们用正则去猜它写的中文。
    // 2026-11-13 第 4 轮会审两家一起指出：拿正则读自由文本做凭证闸门，措辞空间是无穷的，
    // 30 条自选用例覆盖不了（它们陆续给出「不可用」「不通过」「目前不行，修完后可以直接用」
    // 「I disapprove」等一串当场可复现的绕过）。让模型在结构化字段里说清楚，
    // 正则退化为**兜底**（老模型不填、或填了不认识的值时才用）。
    // 不设进 required：真没填时宁愿退回正则，也不要因为缺一个字段就把整份意见判成无效
    // —— 那会让跨厂商双审动不动只剩一家（比误判方向更常见）。
    //
    // ❗2026-11-13 上午实测推翻了上面这句：portdan 的上游会做 **OpenAI 严格 schema 校验**，
    // properties 里多一个键而 required 里没有它，请求当场被拒 ——
    // 原文 `Invalid schema for response_format 'codex_output_schema': In context=(),
    // 'required' is required to be supplied and to be an array including every key in properties.
    // Missing 'verdict'.` 那一路整个 turn.failed（reason=unknown，10.5 秒就挂）。
    // 所以 verdict **必须**进 required。原来担心的「缺字段导致整份作废」不会发生：
    // 严格上游会保证这个键一定在，非严格上游不填时本地 validAnswer 也只查那四段。
    verdict: {
      type: 'string',
      enum: ['pass', 'fail', 'unclear'],
      description: '你对「能不能直接用 / 这个方案能不能采纳」的方向判断：pass=可以，fail=不可以（含「必须改了才能用」），unclear=读不出或材料不足',
    },
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

/**
 * 材料注入：把指定文件的**真实内容**贴进 prompt（2026-11-13 加）。
 *
 * 为什么需要：2026-10-17/10-18 两次事故的根因都不是「会审的人不够强」，而是
 * **审的时候手上没有真实源码**，只能靠调用方复述的片段去猜。实测三家用同一份材料，
 * 有半数的猜测都落空在「它没见过那段代码」上。token 涨到 2 万也只多几分钱。
 *
 * ❗安全边界（这是第一版就必须有的，不能等到出事再补）：
 *  - 只允许**白名单根目录**内的真实路径（默认就是会审的 cwd / workRoots）；
 *  - 挡掉符号链接逃逸（realpath 之后再比对根目录，不是比对传入的字面路径）；
 *  - 挡掉凭据类文件名（.env / .credentials.yaml / *.pem / *.key / id_rsa …），
 *    即使它们在白名单目录里也不读 —— 内容会被发给第三方中转站；
 *  - 单个文件 60KB、总量 200KB 封顶，超了截断并**明确标注被截断**（不静默丢）。
 */
export const MATERIAL_LIMITS = { perFile: 60 * 1024, total: 200 * 1024, maxFiles: 40 };

// ❗这份黑名单是**最后一道**，不是第一道 —— 白名单根已经收窄到 workRoots，
// 但它仍然要尽量全：材料内容会被发给第三方中转站，看错一个文件就是一次泄露。
// 2026-11-13 三路会审逐条点了缺口（.npmrc / .netrc / .envrc / credentials / auth.json /
// kubeconfig / *.tfstate / *.jks …），这里一次补齐；同时覆盖 Windows 的两种变形：
// 结尾带点（`key.pem.`，Win32 会忽略尾点照样打开）与 8.3 短名（`CREDEN~1.YAM`）。
const DENY_BASENAME = new RegExp('^(?:'
  + '\\.env(?:\\.|$).*'                            // .env / .env.local / .env.production
  + '|.*\\.env'                                    // prod.env / staging.env（第 5 轮会审指出：原来只锚串首）
  + '|\\.envrc'
  + '|\\.credentials(?:\\.(?:yaml|yml|json|txt|toml))?'
  + '|credentials(?:\\.(?:yaml|yml|json|txt|toml))?'
  + '|credentials\\.toml|application_default_credentials\\.json'
  + '|\\.?(?:npmrc|netrc|pypirc|pgpass|htpasswd|dockercfg|git-credentials)'
  + '|\\.git-credentials|\\.vault-token|hosts\\.yml'
  + '|auth\\.json|config\\.toml'
  + '|id_(?:rsa|dsa|ecdsa|ed25519)(?:\\.pub)?'
  + '|.*\\.(?:pem|key|pfx|p12|p8|ppk|jks|keystore|tfstate|tfvars|kubeconfig|ovpn)(?:\\..*)?'
  + '|kubeconfig|service-account[^/]*\\.json|secrets?\\.(?:json|ya?ml|txt|env)'
  + '|accesstokens?\\.json|access_tokens?\\.json'
  // ❗Azure CLI / gcloud 的令牌库（第 16 轮会审 portdan 指出）：它们是 SQLite 文件，
  // 扩展名 .db，前面的规则一条都不命中，`~/.azure/msal_token_cache.bin` 同理。
  + '|credentials\\.db|access_tokens?\\.db|accesstokens?\\.db|msal_token_cache\\.bin'
  + '|tandem\\.json|provider-state\\.json|provider-state\\.json\\.tmp'
  + ')$', 'i');

/** Windows 特有的三种「看起来不像、实际是同一个文件」的写法，逐条挡。 */
function looksLikeSecretPath(real) {
  const b = basename(real);
  // ① 结尾带点或空格：Win32 打开时会自动剥掉，`key.pem.` 等价于 `key.pem`
  if (/[. ]$/.test(b) && DENY_BASENAME.test(b.replace(/[. ]+$/, ''))) return true;
  // ② 8.3 短名（CREDEN~1.YAM）：JS 版 realpathSync 不展开短名，只能按形态挡。
  // ❗前缀表要含 ENV / CONFIG：`.env` 的短名是 `ENV~1`（前导点被去掉，DENY_BASENAME 的
  // `^\.env` 匹配不到），`.docker/config.json` 的短名是 `CONFIG~1.JSO`（第 5 轮会审 sonnet 指出）。
  if (/~\d/.test(b) || /^[A-Z0-9_~]{1,8}(\.[A-Z0-9_~]{0,3})?$/i.test(b)) {
    const upper = b.toUpperCase();
    if (/^(CREDEN|AUTH|TOKEN|SECRET|ENV|CONFIG|ID_RSA|ID_ED|ID_DSA|ID_ECD|NPMRC|NETRC|KUBECO|HOSTS|VAULT)/.test(upper)) return true;
  }
  // ③ NTFS 备用数据流。冒号在 Windows 文件名里只有一个合法来历（ADS），
  // 所以只要 basename 里有冒号就拒 —— 不只认 `$DATA`：`notes.txt:secret` 同样是 ADS
  //（第 5 轮会审两家都指出：原来只判 `:$DATA` 与 `::$`，任意命名流都过得去）。
  // ❗先放过 Windows 的下载标记流：`README.md:Zone.Identifier` 是浏览器/资源管理器
  // 给「从网络下载来的文件」自动加的元数据流，不是凭据。把它挡掉会误杀正常材料
  //（会审 opus 指出：smoke-secret.mjs 只测了凭据文件，没测这种普通文件）。
  if (/:Zone\.Identifier$/i.test(b)) {
    // ❗但只放行「流名干净」的那种：`prod.env:Zone.Identifier` 的冒号前仍是凭据文件名，
    // 原来这里直接 return false，等于给所有凭据名开了一条 ADS 后门
    //（第 6 轮会审 portdan 给的反例）。剥掉流名后按同一套凭据名规则再判一次。
    const base = b.replace(/:Zone\.Identifier$/i, '');
    return DENY_BASENAME.test(base) || /(^|[._-])env([._-]|$)/i.test(base);
  }
  if (b.includes(':')) return true;
  return false;
}

/**
 * 禁止读取的目录段（含 8.3 短名与结尾点写法）。
 *
 * ❗按「段」判而不是按整串正则：realpathSync 不展开 8.3 短名，`GIT~1\config` 与 `.git\config`
 * 是同一个目录，而一条字面正则只能挡住后者；结尾点（`.ssh.`）同理 —— Win32 打开时会剥掉尾点
 *（第 5 轮会审 sonnet 指出，这两种形态下 `.kube/config`、`.ssh\known_hosts` 都会被读进来）。
 */
const DENY_DIRS = new Set([
  '.git', 'node_modules', '.ssh', '.aws', '.docker', '.kube', '.gnupg',
  // ❗云厂商与容器/基础设施凭据目录（第 14 轮会审 portdan 指出）：`.azure/accessTokens.json`
  // 是 Azure CLI 的登录令牌，`.config/gcloud` 里有 application_default_credentials.json，
  // `.terraform` 里有 state（含明文敏感值）。它们都不在上述名单里，会被当成普通材料外送。
  '.azure', '.gcloud', '.terraform', '.vault',
  // ❗gcloud 不带点的那种：`~/.config/gcloud/` 里就是它（第 16 轮会审 portdan 指出，
  // 上一条只挡了 `.gcloud` 而真实路径是 `config/gcloud`）。
  'gcloud',
  'git~1', 'ssh~1', 'aws~1', 'docker~1', 'kube~1', 'gnupg~1', 'node_m~1',
  'azure~1', 'gcloud~1', 'terraf~1', 'vault~1',
]);

function inDenySegment(real) {
  const segs = String(real).split(/[\\/]+/);
  for (const s of segs) {
    const k = s.replace(/[. ]+$/, '').toLowerCase();
    if (DENY_DIRS.has(k)) return true;
    // 短名形态兜底：`KUBE~1`、`GNUPG~1` 之类不一定在表里，按「~数字 + 已禁目录前 4 字」判
    if (/~[0-9]/.test(k) && [...DENY_DIRS].some(d => !d.includes('~') && k.startsWith(d.replace(/^\./, '').slice(0, 4)))) return true;
  }
  return false;
}

/** 真实路径是否在任一白名单根之内。必须先 realpath，否则 symlink 一指就逃出去了。 */
function insideRoots(realTarget, roots) {
  const norm = p => p.replace(/[\\/]+$/, '').toLowerCase();
  const t = norm(realTarget);
  return roots.some(r => {
    const n = norm(r);
    return t === n || t.startsWith(n + '\\') || t.startsWith(n + '/');
  });
}

/**
 * 判断一段材料看起来是不是 unified diff。
 * 用来决定「要不要拿工作区核对它」——diff 覆盖是本插件唯一的「不读全文也能算覆盖」的口子，
 * 也正因为如此它最容易被伪造：随手写一行 `+++ b/src/critical.js` 加一个 `@@`，
 * 就能让凭证替那个文件作证，而 judge 根本没看过它。
 */
function looksLikeDiff(text) {
  return /^diff --git /m.test(text) || /^--- \S+/m.test(text) && /^\+\+\+ \S+/m.test(text);
}

/**
 * 用 git 核对「这份 diff 与工作区当前状态是否一致」。
 *
 * ❗为什么要这一步（第 16 轮会审 portdan 指出）：`diffTargets` 只认 diff 头与 hunk，
 * 却从不验证 diff 的内容是否真的对应那个文件的当前内容。于是旧 diff、或者自己编的 diff，
 * 都能让凭证覆盖一份 judge 从没见过的文件。
 * 判据用 `git apply --check --reverse`：diff 若真的是「相对当前工作区的改动」，反向应用必然能干净通过；
 * 编的或过期的 diff 会失败。这不是万能的（比如改动已提交时反应用也不成立），
 * 所以三种结果分开记：'ok' / 'mismatch' / 'unavailable'，只有 'ok' 才算覆盖。
 */
let verifySeq = 0;

function verifyDiffInTree(diffFile) {
  const dir = dirname(diffFile);
  let probe = diffFile;
  let tmp = '';
  try {
    // ❗先规范化成 LF 再交给 git：Windows 上 `Out-File` / `Set-Content` 写出来的是 CRLF，
    // 而 git apply 对 CRLF 的补丁几乎一律判「patch does not apply」——
    // 那会把「格式被 Windows 改坏了」误报成「diff 是伪造的」。
    const raw = readFileSync(diffFile, 'utf8');
    if (raw.includes('\r\n')) {
      // ❗文件名必须唯一到「不会撞」：只用 pid + 毫秒时间戳，同一进程里两次会审
      // 落在同一毫秒就会用同一个临时文件，后一次把前一次覆盖掉 —— 于是 `git apply`
      // 校验的是别人的补丁，而判定结果却被前一次拿去用了（第 17 轮会审 sonnet 指出，
      // 可能性低但后果正是「凭证替伪造 diff 作证」）。加一个进程内自增序号兜住。
      tmp = join(dir, '.verify-' + process.pid + '-' + Date.now() + '-' + (++verifySeq) + '.diff');
      writeFileSync(tmp, raw.replace(/\r\n/g, '\n'));
      probe = tmp;
    }
    const r = spawnSync('git', ['apply', '--check', '--reverse', '--whitespace=nowarn', probe],
      { cwd: dir, encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (r.error) return 'unavailable';
    return r.status === 0 ? 'ok' : 'mismatch';
  } catch { return 'unavailable'; } finally {
    if (tmp) { try { unlinkSync(tmp); } catch { /* 清理失败不影响判定 */ } }
  }
}

/**
 * 读取待注入的材料，返回 [{ path, text, truncated, bytes }] 与被拒绝的清单。
 * 拒绝的每一条都带原因 —— 静默跳过会让人以为「审过了写得全的版本」。
 */
export function collectMaterials(paths, { roots = [], base = process.cwd(), denyRoots = [] } = {}) {
  const out = [];
  const rejected = [];
  let budget = MATERIAL_LIMITS.total;
  let oversize = 0;
  // ❗roots 为空时**一个都不许读**（第 18 轮会审 sonnet 指出：原来回落成 `[base]`，
  // 而 base 默认是 `process.cwd()` —— 于是「没配白名单」等于「整个工作目录都可外送」，
  // 正好和我 index.js 里那句注释相反。这里 fail-closed，理由说出来：
  const allow = roots.map(r => resolve(String(r)));
  if (!allow.length) {
    for (const raw of Array.isArray(paths) ? paths : []) {
      const given = String(raw || '').trim();
      if (given) rejected.push({ path: given, reason: '未配置允许根（workRoots 为空），材料一律不外送' });
    }
    return { items: [], rejected, bytes: 0, truncated: false };
  }
  for (const raw of Array.isArray(paths) ? paths : []) {
    const given = String(raw || '').trim();
    if (!given) continue;
    const abs = resolve(base, given);
    let real = '';
    try { real = realpathSync(abs); } catch { rejected.push({ path: given, reason: '不存在' }); continue; }
    if (!insideRoots(real, allow)) { rejected.push({ path: given, reason: '不在允许的目录内（越界）' }); continue; }
    // ❗stateDir 单独按「拒绝根」处理，而不是把包住它的 workRoot 整个剔掉（第 15 轮会审
    // quna-sonnet 指出）：workRoots=['D:/projects'] + stateDir='D:/projects/.state' 时，
    // 原来会把整个 D:/projects 剔除，matRoots 变空，所有材料都判「越界」——这是误杀。
    if (denyRoots.length && insideRoots(real, denyRoots.map(d => resolve(String(d))))) {
      rejected.push({ path: given, reason: '命中禁止的目录（stateDir 里有历史会审记录，可能含别的项目的材料）' });
      continue;
    }
    if (inDenySegment(real)) { rejected.push({ path: given, reason: '命中禁止的目录（.git / node_modules / .ssh / .aws / .docker / .kube / .gnupg）' }); continue; }
    if (DENY_BASENAME.test(basename(real)) || looksLikeSecretPath(real)) { rejected.push({ path: given, reason: '疑似凭据文件，拒绝发送给第三方' }); continue; }
    let st;
    try { st = statSync(real); } catch { rejected.push({ path: given, reason: '无法读取' }); continue; }
    if (!st.isFile()) { rejected.push({ path: given, reason: '不是普通文件（目录请逐个列出文件）' }); continue; }
    // ❗硬链接：`docs/notes.txt` 若是指向 `.env` 的硬链接，basename 与 realpath 都是 notes.txt，
    // 前面所有检查都过得去，内容却是凭据（第 5 轮会审 sonnet 指出，我此前没考虑）。
    // 材料只需要「一份正常的项目文件」，多链接的普通文件要么是构建产物、要么就是这个把戏 ——
    // 直接拒，代价极小（谁会把要送去第三方审的源码做成硬链接）。
    if (st.nlink > 1) {
      rejected.push({ path: given, reason: '文件有 ' + st.nlink + ' 个硬链接（可能是白名单外文件的别名），拒绝发送给第三方' });
      continue;
    }
    if (out.length >= MATERIAL_LIMITS.maxFiles) {
      // ❗封顶之后不再逐个报：opus 那条意见是对的 —— 剩下 20 个文件各来一条同样的
      // 「总量已达上限」，调用方得自己去重才知道到底漏了几个。收成一条带计数的。
      oversize++;
      continue;
    }
    if (budget <= 0) { oversize++; continue; }
    const cap = Math.min(MATERIAL_LIMITS.perFile, budget);
    let text = '';
    let truncated = false;
    let sha = '';
    try {
      const fd = openSync(real, 'r');
      try {
        // ❗复核句柄身份：realpath/stat 与 open 之间路径可能被换掉（TOCTOU），
        // 换成一个符号链接或用别的文件名硬链接到凭据，前面的检查就都白做了。
        // 拿到句柄后用 fstat 比对 dev/ino/size，不一致就拒绝 —— 这不是理论风险，
        // 第 5 轮会审 sonnet 明确点了「没有对打开后的文件句柄复核身份」。
        const fs2 = fstatSync(fd);
        if (fs2.dev !== st.dev || fs2.ino !== st.ino || fs2.size !== st.size) {
          rejected.push({ path: given, reason: '文件在检查与读取之间发生了变化（dev/ino/size 不一致），拒绝发送' });
          continue;
        }
        const buf = Buffer.alloc(Math.min(cap, st.size));
        let n = 0;
        try { n = readSync(fd, buf, 0, buf.length, 0); } catch (e) { rejected.push({ path: given, reason: '读取失败：' + (e && e.message) }); continue; }
        text = buf.subarray(0, n).toString('utf8');
        sha = createHash('sha1').update(buf.subarray(0, n)).digest('hex');
      } finally { closeSync(fd); }
    } catch (e) { rejected.push({ path: given, reason: '读取失败：' + (e && e.message) }); continue; }
    if (st.size > cap) { truncated = true; text += '\n…[已截断，原文件 ' + st.size + ' 字节，此处只含前 ' + cap + ' 字节]'; }
    budget -= Math.min(st.size, cap);
    // 同时记下 realpath：凭证要核对「paths 里的这个文件是不是真的进了 prompt」，
    // 而 given 可能是相对路径、大小写不同、或正反斜杠混写 —— 只能按 realpath 比。
    // sha 是「实际注入的那些字节」的指纹：签发时再读一次文件比对，就能证明
    // 凭证记的版本正是 judge 看过的版本（第 16 轮会审 portdan 指出：只比指纹不够，
    // 指纹是「调用方说读过的那一刻」，与「真的注入了什么字节」之间还隔着一次读取）。
    const diffOk = looksLikeDiff(text) ? verifyDiffInTree(real) : undefined;
    // ❗diff 的**目标路径**也要过一遍白名单/凭据/禁止目录（第 16 轮会审 portdan 指出，
    // 这条成立且很关键）：前面所有检查都只针对「材料文件本身」，而一份 `.env` 的 diff
    // 里，被删掉的那几行带着明文密钥（`-OPENAI_API_KEY=sk-...`）——补丁本身就是凭据。
    // 所以只要目标里有任何一个是禁止外送的文件，整份补丁都不注入。
    if (diffOk !== undefined) {
      // 对不上工作区的 diff 直接拒（第 18 轮会审 portdan 指出）：原来只是「不算覆盖」，
      // 内容仍然被贴进 prompt —— 一份伪造的补丁照样能左右 judge 的判断，
      // 而凭证不会为它作证，等于「没审却让人看了假材料」。
      if (diffOk === 'mismatch') {
        rejected.push({ path: given, reason: 'diff 与工作区对不上（可能是旧 diff 或伪造），整份不注入' });
        continue;
      }
      const targets = diffTargets({ text }, real);
      // ❗目标还必须落在允许根内（第 18 轮会审 portdan 指出）：只查凭据名、禁止目录和
      // stateDir 的话，一份指向 `C:/Windows/...` 或仓库外路径的补丁仍然被外送。
      const bad = targets.find(t =>
        DENY_BASENAME.test(basename(t.path)) || looksLikeSecretPath(t.path) || inDenySegment(t.path)
        || !insideRoots(t.path, allow)
        || (denyRoots.length && insideRoots(t.path, denyRoots.map(d => resolve(String(d))))));
      if (bad) {
        // 报最后两段路径：`config` 这种裸文件名看不出是 `.ssh/config`，而「为什么被拒」
        // 恰恰是这条理由唯一的价值。
        const label = bad.path.split(/[\\/]+/).filter(Boolean).slice(-2).join('/');
        const why = !insideRoots(bad.path, allow) ? '目标不在允许的目录内' : '目标里有禁止外送的文件';
        rejected.push({ path: given, reason: 'diff 的' + why + '（' + label + '），整份补丁不注入' });
        continue;
      }
    }
    out.push({
      path: given, real, text, truncated, bytes: Math.min(st.size, cap), sha,
      ...(diffOk === undefined ? {} : { diffOk }),
    });
  }
  if (oversize) {
    rejected.push({
      path: '（' + oversize + ' 个文件）',
      reason: '因材料总量 ' + MATERIAL_LIMITS.total + ' 字节或文件数 ' + MATERIAL_LIMITS.maxFiles + ' 个封顶，未读取；这些文件没有被发给 judge',
    });
  }
  return { items: out, rejected };
}

/**
 * 核对「paths 里的每个文件是不是真的进了 prompt」。
 *
 * ❗为什么需要它（2026-11-13 三路会审三家一致指出，是本次最要害的一条）：
 * 原来 paths 只用于**记录**覆盖范围，内容进不进 prompt 是另一件事 —— material 可以只给
 * README.md，paths 却写 src/critical.js，judge 从未见过那个文件，凭证照样签发。
 * 于是「凭证比证据强」，正是 10 月两次事故的病根。
 *
 * 比对用 realpath + 小写：调用方可能给相对路径、大小写不同、正反斜杠混写。
 * 目录类型的 path 视为「覆盖整个目录」，只要目录里有文件进了 prompt 就算覆盖
 * （逐个核对目录下的每个文件没有意义：没人会把一个目录的每个文件都塞进 prompt）。
 */
export function checkMaterialCoverage(paths, mats) {
  const covered = normalizePaths(paths);
  if (!covered.length) return { ok: false, missing: [], via: {}, detail: '没有 paths' };
  const key = p => String(p).replace(/[\\/]+$/, '').toLowerCase();
  const seen = (mats && mats.items ? mats.items : []).map(m => {
    let real = m.real || '';
    if (!real) { try { real = realpathSync(resolve(m.path)); } catch { real = resolve(m.path); } }
    return { real, key: key(real), truncated: !!m.truncated, sha: m.sha || '', diffOk: m.diffOk, targets: diffTargets(m, real) };
  });
  const missing = [];
  const via = {};
  for (const p of covered) {
    const k = key(p);
    let isDir = false;
    try { isDir = statSync(p).isDirectory(); } catch { isDir = false; }
    if (isDir) {
      // ❗目录型 paths 一律不算覆盖（第 15 轮会审 quna-sonnet 指出，我上一轮标 'dir'
      // 只是「说出来」，仍然照签）：目录里只要有一个文件进了 prompt，凭证就会声称
      // 「这个目录被审过」，而里面 99% 的文件 judge 从没见过。这种凭证比没有更坏。
      // 要审一个目录，请把要审的文件逐个列进 paths —— 材料本来就有 40 个文件的上限，
      // 本来也塞不下一个目录。
      missing.push(p + '（目录型 paths 不接受，请逐个列出文件）');
      continue;
    }
    // ① 文件本身在材料里
    const direct = seen.find(s => s.key === k);
    if (direct) {
      // ❗被截断的文件只算「看过一部分」，不能当成完整覆盖 ——
      // 否则 83KB 的 consult.js 在 60KB 处被切开，凭证却替整份文件作证。
      if (direct.truncated) missing.push(p);
      else via[p] = 'file';
      continue;
    }
    // ② 一份统一 diff 里含这个文件的改动。
    // ❗为什么认这个：审「一次改动」时交给 judge 的本来就是 diff（改动 + 3 行上下文），
    // 不变的部分不是这次要判断的对象。这不是放宽 —— 凭证会记下覆盖方式是 'diff'，
    // 调用方看得到「它是靠 diff 覆盖的，judge 没见过全文」。
    const byDiff = seen.find(s => s.targets.some(t => t.key === k));
    // ❗被截断的 diff 也不能算覆盖：截断说明这份 diff 的**后半段没了**，
    // 而某个文件的最后一个 hunk 恰好在后半段 —— 那样「覆盖」就是个假象
    //（第 6 轮会审 portdan 指出：direct 会检查 truncated，diff 这条没检查）。
    // ❗另外还要求 diff 与工作区对得上（diffOk==='ok'，见 verifyDiffInTree）：
    // 否则伪造一份只含 `+++ b/x` 和一个 `@@` 的 diff 就能替任何文件作证
    //（第 16 轮会审 portdan 给的反例，成立）。
    if (byDiff && !byDiff.truncated && byDiff.diffOk === 'ok') via[p] = 'diff';
    else if (byDiff && byDiff.diffOk === 'mismatch') missing.push(p + '（diff 与工作区不一致，可能是旧 diff 或伪造）');
    else if (byDiff && byDiff.diffOk === 'unavailable') missing.push(p + '（无法用 git 核对这份 diff，不能据此作证）');
    else missing.push(p);
  }
  const n = Object.keys(via).length;
  return {
    ok: missing.length === 0, missing, via,
    detail: missing.length
      ? '未注入：' + missing.join('、')
      : (n === covered.length ? '全部已注入' + (Object.values(via).includes('diff') ? '（其中 ' + Object.keys(via).filter(k => via[k] === 'diff').length + ' 个是靠 diff 覆盖的）' : '') : ''),
  };
}

/**
 * 核对「材料里注入的字节」与「此刻磁盘上的字节」是否一致。
 *
 * ❗为什么还要这一步（第 16 轮会审 portdan 指出）：`fingerprintPaths` 记的是「调用方声称
 * 读完材料那一刻」的文件指纹，它与「真的注入了什么字节」之间还隔着一次读取；两者都可能与
 * judge 看到的内容错位。sha 是 collectMaterials 读入时对**同一段字节**算的，
 * 签发前再读一次比对，就把「凭证记的版本 = judge 看过的版本」这件事钉死了。
 * diff 覆盖的文件没有 sha（我们没读过它，只读过 diff），跳过 —— 它们由 verifyDiffInTree 保证。
 */
export function checkMaterialFreshness(paths, mats) {
  const covered = normalizePaths(paths);
  if (!covered.length) return { ok: true, changed: [] };
  const key = p => String(p).replace(/[\\/]+$/, '').toLowerCase();
  const items = (mats && mats.items ? mats.items : []);
  const changed = [];
  for (const p of covered) {
    let isDir = false;
    try { isDir = statSync(p).isDirectory(); } catch { isDir = false; }
    if (isDir) continue;
    const m = items.find(it => it.real && key(it.real) === key(p));
    if (!m || !m.sha) continue;
    let buf;
    try { buf = readFileSync(p); } catch { changed.push(p + '（已不可读）'); continue; }
    const now = createHash('sha1').update(buf.subarray(0, m.bytes)).digest('hex');
    // ❗长度也要比（未截断时）：只比前 m.bytes 个字节的话，「在后面追加一段」是察觉不到的
    //（sha 一样、文件已经变了）。截断的材料本来只承诺前 m.bytes 个字节，所以那种情况不比长度。
    if (now !== m.sha || (!m.truncated && buf.length !== m.bytes)) changed.push(p);
  }
  return { ok: changed.length === 0, changed };
}

/**
 * 从一份统一 diff 里取出它 patch 的文件（绝对路径）。
 * 认 `+++ b/xxx` 与 `diff --git a/x b/x` 两种头部；路径相对 diff 文件所在目录解析
 * （本项目的 diff 都是 `git diff` 在仓库根跑的，所以两者一致）。
 */
function diffTargets(m, realPath) {
  const text = String((m && m.text) || '');
  if (!/^(?:diff --git |\+\+\+ |--- )/m.test(text)) return [];
  let dir = '';
  try { dir = dirname(realPath || m.path); } catch { dir = ''; }
  const out = [];
  // ❗必须逐行去 \r：Windows 上用 Out-File / Set-Content 写出来的 diff 是 CRLF，
  // 按 \n 切行后行尾还挂着 \r，解析出的路径会是 `lib/consult.js\r` —— 与真实路径永远不相等。
  // 这个 bug 我在第一版就踩到了（覆盖面一直判 false，看着像禁令太严，其实是我解析错了）。
  //
  // ❗还要求这份 diff 对该文件**真有 hunk**（以 `@@` 开头的行）。
  // 只认 `+++ b/x` / `diff --git a/x b/x` 的话，一段只写着 `+++ b/lib/consult.js` 的
  // 文本材料就能让凭证替整份文件作证 —— 而 judge 一个字符都没看到
  //（第 5 轮会审 sonnet 给出的反例，它是对的）。
  let pending = null;
  const push = (rel) => {
    if (!rel || rel === '/dev/null') return;
    let abs;
    try { abs = resolve(dir, rel); } catch { return; }
    const key = String(abs).replace(/[\\/]+$/, '').toLowerCase();
    if (pending.all.some(x => x.key === key)) return;
    pending.all.push({ path: abs, key });
  };
  const flush = () => { if (pending && pending.hunks > 0) for (const t of pending.all) out.push(t); pending = null; };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r+$/, '');
    // ❗`--- a/x` 这一半也必须解析（第 17 轮会审 portdan 指出，成立且是真正的泄漏口）：
    // 删除一个 `.env` 的补丁，新路径是 `/dev/null`，旧路径才是那个凭据文件；
    // 只认 `+++` 的话这份补丁的目标集是空的，于是「含明文密钥的删除行」照样被贴进 prompt。
    // 改名同理（`.env` → `notes.txt`：新名无害，旧名是凭据）。
    //
    // 只在 `hunks === 0` 时认头部：hunk 里被删掉的行若内容以 `-- ` 开头，
    // 加上 diff 自己的 `-` 前缀就长得跟 `--- foo` 一模一样 —— 那种行不该被当成路径。
    if (!pending || pending.hunks === 0) {
      // 普通 unified diff 可能直接从 `--- a/x` 开始、没有 `diff --git` 那一行，
      // 所以这里 pending 为空时要先建一个，否则删掉 `.env` 的那种补丁会丢掉旧路径。
      let mm = /^--- (?:a\/)?(.+?)(?:\t.*)?$/.exec(line);
      if (mm) {
        if (!pending) pending = { all: [], hunks: 0 };
        push(mm[1].trim());
        continue;
      }
      mm = /^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/.exec(line);
      if (mm) {
        if (!pending) pending = { all: [], hunks: 0 };
        push(mm[1].trim());
        continue;
      }
      mm = /^rename from (.+)$/.exec(line);
      if (mm) { if (!pending) pending = { all: [], hunks: 0 }; push(mm[1].trim()); continue; }
      mm = /^rename to (.+)$/.exec(line);
      if (mm) { if (!pending) pending = { all: [], hunks: 0 }; push(mm[1].trim()); continue; }
    }
    // 这里只认 `diff --git` 作为「下一份文件」的分界。`+++` 不在这里处理：
    // hunk 里被**新增**的行若内容以 `++ ` 开头，加上前缀也长成 `+++ foo` ——
    // 在这一分支里把它当文件头会丢掉当前文件已经收集到的目标路径。
    let mm = /^diff --git a\/.+? b\/(.+)$/.exec(line);
    if (mm) {
      flush();
      const rel = mm[1].trim();
      pending = { all: [], hunks: 0 };
      push(rel);
      continue;
    }
    if (pending && /^@@ /.test(line)) pending.hunks++;
  }
  flush();
  return out;
}

/** 把材料渲染成 prompt 里的一段。没有材料时返回空串。 */
export function renderMaterials(mats) {
  if (!mats || !mats.items || !mats.items.length) return '';
  const parts = ['', '以下是这次会审可以依据的**真实文件内容**（不是复述，请据此判断，不要自行猜测未给出的代码）：'];
  for (const m of mats.items) {
    // ❗围栏长度必须比文件里最长的一串反引号还长，否则文件内容可以「提前闭合围栏」，
    // 把自己后半段伪装成 prompt 指令去左右 judge 的结论（三路会审都点了这条，
    // 而本次被审的 diff 里恰好就含 ```json 字样 —— 这不是理论风险）。
    const longest = (String(m.text).match(/`{3,}/g) || []).reduce((mx, s) => Math.max(mx, s.length), 0);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    parts.push('', '=== ' + m.path + ' ===', fence, m.text, fence);
  }
  if (mats.rejected && mats.rejected.length) {
    parts.push('', '（以下材料未能附上，判断时请把这一缺口计入：' + mats.rejected.map(r => r.path + ' — ' + r.reason).join('；') + '）');
  }
  return parts.join('\n');
}

function buildPrompt({ mode, question, context, options, materials = '' }) {
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
  if (materials) parts.push(materials);
  parts.push(
    '',
    '输出必须是单一 JSON 对象，符合给定 schema，不要包 markdown 代码块：',
    '{"verdict": "pass" | "fail" | "unclear", "conclusion": string, "evidence": string[], "counterexamples": string[], "verification": string}',
    'verdict 必须填，且要和 conclusion 的意思一致：能不能直接用 / 这个方案能不能采纳。',
    '「必须改了才能用」算 fail（现在还不能用），不要因为「改完就能用」就填 pass。',
    'counterexamples 至少 1 条；确实没想到就写「未发现，但这不代表不存在」。',
  );
  return parts.join('\n');
}

/**
 * 去掉模型套在回答外面的 markdown 代码围栏。
 *
 * ❗为什么需要（2026-11-13 实测）：prompt 里明确写了「不要包 markdown 代码块」，
 * GPT 系（portdan）稳定遵守，但 **claude 系（quna-sonnet / quna-opus）经常照样套 ```json**。
 * 内容其实四段齐全、完全合规，只因为多了两行围栏就被判 invalid_answer ——
 * 首位跨厂商 judge 直接归零，跨厂商双审就成了单审。这不是模型答错，是我们自己判错。
 * 只剥「整段被单一围栏包住」这一种形态，不对中间内容做任何猜测。
 */
export function stripCodeFence(text) {
  const s = String(text == null ? '' : text).trim();
  const m = s.match(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/);
  return m ? m[1].trim() : s;
}

/** 从 --json 事件流里取最后一条 agent_message 文本。 */
export function extractAnswer(logText) {  const lines = String(logText || '').split(/\r?\n/);
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
async function attemptOnce({ mode, question, context, options, timeoutMs, cwd, config, base, attempt, profile, deadlineAt = 0, materials = '' }) {
  const started = Date.now();
  // ❗后缀必须唯一：dual 会并行起两个进程，Date.now() 同毫秒命中时
  // 两条会用同一个目录，prompt.txt 与 consult.log 互相覆盖，日志里读到的可能是另一条的回答。
  const dir = join(base, '_tandem', 'consult-' + started + '-' + attempt + '-' + Math.random().toString(36).slice(2, 6));
  mkdirSync(dir, { recursive: true });
  const schemaPath = join(dir, 'schema.json');
  writeFileSync(schemaPath, JSON.stringify(SCHEMA, null, 2), 'utf8');
  const promptPath = join(dir, 'prompt.txt');
  const prompt = buildPrompt({ mode, question, context, options, materials });
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
          // 两级容错，每级都只在解析失败时才试：
          // ①剥围栏 —— claude 系习惯套 ```json，内容合法、只是多了两行；
          // ②修非法转义 —— 模型在 JSON 里照抄正则写法（\.git）会写出非法转义，
          //   内容对但解析不了，不修就等于白问一家。
          // 两级都失败才判 invalid_answer，并把原文留下来供人工看。
          const cleaned = stripCodeFence(raw);
          let answer = null;
          try { answer = JSON.parse(cleaned); } catch { answer = null; }
          let repaired = null;
          if (answer === null) {
            repaired = repairJsonEscapes(cleaned);
            try { answer = JSON.parse(repaired); } catch { answer = null; }
          }
          if (answer === null) {
            out.ok = false;
            out.reason = 'invalid_answer';
            out.note = '模型输出不是合法 JSON（已尝试剥围栏与修非法转义），已保留原文';
            out.raw = raw;
          } else if (!validAnswer(answer)) {
            out.ok = false;
            out.reason = 'invalid_answer';
            out.note = '回答缺四段之一或某段为空（结论/证据/反例/验证方式）';
            out.answer = answer;
          } else {
            out.answer = answer;
            // 记下「是靠修复才解析成功的」：这类回答的真实格式质量低于表面看起来的。
            if (repaired !== null) out.repaired = ['escapes'];
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

export async function runConsult({ mode, question, context = '', options = [], timeoutMs = 180000, cwd = '', paths = [], config, provider = '', failover = null, deadlineMs = 0, materials = '', materialCoverage = null, preFingerprint = null, materialItems = null }) {
  const started = Date.now();
  const base = config.stateDir || config.workRoots[0] || '.';
  // ❗单路也要取会审前的指纹（第 5 轮会审 sonnet 指出：单路完全没查「会审期间文件变了」）。
  // 取不到就记成 unknown，由 decideReview 的 fail-closed 规则拒绝签发，不吞成 null。
  // ❗但「会审前」应以**读材料那一刻**为准，不是进到这里才取（第 14 轮会审 portdan 指出）：
  // 调用方先 collectMaterials 读文件、再调本函数，两步之间有人改了文件，就会用改后的
  // 指纹替改前的内容作证 —— 凭证与证据错位。所以允许调用方传入 preFingerprint。
  const coveredPre = normalizePaths(paths);
  let singleFingerprintBefore = null;
  let singleFingerprintUnknown = false;
  if (coveredPre.length) {
    if (preFingerprint) singleFingerprintBefore = preFingerprint;
    else {
      try { singleFingerprintBefore = fingerprintPaths(coveredPre); } catch { singleFingerprintUnknown = true; }
    }
  }
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
      last = await attemptOnce({ mode, question, context, options, timeoutMs: useTimeout, cwd, config, base, attempt: attempts, profile: stage.profile, deadlineAt: started + deadline, materials });
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

  // 只有真拿到有效四段答案、**且这份答案读得出「通过」**才签发 reviewId。
  // ❗这一条是 2026-11-13 三路会审后补的：原来只看 ok（=拿到合规答案），
  // 于是「这处有严重缺陷，必须修改」这种回答也照样发凭证 —— 而凭证的语义明确是
  // 「这块内容被独立复核过」，它同时被 tandem_delegate 显示成「这部分审过」。
  // 拿到一个否决结论却发通过凭证，是这套机制里最坏的一种错。
  let review = null;
  let reviewWriteError = null;
  const coveredPaths = normalizePaths(paths);
  const singleVerdict = last && last.ok && last.answer
    // ❗必须把**声明的 verdict** 也传进去（第 5 轮会审两家一起指出）：
    // 只传 conclusion 的话单路永远走正则，声明了 fail 但正文读成 pass 时照样签发，
    // 与并行分支语义不一致 —— 而单路恰恰是旧调用最常用的那条路。
    ? verdictOf(last.answer.conclusion, last.answer.verdict)
    : 'unclear';
  // 单路也走同一个判据：两套判断各自演化，迟早会漂成两种语义
  // （并行说"否决不发"、单路说"拿到答案就发"，同一件事两个答案）。
  // ❗指纹只取一次，且记账记的是**会审开始时**那一次（与并行分支一致）。
  // 第 13 轮 quna-opus 指出：原来「比较时取一次、落票据时又取一次」，外部进程正好在两次之间
  // 写了受审文件，票据就会记下 judge 根本没看过的新版本指纹 —— 那等于给没审过的内容盖章。
  // 并行分支记的本来就是 fingerprintBefore（judge 看到的那一版），这里跟着它对齐，
  // 免得同一个字段在两条路上表示两个时刻。
  const singleFingerprintAfter = singleFingerprintBefore && coveredPaths.length
    ? fingerprintPaths(coveredPaths)
    : null;
  const singleFresh = materialItems ? checkMaterialFreshness(coveredPaths, materialItems) : { ok: true, changed: [] };
  const singleChangedDuring = !!(singleFingerprintBefore && singleFingerprintAfter
    && JSON.stringify(singleFingerprintAfter) !== JSON.stringify(singleFingerprintBefore)) || !singleFresh.ok;
  const singleDecision = decideReview({
    // ❗declaredRaw 也要带：单路的 verdict 同样可能不是字符串（数组/对象/数字/null），
    // 不带的话 bogus 闸门在单路是死代码，判不出方向的声明会被当成「没声明」放过。
    verdicts: last && last.ok
      ? [{
        judge: 'single',
        verdict: singleVerdict,
        ...(last.answer && last.answer.verdict === undefined ? {} : { declaredRaw: last.answer && last.answer.verdict }),
      }]
      : [],
    failedCount: last && last.ok ? 0 : 1,
    judgeCount: 1,
    conflicts: [],
    paths: coveredPaths,
    // 第 5 轮会审 sonnet 指出：单路原来这两项都不看，调用方传 failover:false 就能绕开
    // 「材料是否真的进了 prompt」与「会审期间文件是否被改」。单路也该有证据。
    materialCoverage,
    fingerprintUnknown: singleFingerprintUnknown,
    changedDuring: singleChangedDuring,
  });
  // paths 为空不签发：没有覆盖范围，这张标记就对任何任务都成立，等于发了个万能章。
  if (last && last.ok && base && singleDecision.issue) {
    review = {
      reviewId: newReviewId(),
      at: new Date().toISOString(),
      mode,
      questionHead: String(question || '').slice(0, 200),
      paths: coveredPaths,
      // 记 judge 看到的那一版（singleFingerprintBefore），不是会审结束后的那一版。
      fingerprint: singleFingerprintBefore || singleFingerprintAfter || fingerprintPaths(coveredPaths),
      ms: Date.now() - started,
      // ❗票据要写清「凭什么签的」（第 18 轮会审 sonnet 指出）：只记 paths/fingerprint 的话，
      // 「一家 pass 一家 unclear」和「两家都 pass」在票据上长得一模一样，事后无法审计。
      verdicts: [{ judge: 'single', verdict: singleVerdict }],
      ...(materialCoverage && materialCoverage.via ? { materialVia: materialCoverage.via } : {}),
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
      : singleDecision.note)
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

/**
 * 修复 JSON 字符串里的非法转义（只修转义，不动别的）。
 *
 * ❗为什么需要（2026-11-13 实测）：quna-opus 按要求给出了完整四段、内容正确，
 * 但它在 evidence 里写正则 `/\.git/` 时直接抄了正则的写法 —— JSON 里 `\.` 是非法转义，
 * 于是整份回答 JSON.parse 失败、被判 invalid_answer。**内容是对的，是我们解析不了**。
 * 与 stripCodeFence 同一类问题：不修这里，跨厂商双审就会因为格式细节而少半条。
 *
 * 只处理「反斜杠 + 非合法转义字符」这一种情况：把那个孤立反斜杠再转义一次（`\.` → `\\.`），
 * 语义等价（原本想表达的就是一个字面反斜杠 + 点）。合法的转义（\" \\ \/ \b \f \n \r \t \uXXXX）
 * 一律原样保留，所以不会把真正的换行、引号改坏。
 */
export function repairJsonEscapes(text) {
  const s = String(text == null ? '' : text);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = s[i + 1];
    if (next === undefined) { out += '\\\\'; continue; }
    if ('"\\/bfnrt'.includes(next)) { out += ch + next; i++; continue; }
    if (next === 'u') {
      // \u 后面必须跟 4 位十六进制，否则也是非法转义（模型偶尔写 \u 当前缀）。
      const hex = s.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += '\\u' + hex; i += 5; continue; }
      out += '\\\\u'; i++; continue; // 只吃掉反斜杠，u 留原位
    }
    // 非法转义：把这个反斜杠本身转义，原字符留在后面。
    out += '\\\\';
  }
  return out;
}

/**
 * 结论方向冲突检测（并行会审用）。
 *
 * 判据故意保守：一家的结论里出现「明确否定」措辞、另一家出现「明确肯定」措辞才算冲突。
 * 宁可漏报也不误报 —— 误报会让调用方对「冲突」这个信号脱敏，之后真的冲突也懒得看了。
 * 所以一段结论里若同时出现正反两面的词（"有问题但可以接受"），两边都不算，直接跳过。
 */
// ❗否决词优先于肯定词。中文里肯定词常常是否定词的**子串**：
//   「不能直接用」含「能用」、「不太正确」含「正确」、「不可以接受」含「可以接受」——
// 先测否定再测肯定，否则「公式不正确」会被归成「说没问题」，整个判定就反了（实测过这一条）。
// 2026-11-13 三路会审一致指出原正则漏掉了最常见的措辞（「能直接用 / 不能直接用 / 不建议上线」），
// 而当时那次会审的判据恰好就是「能不能直接用」—— 漏判等于凭证照发。
// ❗否决词优先于肯定词。中文里肯定词常常是否定词的**子串**：
//   「不能直接用」含「能用」、「不太正确」含「正确」、「不建议上线」含「建议上线」——
// 所以每一条肯定式都要带负向后行断言，且 FAIL 先测、PASS 后测（见 verdictOf）。
// 2026-11-13 三路会审一致指出原正则漏掉了最常见的措辞（「能直接用 / 不能直接用 / 不建议上线」），
// 而当时那次会审的判据恰好就是「能不能直接用」—— 漏判等于凭证照发。
//
// ❗`[^，。；]{0,12}` 这类「中间可以隔几个字」的写法是必需的：
// 「有内存泄漏风险」里「有」和「风险」隔了 5 个字，死板的「有风险」匹配不到。
const VERDICT_FAIL = new RegExp(
  [
    // 中文：否定 + 可用类动词（「不能直接使用」里的「使用」原来漏了）
    // ❗`允许|准|予` 是 2026-11-13 第 8 轮 portdan 的构造（「当前不允许合并」）：
// 原来只列了「不(能|可以|应|该...)」，「不允许」「不准」「不予」全漏，而它的肯定尾巴
// 「合并」又正好是 PASS 的词 —— 一句明确的否决被读成 pass，凭证照样签发。
'不(?:能|可以|应|该|建议|要|得|宜|用|允许|准|予)(?:直接)?(?:用|使用|上|合并|合入|上线|发布|接受|放行)',
    '不(?:能|会)?(?:通过|采纳)|未通过|不通过',
    '(?:不可用|无法使用|不可使用|不能使用|不可采|不适用)',
    '驳回|否决|拒绝(?:合并|采纳|上线|接受)',
    '(?:^|[，。；！？])\\s*否\\s*$',
    '不建议|不(?:太)?(?:正确|对|合适)|不成立|不(?:一定|见得)|没有?必要|暂不|先不|不宜',
    '(?:^|[，。；！？])\\s*(?:不行|不是)',
    '必须(?:修改|修复|改|返工)|需要(?:修改|修复|返工|大改|大修|重做)|建议(?:先)?(?:修改|修复|返工)',
    '证据不足',
    '存在[^，。；]{0,12}(?:问题|缺陷|风险|错误|漏洞)',
    '(?<!没)有[^，。；]{0,12}(?:问题|缺陷|风险|错误|漏洞)',
    '阻塞|blocker',
    // 否定作用域很远的写法：「我不认为……它可以直接用」「说它可以直接用是错误的」
    '不(?:认为|觉得|相信)[^。！？；]{0,40}(?:可以|能)(?:直接)?(?:用|使用|上线|合并)',
    '说[^。！？；]{0,20}(?:可以|能)(?:直接)?(?:用|使用)[^。！？；]{0,10}(?:是)?(?:错误|不对|不成立)',
    '(?:^|[，。；！？])\\s*(?:很难?说|难以|难)',
    // 英文：必须带词边界，否则 approve 会匹配 disapprove、look good 会匹配 doesn't look good
    '\\bdisapprov(?:e|ed|al)\\b',
    '\\breject(?:ed)?\\b',
    '\\bdo(?:es)?\\s+not\\s+(?:use|merge|ship|approve)\\b',
    '\\b(?:doesn\'?t|didn\'?t)\\s+(?:look|seem)\\s+(?:good|fine|right)\\b',
    '\\bmust\\s+(?:fix|change|be\\s+changed)\\b',
    '\\bnot\\s+(?:usable|ready|acceptable)\\b',
    '\\bneeds?\\s+(?:work|fixing|changes)\\b',
    // 第 5 轮会审 sonnet 给的英文反例：否定词在 approve / look good / LGTM **前面**，
    // 而 passIsNegated 只认识中文否定词，所以这些句子当时都判成 pass。
    // 英文的否定作用域按「助动词 + not + 动词」跟在后面，直接在词表里堵。
    '\\b(?:would|do|does|did|can|could|should|will)\\s*(?:n\'?t|not)\\s+(?:approve|accept|merge|ship|use|pass)\\b',
    '\\bnot\\s+(?:approve|approved|accept|acceptable|usable|pass|merge|ship|lgtm)\\b',
    '\\bnot\\s+look\\s+(?:good|fine|right)\\b',
    '\\bno(?:t)?\\s+lgtm\\b',
    '\\bcannot\\s+be\\s+(?:used|merged|shipped|accepted)\\b',
  ].join('|'), 'i');

const VERDICT_PASS = new RegExp(
  [
    '(?<!不)可以(?:直接)?(?:用|使用|上|合并|合入|上线|发布|放行|接受|采纳)',
    '(?<!不)能(?:直接)?(?:用|使用|上|合并|合入|上线)',
    '(?<!不)建议(?:直接)?(?:用|合并|上线|采纳)',
    '(?<!没)没有?(?:发现)?(?:问题|缺陷|错误|风险|漏洞)',
    '无(?:需)?(?:问题|缺陷|风险|错误)',
    '不存在(?:问题|缺陷|风险)',
    '无需修改|不需修改',
    '(?<![不太])正确(?![性])',
    '无误',
    '\\bLGTM\\b',
    '\\blooks?\\s+(?:fine|good)\\b',
    '\\bapprov(?:e|ed)\\b',
  ].join('|'), 'i');

// ❗条件式否决：「必须修复后才能合并」里的「能合并」会被 VERDICT_PASS 读成肯定，
// 但那句话的意思是**现在不能合并**。这类表述必须在看 pass 之前就判死，否则
// 「等修完才行」会被算成「通过」—— 而这恰好是最常见的会审措辞。
// 与之相对，「可以接受，后续必须修」不含「才能」，表示现在可以，不算否决（判 unclear 或 pass）。
const VERDICT_HARD_FAIL = new RegExp(
  '(?:必须|需要|建议先?|应)' + '[^，。；]{0,10}(?:修改|修复|返工|改|调整)' + '[^，。；]{0,10}才能'
  + '|才能(?:合并|合入|上线|发布|放行|接受|用)'
  // 「修完后可以直接用」「修复后可以合并」「修掉竞态之后才可以合并」都要认：
  // 动词清单必须含「修掉 / 改掉 / 解决 / 处理」，连接词必须同时接受「后」和「之后」再接「可以 / 能 / 才」。
  + '|(?:修复|修完|修好|修掉|改完|改好|改掉|解决|处理)(?:完|好|掉)?(?:之)?后[^，。；]{0,8}(?:才|再)?(?:能|可以)'
  + '|(?:修复|修完|修好|修掉|改完|改好|改掉|解决|处理)(?:完|好|掉)?(?:之)?后(?:才|再)',
  'i');

/**
 * 一句话里，肯定短语前面 8 个字内出现否定词 → 这个肯定被否定了。
 *
 * ❗为什么不用正则的负向后行断言：`(?<!不)` 只看**紧邻的一个字**。
 * 「不太可以直接用」「不一定可以接受」「不能说可以直接用」里，否定词和肯定短语
 * 隔了 1 到 3 个字，后行断言全部失效 —— 2026-11-13 三路会审里两家各自给出了
 * 这类反例，实测确实被判成 pass（该签的没签是小事，不该签的签了才是灾难）。
 * 中文否定的作用域是「不/没/未/无 + 副词 + 动词」，所以按窗口判断而不是挨着判断。
 */
const NEG_WORDS = /[不没未无非别否难拒错误]/;
function passIsNegated(s, passIndex) {
  // 回看窗口取 12 个字：中文否定作用域「不/没 + 副词 + 动词」常超过 8 个字
  //（例如「不太可能真的可以直接用」）；12 是保守值，再宽会误伤「没有 X 但有 Y」这类转折句。
  const win = s.slice(Math.max(0, passIndex - 12), passIndex);
  return NEG_WORDS.test(win);
}

/** 把结论切成小句：分句是为了让「前半句否决、后半句说修复后可用」不被算成一句里两边都命中。 */
function clauses(s) {
  return s.split(/[。！？；;\n]|(?<=，)/).map(x => x.trim()).filter(Boolean);
}

/**
 * 判定一段结论是「通过」「否决」还是「说不清」。
 *
 * ❗为什么不做到处都在用的「正/负极性」：极性和「通不通过」不是一回事。
 * 「有严重缺陷，必须修改」是极性为负，但它同样是一个**明确的否决**；
 * 两家都这么写时极性相同、不构成"冲突"，可它绝对不能签发出「这块审过了」的凭证
 * —— 这正是三路会审一致指出的那个洞（reviewId 只看冲突、不看结论内容）。
 *
 * ❗两边都命中就判 unclear，不猜：「有问题但可以接受」既不是通过也不是否决，
 * 硬归成一边会让冲突检测和凭证签发同时出错。宁可说不清。
 */
export function verdictOf(text, declared) {
  // ❗第一位判据是**被审方自己声明的方向**（answer.verdict），正则是兜底。
  // 第 4 轮会审两家一起指出：拿正则读中文自由文本做凭证闸门，措辞空间无穷，
  // 它们当场给出了 8 条可复现的绕过（「不可用」「不通过」「目前不行，修完后可以直接用」
  // 「I disapprove」……）。让模型在结构化字段里把方向说清楚，才算把这件事做对。
  //
  // ❗第 5 轮会审 sonnet 指出了一条更根本的：**正则只能降级，不能放行**。
  // 它给了三条英文反例（「I would not approve this」「This does not look good」「Not LGTM」
  // 都命中 VERDICT_PASS），并指出「声明 pass 但正文写着不能直接用」时我完全不看正文。
  // 于是这里改成单向闸门：
  //   - 声明 fail / unclear → 直接采纳（模型自己说了不行/说不清，不用再猜）；
  //   - 声明 pass → 正则仍可**否决**它（正文里明确写了否决词就不算通过）；
  //   - 没声明 → 正则最多给出 fail，**永远不给 pass**（读不出声明就不能算有人背书）。
  // 代价：老模型若不认这个字段，凭证就签不出来 —— 这是有意的，凭证的语义是「有人明确说可以」。
  const dv = normalizeVerdict(declared);
  const byText = verdictFromText(text);
  if (dv === 'fail') return 'fail';
  if (dv === 'unclear') return 'unclear';
  if (byText === 'fail') return 'fail';
  if (dv === 'pass') return 'pass';
  return 'unclear';
}

/** 只认 pass / fail / unclear 三个值（大小写、空白、中文同义词都归一）。 */
export function normalizeVerdict(v) {
  // ❗只认字符串。第 10 轮 portdan 的构造：verdict 写成 JSON 数组 `["pass"]`，
  // 而 String(['pass']) === 'pass'，于是「格式明显不合 schema 的回答」被当成
  // 明确声明通过，一路通过 bogus 闸门签出凭证。数组/对象/数字都不是声明，
  // 一律返回空串（等于没声明），由调用方按「没声明」处理。
  if (typeof v !== 'string') return '';
  const s = v.trim().toLowerCase();
  if (!s) return '';
  if (s === 'pass' || s === '通过' || s === '可以') return 'pass';
  if (s === 'fail' || s === '不通过' || s === '否决' || s === '不可以') return 'fail';
  if (s === 'unclear' || s === '说不清' || s === '不确定') return 'unclear';
  return '';
}

/**
 * 纯文本判定（正则兜底）。导出来是为了让冒烟脚本能单独测「没有声明 verdict 时」的行为。
 */
export function verdictFromText(text) {
  const s = String(text == null ? '' : text);
  const parts = clauses(s);
  // ❗按小句判，不按整段判：整段判会让「前半句否决、后半句说修复后可用」这种
  // 条件式结论两边都命中，一律变 unclear —— 而 unclear 在旧逻辑里会被另一家的 pass 掩盖。
  let fail = 0, pass = 0, mixed = 0;
  for (const c of parts) {
    // 条件式否决优先：它含肯定词（「才能合并」），但意思是「现在不行」。
    if (VERDICT_HARD_FAIL.test(c)) { fail++; continue; }

    // ❗先算出所有否决短语占据的区间，再判肯定短语。
    // 为什么必须这样（第 5 轮会审之后实测）：英文与中文都把否定词放在**被否定的动词前面**，
    // 于是同一句话里 VERDICT_FAIL 与 VERDICT_PASS 会命中**同一个词** ——
    // 「I would not approve this」「Not LGTM」「说它可以直接用是错误的」，
    // 否决命中「not approve / Not LGTM / 说…是错误的」，肯定又命中「approve / LGTM / 可以直接用」，
    // 旧逻辑把它算成「同一小句里正反并存」→ unclear → 再被另一家的 pass 盖掉。
    // 落在这个否决区间里的肯定短语不是「另一个意见」，它就是被否定的那个词本身，直接忽略。
    const failSpans = [];
    {
      const re = new RegExp(VERDICT_FAIL.source, 'gi');
      let fm;
      while ((fm = re.exec(c))) {
        const len = Math.max(1, fm[0].length);
        failSpans.push([fm.index, fm.index + len]);
        if (fm.index + len >= c.length) break;
        re.lastIndex = fm.index + len;      // 手动推进，防零宽匹配死循环
      }
    }
    const f = failSpans.length > 0;
    // 肯定短语要单独复核否定作用域：「不太可以直接用」里 VERDICT_PASS 能命中
    // 「可以直接用」，但它是被否定的 —— 这是 2026-11-13 两家会审各自给出的反例。
    let passed = 0, negatedPass = 0;
    {
      const re = new RegExp(VERDICT_PASS.source, 'gi');
      let pm;
      while ((pm = re.exec(c))) {
        const at = pm.index;
        const len = Math.max(1, pm[0].length);
        if (failSpans.some(([a, b]) => at >= a && at < b)) { /* 被否决的同一个词 */ }
        else if (passIsNegated(c, at)) negatedPass++;
        else passed++;
        if (at + len >= c.length) break;
        re.lastIndex = at + len;
      }
    }
    // ❗「被否定的肯定」**是一个否决**，不是「什么都测不到」。
    // 否认某件事能够成立，就是这件事不成立；判成 unclear 会让另一个 judge 的 pass 把它盖掉。
    if ((f || negatedPass) && passed) { mixed++; continue; }
    if (f || negatedPass) fail++;
    else if (passed) pass++;
  }
  if (mixed) return 'unclear';
  // ❗跨小句的「否决 + 通过」判 **fail**，不判 unclear（2026-11-13 第 4 轮会审两家各自指出）。
  // 「目前不行，修完后可以直接用」「不能直接用，改掉 X 就可以用了」这种写法，
  // 第二小句的「可以用」讲的是**改完之后**，第一小句才是对现在的判断。
  // 判 unclear 会让另一家的 pass 把它盖掉、凭证照发 —— 而那份意见里明明写着「不行」。
  // 闸门的方向是「宁可少发」：任何小句出现明确否决，整份结论就算否决。
  if (fail) return 'fail';
  if (pass) return 'pass';
  return 'unclear';
}

export function detectConflicts(okList) {
  const list = Array.isArray(okList) ? okList : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let k = i + 1; k < list.length; k++) {
      const a = String(list[i].conclusion || '').trim();
      const b = String(list[k].conclusion || '').trim();
      // ❗只有「结论为空**且**没有声明方向」才跳过。判据改成声明优先后，
      // 一份只有 verdict、没有 conclusion 的回答仍然是有效意见 ——
      // 原来只看 conclusion，这种回答会被当成「没人表态」，两家互相矛盾的声明也就查不出来。
      if (!a && !list[i].verdict) continue;
      if (!b && !list[k].verdict) continue;
      // 优先用各家自己声明的 verdict，缺了才退回正则（见 verdictOf 的说明）
      const da = verdictOf(a, list[i].verdict);
      const db = verdictOf(b, list[k].verdict);
      if ((da === 'pass' && db === 'fail') || (da === 'fail' && db === 'pass')) {
        out.push(list[i].judge + ' 与 ' + list[k].judge + ' 结论方向相反：前者「' + a.slice(0, 120) + '」，后者「' + b.slice(0, 120) + '」');
      }
    }
  }
  return out;
}

/**
 * 并行会审：同一次调用里问多家（2026-11-13 方案 B，用户选定）。
 *
 * ❗为什么不是「等价的 dual」：老的 dual 是「把 provider 表里**全部**跑一遍」，
 * 硬编码、不能挑、且某条失败时整体 ok:false —— 而按单路 80.3% 的成功率，
 * 双跑「至少一家失败」约 35.5%、三路约 48.2%，天天报失败会让调用方麻木。
 * 所以这里的失败语义是：
 *  - 每条 judge **各自** ok/failed，互不拖累；
 *  - 顶层 ok = 「至少一条成功」——有意见就能继续判断；
 *  - 但失败的那条**必须**在 failed[] 里露面，且 note 里写明「不能当成没意见」；
 *  - 结论若互相矛盾，单列 conflicts，并**拒绝**签发 reviewId（冲突不等于通过）。
 *
 * reviewId 只在「全部成功 且 无冲突」时签发 —— 首轮会审指出：
 * 「全成功即签发」挡不住冲突，调用方会把 reviewId 当通过信号读。
 */
/**
 * 凭证签发的**唯一**判据（纯函数，不碰磁盘、不发请求，可离线逐条验证）。
 *
 * 为什么要单独抽出来（2026-11-13 第三轮）：这套判断原来埋在一个 200 行的 async 函数里，
 * 想验证「两家都否决时会不会签发」就得真起三个 codex 进程、花 3 分钟、烧几分钱 ——
 * 于是没人验证，而它恰恰是整件事里最贵的一个错（凭证的语义就是「这块审过了」）。
 *
 * 八条同时成立才签发（每一条都对应一次真实的会审意见，见各条注释）：
 *   ① 指定了 paths（没有覆盖范围 = 万能章）；
 *   ② 每一位 judge 都成功（部分意见不足以声称"这段被复核过"）；
 *   ②b 每家给的 verdict 都是 pass/fail/unclear 之一（读不出方向 ≠ 没意见）；
 *   ③ 无冲突；
 *   ④ 没有任何一家否决；
 *   ⑤ **至少一家**明确判 pass，其余允许是 unclear（2026-11-13 晚，用户拍板改「乙方案」）。
 *      改前是「每一家都必须 pass」，代价是它把「判方向」压在一段自由文本上：第 3/5/6/8/9/10
 *      轮每轮都能找出一句新的中文/英文说法绕过词表（不允许合并、only after CI、数组 verdict…），
 *      补词永远追不上措辞空间 —— 这不是漏词，是用正则判语义这个做法本身不收敛。
 *      改后的凭证语义是「**这段内容被看过了，没有人明确反对**」：
 *      - 已经由 ②/②b/③/④ 保证「每家都成功」「都能读出方向」「无冲突」「无人否决」；
 *      - 剩下的一家说「说不清」不再销毁整张凭证，但也**不算背书**：它的结论原样带回，
 *        note 里点名写明「哪几家没说清」，调用方看得到强弱之分；
 *      - 至少要有一家明确说 pass，否则凭证退化成「大家都没意见但也没人说行」，仍不签。
 *      这条替换掉的旧规则见 git 历史；旧规则的论证（一家 pass 一家 unclear 会让 vendors
 *      虚报跨厂商）仍然有效，所以 note 里必须把那几家点名，不能只报 vendors 数。
 *   ⑥ 至少 2 家厂商都读了 → 单厂商多票不算独立复核（2026-11-13 会审 portdan 指出：
 *      原来没这条，portdan+tokenfuture 同属 openai 系，两家通过也照样签，而凭证的
 *      价值恰恰来自"不同厂商独立看了一遍"）；
 *   ⑦ paths 里的每个文件都真的被当成材料发给了 judge（`materialCoverage`）。
 *      ❗这条是三家一致指出的最要害一条：原来 paths 只用于**记录**，凭证可以覆盖
 *      一份 judge 从未见过的文件 —— 「凭证说覆盖了 config.js，而 judge 只看到调用方复述的片段」。
 *      凭证比证据强，是这套机制里最讽刺的一种失效。
 *   ⑧ 受审文件在会审期间没变、且指纹取得成功（取不到就拒，不 fail-open）。
 */
export function decideReview({
  verdicts = [], failedCount = 0, judgeCount = 0, conflicts = [], paths = [],
  changedDuring = false, vendors = 0, materialCoverage = null, fingerprintUnknown = false,
} = {}) {
  // ❗判不出方向的值不能当成「没意见」：`verdict: 'bogus'` 会同时躲开 vetoes 与 unclear
  // 两个过滤，在旧代码里能一路走到签发（第 5 轮会审 portdan 给出的反例）。
  const VALID = new Set(['pass', 'fail', 'unclear']);
  // ❗「未知判定值」必须看**原始声明**，不能看 `verdictOf` 归一化后的结果。
  // 第 9 轮 portdan 的构造：judge 返回 `verdict:"bogus"` → normalizeVerdict 归成空串 →
  // verdictOf 当成「没声明」→ 退回正则 → 正文写着「可以直接用」就得到 pass →
  // 而这里检查的是归一化后的值（永远是 pass/fail/unclear 之一），bogus 恒为空，闸门形同虚设。
  const bogus = verdicts.filter(v =>
    (v.declaredRaw !== undefined && !normalizeVerdict(v.declaredRaw)) || !VALID.has(v.verdict));
  const vetoes = verdicts.filter(v => v.verdict === 'fail');
  // 乙方案（2026-11-13 用户拍板）：不再要求「每一家都 pass」，改为「至少一家明确 pass」。
  // 理由见函数头 ⑤：用正则判一段自由文本的方向不收敛，补词追不上措辞空间；
  // 而 ②/②b/③/④ 已经把「失败、读不出方向、冲突、明确否决」全挡住了，
  // 剩下的 unclear 只是「没表态」，不该销毁整张凭证 —— 但也不算背书，所以要在 note 里点名。
  const passes = verdicts.filter(v => v.verdict === 'pass');
  const uncles = verdicts.filter(v => v.verdict === 'unclear');
  // ❗「真正给了 pass 的厂商数」与 vendors（成功了几家厂商）不是一回事：
  // 乙方案允许 unclear 凑数，只报 vendors 会让人误以为几家都认可。
  // verdicts 里带 vendor 才数得准；没带（单路/旧调用）时退化成 passes.length。
  const passVendors = passes.some(v => v.vendor)
    ? new Set(passes.map(v => v.vendor)).size
    : passes.length;
  if (!paths.length) {
    return { issue: false, note: '未指定 paths，未签发 reviewId：没有覆盖范围的标记无法证明任何内容是审过的' };
  }
  if (judgeCount === 0 || verdicts.length !== judgeCount || failedCount > 0) {
    return { issue: false, note: '有 ' + (failedCount || (judgeCount - verdicts.length)) + ' 家失败，未签发 reviewId：部分意见不足以声称这段内容被复核过' };
  }
  if (bogus.length) {
    // ❗报**原始声明值**（declaredRaw），不能报归一化后的 verdict：
    // 出问题的正是原始值，报 "unclear" 会让人以为这家只是没表态，看不出它声明了个非法值。
    return { issue: false, note: '有 ' + bogus.length + ' 家的判定值不是 pass/fail/unclear（' + bogus.map(v => v.judge + '=' + JSON.stringify(v.declaredRaw === undefined ? v.verdict : v.declaredRaw)).join('、') + '），未签发 reviewId：读不出方向的意见不能算作通过' };
  }
  if (conflicts.length) {
    return { issue: false, note: 'judge 之间存在冲突，未签发 reviewId：冲突不等于通过，先解决分歧' };
  }
  if (vetoes.length) {
    return { issue: false, note: '有 ' + vetoes.length + ' 家明确否决（' + vetoes.map(v => v.judge).join('、') + '），未签发 reviewId：否决是结论，不是「没意见」' };
  }
  // ❗⑤ 乙方案：至少一家明确 pass。只拦「全都没表态」——那等于谁也没说行，凭证没有内容。
  // 判方向靠声明字段（verdict），正则是只能否决不能放行的兜底，所以这里不再追措辞。
  if (!passes.length) {
    const all = verdicts.map(v => v.judge + '(' + v.verdict + ')').join('、');
    return { issue: false, note: '没有一家明确判「通过」（' + all + '），未签发 reviewId：全都没表态不等于审过' };
  }
  // ⑤ 单厂商多票不算交叉验证。
  // ❗只对**多路**生效：单路会审本来就是「问一家」，调用方知道自己在做什么，
  // 不能因为这条新规则让所有既有单路调用永远签不出凭证（那会让闸门变成死锁）。
  // 它挡的是「两家其实是同一厂商却当作交叉验证」这种假独立。
  if (judgeCount >= 2 && vendors < 2) {
    return { issue: false, note: '成功的 judge 只来自 ' + vendors + ' 家厂商，未签发 reviewId：同一厂商的多个模型共享训练与偏好，不构成独立复核（凭证的价值就在跨厂商）' };
  }
  // ⑥ 受审文件必须真的进了 prompt。仅对多路强制：单路是既有工作方式，paths 一直只做记录，
  // 改成强制会让所有既有调用失效。这里不为单路粉饰 —— 单路的凭证本来就弱一档，
  // 它的价值是「有人看过」，不是「有独立证据」。
  // ⑥ 受审文件必须真的进了 prompt。
  // ❗第 5 轮会审 sonnet 指出：这条原来只对多路强制，于是调用方传 failover:false 走单路
  // 就能绕开（材料只给 README.md、paths 写 src/critical.js，照样签发）。
  // 这条限制的是「证据」，不是「独立厂商数」—— 单路也该有证据，所以不再按 judgeCount 豁免。
  // 单路受影响的唯一情形是「调用方给了 paths 但没给材料」：从 index.js 走会自动把 paths
  // 当材料注入，不会被卡；直接调 runConsult 的脚本要自己传 materialCoverage。
  if (!materialCoverage || !materialCoverage.ok) {
    const why = !materialCoverage
      ? '这次会审没有把 paths 里的文件内容注入 prompt（materialCoverage 缺失），judge 可能只看到调用方复述的片段'
      : '受审文件没有全部进入 judge 的 prompt：' + (materialCoverage.missing || []).join('、');
    return { issue: false, note: why + '，未签发 reviewId：凭证不能为一篇没人看过的文件作证' };
  }
  // ❗取指纹失败要**拒绝**，不能当成「没变化」（fail-closed）。
  // 旧代码 catch 成 null，changedDuring 恒 false —— 会审期间文件被改过、或干脆是被占用
  // 读不到指纹，都显示「未变化」，凭证替一份没人见过的版本作证（第 5 轮两家都点了）。
  if (fingerprintUnknown) {
    return { issue: false, note: '取受审文件的指纹失败（文件被占用或不可读），未签发 reviewId：无法确认 judge 看到的就是当前版本' };
  }
  if (changedDuring) {
    return { issue: false, note: '受审文件在会审期间发生了变化，未签发 reviewId：judge 看到的是旧版本，凭证不能替新内容作证（重新审一次即可）' };
  }
  return {
    issue: true,
    note: '已签发：' + passes.map(v => v.judge + '=pass').join('、')
      + (uncles.length ? '；另有 ' + uncles.length + ' 家没说清（' + uncles.map(v => v.judge).join('、') + '），它们的结论原样带回，不算背书' : '')
      + '，' + vendors + ' 家厂商'
      // ❗把「真正给了 pass 的厂商数」单独报出来：vendors 只数成功了几家厂商，
      // 而乙方案允许 unclear 凑数，两个数字一起看才知道这张凭证到底有几家背书
      // （第 11 轮 sonnet 指出：只报 vendors 会让人误以为跨厂商双审都认可）。
      + (passVendors !== vendors ? '（其中明确判 pass 的 ' + passVendors + ' 家）' : ''),
  };
}

export async function runConsultParallel({ judges, paths = [], config, deadlineMs = 0, materials = '', materialCoverage = null, preFingerprint = null, materialItems = null, ...rest }) {
  const started = Date.now();
  // ❗去重：judges:['portdan','portdan'] 会起两个 codex 进程、烧两份钱、还得同一份意见，
  // 而且「两票」会让人误以为被两方独立确认（会审三家都点了这条）。
  const names = [...new Set((Array.isArray(judges) && judges.length ? judges : DEFAULT_JUDGES)
    .map(n => String(n || '').trim()).filter(Boolean))];
  const unknown = names.filter(n => !CONSULT_PROVIDERS[n]);
  if (unknown.length) {
    return { ok: false, error: 'judges 里有不认识的 provider：' + unknown.join('、') + '；可选 ' + Object.keys(CONSULT_PROVIDERS).join(' / '), judges: names };
  }
  // ❗过滤掉空白项后可能一个都不剩（judges: ['  ']）。这时若不拦，
  // allSettled([]) 会给空数组，perJudge 也是空 —— 下面「全部成功」这条判据
  // （okList.length === perJudge.length，0 === 0）反而成立，于是**零位 judge 也会签发 reviewId**，
  // 而顶层 ok 却是 false。一张没有任何意见背书的凭证比没有凭证更危险（会审 portdan 指出）。
  if (names.length === 0) {
    return { ok: false, judges: [], error: 'judges 过滤掉空白项后为空：至少要给一家，或干脆不传 judges 走默认' };
  }
  // paths 清空：每位 judge 独立回答，无法声称「共同覆盖了某段 diff」。
  // 但若全部成功且无冲突，仍是「这段内容被独立复核过」，所以下面按原 paths 单独签发。
  const covered = normalizePaths(paths);
  // ❗指纹必须在**开跑之前**取：原来是在所有 judge 返回后才算，最坏要等 900 秒，
  // 这期间文件被改过，记下的就是改后的内容 —— 凭证会替一份 judge 从未见过的版本作证
  // （三路会审都点了这条，且它比看起来更容易发生：会审一次要 1 到 3 分钟）。
  let fingerprintBefore = null;
  // ❗取不到指纹不能吞成 null（fail-open）：那样 changedDuring 恒 false，
  // 文件被占用/读不到时凭证照样签发，替一份没确认过的版本作证（第 5 轮两家都点了）。
  let fingerprintUnknown = false;
  if (covered.length) {
    // 调用方若在**读材料那一刻**已经取过指纹，就用它 —— 那才是 judge 真正看到的内容对应的版本
    //（第 14 轮会审 portdan 指出：这里取指纹比起读材料晚一步，中间换版会让凭证与证据错位）。
    if (preFingerprint) fingerprintBefore = preFingerprint;
    else {
      try { fingerprintBefore = fingerprintPaths(covered); } catch { fingerprintBefore = null; fingerprintUnknown = true; }
    }
  } else {
    fingerprintUnknown = true;   // 没 paths 时本来就不签，标出来免得日志里像「取过指纹」
  }
  const results = await Promise.allSettled(names.map(name => runConsult({
    ...rest, config, provider: name, paths: [], materials, deadlineMs,
  })));
  const perJudge = results.map((s, i) => {
    const name = names[i];
    const p = CONSULT_PROVIDERS[name] || {};
    if (s.status === 'rejected') {
      // ❗这里要尽量给出「去哪查」：异常可能发生在真的调用过上游之后（写文件失败等），
      // 那时 prompt/日志已经在盘上了。只回一个 reason='thrown' 会让调用方无从下手
      // （会审 sonnet 指出：runConsult 的 attemptsLog 就是为了这个问题留的）。
      const err = s.reason;
      return {
        judge: name, vendor: p.vendor || '', model: p.model || '', ok: false,
        ms: Date.now() - started, reason: 'thrown',
        hint: '这条抛异常了（可能发生在真的调用过上游之后）。原始错误：' + String((err && err.message) || err).slice(0, 300),
        ...(err && err.stack ? { stack: String(err.stack).slice(0, 1500) } : {}),
      };
    }
    const r = s.value || {};
    const a = r.answer || {};
    return {
      judge: name, vendor: p.vendor || '', model: p.model || '',
      ok: !!r.ok,
      ms: Number(r.ms) || 0,
      // ❗`verdict` 只放字符串（results[].verdict 在 schema 里声明的是 string），
      // 但**原始声明值必须原样带出去**，不管它是什么类型。
      // 上一版这里只写了 `typeof a.verdict === 'string' ? {verdict} : {}`，注释说
      // 「数组/对象留在 declaredRaw 里」，可实际什么都没留 —— 于是 `["pass"]`、`{}`、`123`、`null`
      // 在 perJudge 这步就被丢掉，declaredRaw 拿不到，decideReview 的 bogus 闸门
      // （它靠 declaredRaw 判原始值）对这类值永远不触发，被当成「没声明」→ 正则给 unclear →
      // 乙方案下只要另一家 pass 就签发。这是第 10 轮那条构造（字符串 "bogus"）的变体，
      // 2026-11-13 两家 claude 各自独立复现了完整路径。
      ...(typeof a.verdict === 'string' ? { verdict: a.verdict } : {}),
      ...(a.verdict === undefined ? {} : { declaredRaw: a.verdict }),
      ...(a.conclusion === undefined ? {} : { conclusion: a.conclusion }),
      ...(a.evidence === undefined ? {} : { evidence: a.evidence }),
      ...(a.counterexamples === undefined ? {} : { counterexamples: a.counterexamples }),
      ...(a.verification === undefined ? {} : { verification: a.verification }),
      ...(r.reason === undefined ? {} : { reason: r.reason }),
      ...(r.hint === undefined ? {} : { hint: r.hint }),
      ...(r.failoverFrom ? { failoverFrom: r.failoverFrom } : {}),
      ...(Array.isArray(r.attemptsLog) && r.attemptsLog.length ? { attemptsLog: r.attemptsLog } : {}),
      ...(r.log === undefined ? {} : { log: r.log }),
      ...(Array.isArray(r.repaired) ? { repaired: r.repaired } : {}),
    };
  });
  const okList = perJudge.filter(j => j.ok);
  // ❗failed[] 是给调用方看的**行动清单**：他要据此判断「要不要重试、去哪查」。
  // 所以除了 reason，还要带上 log（日志路径）与 hint —— 只有 reason 的失败项
  // 等于告诉人「出事了」却不告诉人「去哪看」（会审 sonnet 指出）。
  const failed = perJudge.filter(j => !j.ok).map(j => ({
    judge: j.judge,
    reason: j.reason || 'unknown',
    ms: j.ms,
    ...(j.hint ? { hint: j.hint } : {}),
    ...(j.log ? { log: j.log } : {}),
  }));

  // 冲突检测：只在「两家都成功且各自给了 conclusion」时判，且只做**保守**判断 ——
  const conflicts = detectConflicts(okList);
  // 逐家判定「通过 / 否决 / 说不清」。凭证要看它，不能只看有没有冲突。
  const verdicts = okList.map(j => ({
    judge: j.judge,
    // vendor 带进来，decideReview 才能算出「真正给了 pass 的厂商数」，
    // 而不是只数「成功了几家厂商」（乙方案下两者会不同）。
    ...(j.vendor ? { vendor: j.vendor } : {}),
    verdict: verdictOf(j.conclusion, j.verdict),
    // 这条是模型自己声明的还是正则猜的 —— 凭证的可信度不一样，调用方看得到
    source: normalizeVerdict(j.verdict) ? 'declared' : 'regex',
    // ❗原始声明值要一路带到 decideReview：它判「未知值」时必须看原文，
    // 看归一化后的结果等于永远查不出 bogus（第 9 轮 portdan）。
    // ❗优先用 perJudge 带出来的 declaredRaw（那里保留了非字符串形态），
    // 退回到 j.verdict。原来只写 `j.verdict === undefined ? {} : {declaredRaw: j.verdict}`，
    // 非字符串声明在 perJudge 那步已被丢掉，这里就取不到，闸门形同虚设。
    ...(j.declaredRaw === undefined && j.verdict === undefined ? {} : { declaredRaw: j.declaredRaw === undefined ? j.verdict : j.declaredRaw }),
  }));
  const vetoes = verdicts.filter(v => v.verdict === 'fail');

  // ❗vendors 必须按**成功**的 judge 计，不能按请求的算。
  // 原实现按请求算：sonnet 失败只剩 portdan 时仍返回 vendors=2 —— 调用方只要看这一个数字
  // 就会以为「跨厂商双审已通过」，恰恰在这件事上骗人（会审三家一致指出）。
  const vendors = vendorCount(okList.map(j => j.judge));
  const vendorsRequested = vendorCount(names);
  const notes = [];
  if (okList.length === 0) notes.push('全部 judge 都失败了 —— 这不是「没有意见」，而是「未获独立复核」，按规则应停手，不要继续实施改动。');
  if (failed.length && okList.length) notes.push('有 ' + failed.length + ' 家失败（见 failed）：失败的那条不能当成「没意见」，但成功的意见仍然有效，可据此继续判断。');
  if (conflicts.length) notes.push('judge 之间结论冲突（见 conflicts）：这不是「多数通过」，冲突本身就是要停下来看的东西。');
  if (vetoes.length) notes.push('有 ' + vetoes.length + ' 家给出**否决**结论（见 verdicts）：否决是对改动的判断，不是"没意见"，此时不签发凭证。');
  if (vendors < 2 && okList.length > 1) notes.push('注意：成功的 ' + okList.length + ' 位 judge 其实只有 ' + vendors + ' 家厂商，不构成跨厂商独立意见。');
  else if (vendors < vendorsRequested) notes.push('实际成功的 judge 只来自 ' + vendors + ' 家厂商（请求了 ' + vendorsRequested + ' 家）。');

  // reviewId 的签发判据全部收敛到 decideReview（纯函数，可离线验证）。
  // 这里只负责：取指纹、调它、按结论落盘。
  const base = config.stateDir || (config.workRoots && config.workRoots[0]) || '.';
  const fresh = materialItems ? checkMaterialFreshness(covered, materialItems) : { ok: true, changed: [] };
  const changedDuring = !!(fingerprintBefore
    && JSON.stringify(fingerprintPaths(covered)) !== JSON.stringify(fingerprintBefore)) || !fresh.ok;
  const decision = decideReview({
    verdicts, failedCount: failed.length, judgeCount: names.length,
    conflicts, paths: covered, changedDuring, vendors, materialCoverage, fingerprintUnknown,
  });
  let reviewId = null;
  let reviewNote = decision.note;
  if (decision.issue) {
    reviewId = newReviewId();
    try {
      appendReview(base, {
        reviewId, at: new Date().toISOString(), mode: rest.mode,
        questionHead: String(rest.question || '').slice(0, 200),
        paths: covered, fingerprint: fingerprintBefore || fingerprintPaths(covered), ms: Date.now() - started,
        parallel: names,
        // 见单路分支同一处注释：票据要能回答「凭什么签的」。
        verdicts,
        ...(materialCoverage && materialCoverage.via ? { materialVia: materialCoverage.via } : {}),
      });
    } catch (e) {
      reviewId = null;
      reviewNote = '票据写入失败，未签发 reviewId：' + (e && e.message);
    }
  }

  return {
    ok: okList.length > 0,
    partial: okList.length > 0 && failed.length > 0,
    judges: names,
    vendors,
    verdicts,
    ms: Date.now() - started,
    // ❗向后兼容（第 14 轮会审 portdan 指出）：v0.7 的调用方读的是**顶层** `answer` /
    // `conclusion`。默认改成并行后这两个键消失，老调用方拿到的只会是 undefined，
    // 不报错、不抛异常 —— 静默退化比报错难查得多。这里补「第一家成功者的结论」，
    // 并用 answerFrom 说明它出自谁；多家的完整意见仍在 results[] 里，不会被这条覆盖。
    //
    // ❗但只要有一家否决或有冲突，这两个顶层键就**不出现**（第 18 轮会审 sonnet 指出）：
    // 老调用方只读顶层，会看到「第一家的通过结论 + ok:true」，而另一家其实说了否决。
    // 顶层是给「还不知道有并行这回事」的调用方看的，它必须只在「没有坏消息」时才出现。
    ...(okList.length && !conflicts.length && !verdicts.some(v => v.verdict === 'fail') ? {
      answer: {
        ...(okList[0].conclusion === undefined ? {} : { conclusion: okList[0].conclusion }),
        ...(okList[0].evidence === undefined ? {} : { evidence: okList[0].evidence }),
        ...(okList[0].counterexamples === undefined ? {} : { counterexamples: okList[0].counterexamples }),
        ...(okList[0].verification === undefined ? {} : { verification: okList[0].verification }),
        ...(okList[0].verdict === undefined ? {} : { verdict: okList[0].verdict }),
      },
      ...(okList[0].conclusion === undefined ? {} : { conclusion: okList[0].conclusion }),
      answerFrom: okList[0].judge,
      // 老调用方还读 provider / log（「问的谁、日志在哪」）—— 一并补上，
      // 否则并行默认化之后它们拿到 undefined 也不报错，只是把「哪家答的」丢了。
      ...(okList[0].judge ? { provider: okList[0].judge } : {}),
      ...(okList[0].log ? { log: okList[0].log } : {}),
    } : {}),
    results: perJudge,
    failed,
    conflicts,
    // ❗签发时才给 reviewId；没签发就**不返回这个键**。
    // schema 里它声明的是 string —— 返回 null 会让按类型校验的宿主当场报错，
    // 而 `null` 和「键不存在」对调用方的意思其实一样（都是没凭证）。
    ...(reviewId ? { reviewId, reviewedPaths: covered } : { reviewedPaths: [] }),
    ...(reviewNote ? { reviewNote } : {}),
    note: notes.join(' '),
    // ❗不再用 `materialStats: undefined` 占位（会审 opus 指出）：schema 里它是有固定形状的对象，
    // 而「键存在但值是 undefined」在 JSON 序列化时被丢掉、在断言里又算存在，两边都不好查。
    ...(materials ? { materialStats: { chars: String(materials).length } } : {}),
  };
}
