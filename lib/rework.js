// 会审的「固定环节」闸：一轮对话只允许两个会审节点 —— 动手前（design）、交付前（delivery）。
//
// 由来（2026-11-17 用户要求，两次原话）：
//   「我觉得应该在tandem插件里面加入机制避免你把会审当成了「测试机，不能这么拖拖拉拉啊」」
//   「这个固定环节可以是，设计完成动手前和动手完成交付前」
//   背景：我在一条正则判据上迭代了 7 个版本，每版送一次会审，一天 32 次会审、57.6 分钟。
//   原有的 consultMaxRounds(=2) 一次都没拦住，因为它的任务身份由**调用方措辞**决定
//   （lib/budget.js 的 taskKeyFor：无 paths 时哈希 question 前 500 字）——我每轮改写
//   question 就换一个 key，计数器从 0 重来。磁盘上 54 个 key、最近 7 个各不相同、每个只有
//   1 轮，就是这个洞的直接证据。
//
// 现在的语义（2026-11-17 portdan 会审 fail 后按其判定重写）：
//   1. **身份是根会话**，不是问题措辞、不是 cwd。子代理（origin:"subagent"）顺着
//      header.parentSession 上溯到根，它拿不到一份独立额度。
//   2. **两个阶段格，各一次，永久有效**。没有 24 小时窗口 —— 窗口是存储清理期限，
//      不能变成额度有效期（portdan：「『一轮对话只能审两次』没有 24 小时后恢复额度的含义」）。
//   3. **阶段必填且必须是白名单值**。缺失/未知 → 直接拒绝，且**不消耗任何额度**
//      （否则写错一个字就把这一天两次用掉了）。
//   4. **判定是 fail 还是 pass 都算已用**。不能靠「拿到 fail 就重问」恢复额度。
//   5. **没有 cwd 兜底、没有 agent 可用的 force 入口**。cwd 计数会混合无关工作、换目录即可
//      绕过；forceRound 这种「调用方自己传的参数」从来不是权限边界。
//      人若要追加一次会审，那是政策例外：人工直接编辑 consult-rework.json（agent 无此入口）。
//   6. **状态损坏 fail-closed**：账本读不出来就拒绝会审，不能静默当成「还没用过」。
//   7. **先落盘再发请求**：已发起或无法确定是否发起的调用不能退款（只有确认没发起才可释放）。
//
// 与 lib/budget.js 的关系：**互不影响、AND 关系**。任务级 consultMaxRounds 原样保留，
// 本文件落在独立文件 consult-rework.json，不碰 consult-budget.json 的任何既有结构。

import {
  existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
  openSync, closeSync, unlinkSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fingerprintPaths } from './reviews.js';

/** 两个固定环节。顺序有意义：design 在 delivery 之前。 */
export const PHASES = ['design', 'delivery'];

/** 存储格式版本。v1 是「返工轮计数」，已废弃；读到 v1 按损坏处理（fail-closed）。 */
export const DB_VERSION = 2;

/** 陈年记录清理期限。❗只影响存储体积，与额度判定无关。 */
export const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 15000;

export function reworkPath(stateDir) {
  return join(String(stateDir), 'consult-rework.json');
}

// ── 账本读写 ────────────────────────────────────────────────────────────

class CorruptStateError extends Error {}

function emptyDb() {
  return { version: DB_VERSION, sessions: {} };
}

/**
 * 读账本。
 * ❗**损坏就抛**，绝不返回空账本 —— 返回空等于「谁都能白拿两次」。
 *   只有「文件不存在」是合法的空账本。
 */
function readDb(stateDir) {
  const file = reworkPath(stateDir);
  if (!existsSync(file)) return emptyDb();
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new CorruptStateError('会审账本 ' + file + ' 读不出来或不是合法 JSON（' + (e && e.message) + '）。'
      + '为避免额度被静默重置，这次会审被拒绝。请人工检查该文件：修好它，或明确删掉它重新开始。');
  }
  if (!raw || typeof raw !== 'object') {
    throw new CorruptStateError('会审账本 ' + file + ' 不是对象，拒绝继续（fail-closed）。');
  }
  if (raw.version !== DB_VERSION) {
    throw new CorruptStateError('会审账本 ' + file + ' 的格式是 version=' + raw.version
      + '，当前只认 version=' + DB_VERSION + '。旧格式（返工轮计数）不再兼容 —— '
      + '这是有意的：不能让一份旧账本被当成「还没用过」。请人工确认后删除该文件重新初始化。');
  }
  if (!raw.sessions || typeof raw.sessions !== 'object' || Array.isArray(raw.sessions)) {
    throw new CorruptStateError('会审账本 ' + file + ' 缺少 sessions 对象，拒绝继续（fail-closed）。');
  }
  return raw;
}

function writeDb(stateDir, db) {
  mkdirSync(String(stateDir), { recursive: true });
  const file = reworkPath(stateDir);
  const tmp = file + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  renameSync(tmp, file);
  return true;
}

// ── 互斥锁 ──────────────────────────────────────────────────────────────
//
// 读改写同一个 JSON 必须串行（2026-11-17 portdan 反例：claim 与 record 各自无锁读改写，
// 并发会串账）。O_CREAT|O_EXCL 建锁文件，进程内同步自旋；超过 STALE_MS 视为崩溃残留清掉。
// ❗拿不到锁 **fail-closed**：争锁超时还继续无锁写，等于没加锁。

function lockSleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 忙等兜底 */ }
  }
}

function lockDb(stateDir) {
  const file = reworkPath(stateDir) + '.lock';
  const deadline = Date.now() + LOCK_WAIT_MS;
  try { mkdirSync(String(stateDir), { recursive: true }); } catch { /* ignore */ }
  for (;;) {
    try {
      const fd = openSync(file, 'wx');
      try { writeFileSync(fd, String(process.pid)); } catch { /* ignore */ }
      return { file, fd };
    } catch (e) {
      if (e && e.code !== 'EEXIST') return null;
      try {
        const st = statSync(file);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { unlinkSync(file); continue; }
      } catch { /* 刚被删掉，立刻重试 */ }
      if (Date.now() > deadline) return null;
      lockSleep(10);
    }
  }
}

function unlockDb(lock) {
  if (!lock) return;
  try { closeSync(lock.fd); } catch { /* ignore */ }
  try { unlinkSync(lock.file); } catch { /* ignore */ }
}

// ── 身份 ────────────────────────────────────────────────────────────────

/**
 * 会话链归一化：接受 leaf→root 的 id 数组，去空、去重、保留顺序。
 * 根会话 = 链尾（最后一个能解析到的祖先）。拿不到链时退回单元素链。
 */
export function normalizeChain(chain, fallbackSession = '') {
  const out = [];
  const push = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) return;
    // ❗防重复前缀：内核里 sessionOf 可能已经返回 "s:xxx" 形式，别叠成 "s:s:xxx"。
    const bare = s.replace(/^s:/, '');
    if (!out.includes(bare)) out.push(bare);
  };
  if (Array.isArray(chain)) for (const v of chain) push(v);
  else push(chain);
  push(fallbackSession);
  return out;
}

/** 身份记录：根会话键 + 完整链（链用于「任何一代被用过都算」的检查）。 */
export function identityOf({ chain = [], session = '' } = {}) {
  const list = normalizeChain(chain, session);
  if (!list.length) return { chain: [], leafKey: '', rootKey: '', rootSession: '' };
  const rootSession = list[list.length - 1];
  return {
    chain: list,
    leafKey: 's:' + list[0],
    rootKey: 's:' + rootSession,
    rootSession,
  };
}

/** 材料指纹：内容哈希（复用 reviews.js，它已是 sha1 内容哈希、超限才降级 weak）。 */
export function materialFingerprint({ paths = [], question = '' } = {}) {
  const list = Array.isArray(paths) ? paths.map(String).filter(Boolean) : [];
  if (!list.length) return '';
  let fp = '';
  try { fp = fingerprintPaths(list); } catch { return ''; }
  const q = createHash('sha1').update(String(question || '').replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex').slice(0, 12);
  return fp + '|q:' + q;
}

// ── 阶段校验 ────────────────────────────────────────────────────────────

export function normalizePhase(phase) {
  const p = String(phase == null ? '' : phase).trim().toLowerCase();
  return PHASES.includes(p) ? p : '';
}

function describeUsed(entry) {
  const parts = [];
  for (const p of PHASES) {
    const rec = entry && entry.phases && entry.phases[p];
    if (!rec) continue;
    const v = Array.isArray(rec.verdicts) && rec.verdicts.length
      ? rec.verdicts.join('+')
      : (rec.pending ? '进行中' : (rec.ok === false ? '调用失败' : '无判定'));
    parts.push(p + '（' + String(rec.at || '').replace('T', ' ').slice(0, 16) + ' ' + v + '）');
  }
  return parts.join('；');
}

function reject(reason, error, extra = {}) {
  return { allowed: false, reason, error, persisted: false, ...extra };
}

// ── 认领 ────────────────────────────────────────────────────────────────

/**
 * 认领一次会审。
 * @param {string} stateDir
 * @param {{chain?:string[], session?:string, phase:string, question?:string, paths?:string[], now?:number}} opts
 * @returns {{allowed:boolean, reason:string, error?:string, phase?:string, rootSession?:string,
 *            used?:string[], diagnostics?:object, persisted?:boolean, _ticket?:object}}
 *
 * 拒绝原因：`no-identity` / `bad-phase` / `phase-used` / `same-as-last` / `lock-busy` / `corrupt-state`
 */
export function claimRework(stateDir, opts = {}) {
  const phase = normalizePhase(opts.phase);
  const id = identityOf({ chain: opts.chain, session: opts.session });
  const base = {
    phase: phase || null,
    rootSession: id.rootSession || null,
    used: [],
  };

  // 阶段名先校验：写错一个字不该消耗额度。
  if (!phase) {
    return reject('bad-phase',
      '会审必须指明这是哪个固定环节：phase 只能是 '
      + PHASES.map(p => '"' + p + '"').join(' 或 ')
      + '（design = 设计完成、动手之前；delivery = 做完、交付之前）。'
      + '你传的是 ' + JSON.stringify(opts.phase == null ? null : String(opts.phase))
      + '。这次没有消耗任何额度，改对再来。', base);
  }
  if (!id.rootKey) {
    return reject('no-identity',
      '拿不到会话身份，无法把这次会审记到某一轮对话上（fail-closed 拒绝，不是网络问题）。', base);
  }

  const lock = lockDb(stateDir);
  if (!lock) {
    return reject('lock-busy',
      '另一个会审正在写账本（' + reworkPath(stateDir) + '.lock 拿不到，等了 ' + LOCK_WAIT_MS
      + ' 毫秒）。这不是额度用完，重试一次通常就好；持续出现就删掉那个 .lock 再试。', base);
  }

  try {
    let db;
    try {
      db = readDb(stateDir);
    } catch (e) {
      return reject('corrupt-state', e instanceof CorruptStateError ? e.message : String(e && e.message || e), base);
    }

    // 链上任何一代被用过，都算这一轮对话用过（子代理不能靠 fork 拿新额度）。
    // 主键落在根会话上；同时检查整条链上的历史键（兼容「先有子代理记录、后补上根」的情况）。
    const keys = [...new Set([id.rootKey, ...id.chain.map(s => 's:' + s)])];
    const owners = keys.map(k => [k, db.sessions[k]]).filter(([, e]) => e && e.phases);
    const used = [];
    const seen = {};
    for (const [, e] of owners) {
      for (const p of PHASES) {
        if (e.phases[p] && !seen[p]) { seen[p] = e.phases[p]; used.push(p); }
      }
    }
    base.used = used;

    if (seen[phase]) {
      const rec = seen[phase];
      const at = String(rec.at || '').replace('T', ' ').slice(0, 16);
      const v = Array.isArray(rec.verdicts) && rec.verdicts.length ? rec.verdicts.join('+')
        : (rec.pending ? '还在跑' : '已用');
      return reject('phase-used',
        '这一轮对话的「' + phase + '」会审已经用过了（' + at + ' ' + v + '）。'
        + '一轮对话只有两次：动手前一次（design）、交付前一次（delivery），每个环节各一次，'
        + '判定是 fail 还是 pass 都算用掉 —— 拿 fail 就重新问一遍不会恢复额度。'
        + '现在该做的是：按已拿到的意见把活干完，把「未获通过」的状态如实说明，由人决定是否交付。'
        + (used.length ? '（本轮对话已用：' + used.join('、') + '）' : ''),
        { ...base, diagnostics: { rootSession: id.rootSession, chain: id.chain, keys } });
    }

    // 辅闸：材料内容一字未变、问题也一样 → 上一次的结论仍然有效。
    // ⚠️ 它**只挡逐字节相同**，改一个字符就放行，所以不承担主闸职责。
    const fp = materialFingerprint({ paths: opts.paths, question: opts.question });
    const allRounds = owners.flatMap(([, e]) => Array.isArray(e.rounds) ? e.rounds : []);
    const lastRec = allRounds.length ? allRounds[allRounds.length - 1] : null;
    if (fp && lastRec && lastRec.fp && String(lastRec.fp) === fp) {
      return reject('same-as-last',
        '这次的题面与上一次**逐字节相同**（材料内容和问题都没变），上一次的结论仍然有效。'
        + '要么按上一轮的失败项真改代码，要么把新的证据 / 新的疑问写进问题里 —— 原样再问不会有不同答案。'
        + '（这次没有消耗额度。）', base);
    }

    // 先落盘再发请求：崩了也算用过，否则崩溃重试就是免费轮次。
    const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
    const rec = {
      at: new Date(now).toISOString(),
      ok: null,
      pending: true,
      verdicts: [],
      ms: 0,
      ...(fp ? { fp } : {}),
    };
    const entry = db.sessions[id.rootKey] && db.sessions[id.rootKey].phases ? db.sessions[id.rootKey] : { phases: {}, rounds: [] };
    entry.phases = { ...(entry.phases || {}), [phase]: rec };
    entry.rounds = Array.isArray(entry.rounds) ? entry.rounds.slice(-19) : [];
    entry.rounds.push({ at: rec.at, phase, pending: true, ...(fp ? { fp } : {}) });
    entry.rootSession = id.rootSession;
    entry.chain = id.chain;
    entry.updatedAt = rec.at;
    db.sessions[id.rootKey] = entry;

    // 同一份账本也给整条链其它键记一格，防止「先记录在子会话、之后父会话再要额度」。
    for (const k of keys) {
      if (k === id.rootKey) continue;
      const e = db.sessions[k] && db.sessions[k].phases ? db.sessions[k] : { phases: {}, rounds: [] };
      e.phases = { ...(e.phases || {}), [phase]: rec };
      db.sessions[k] = e;
    }

    let persisted = true;
    try {
      writeDb(stateDir, db);
    } catch (e) {
      // 写不进去就不发请求：这次算没领到（不退款，因为根本没发）。
      return reject('state-unwritable',
        '账本写不进去（' + (e && e.message) + '），为避免额度记账丢失，这次会审没有发出。', base);
    }

    return {
      allowed: true,
      reason: 'ok',
      ...base,
      used: [...used, phase],
      persisted,
      diagnostics: { rootSession: id.rootSession, chain: id.chain, keys, fp: fp || null },
      _ticket: { rootKey: id.rootKey, keys, phase, at: rec.at },
    };
  } finally {
    unlockDb(lock);
  }
}

// ── 记录结果 ────────────────────────────────────────────────────────────

/** 把评审结果写回这次认领的那一格。判定是 fail/unclear 也照样算「已用」（额度不复原）。 */
export function recordRework(stateDir, ticket, { ok = null, verdicts = [], ms = 0, now = Date.now() } = {}) {
  if (!ticket || !ticket.rootKey || !ticket.phase) return null;
  const lock = lockDb(stateDir);
  if (!lock) return null;                 // 拿不到锁就不写，宁可丢一次结果也不写坏账本
  try {
    const db = readDb(stateDir);
    const list = Array.isArray(verdicts)
      ? verdicts.map(v => String(v && v.verdict ? v.verdict : v)).filter(Boolean)
      : [];
    const item = {
      ok: ok === null || ok === undefined ? null : !!ok,
      verdicts: list,
      ms: Number(ms) || 0,
      pending: false,
      doneAt: new Date(Number(now) > 0 ? Number(now) : Date.now()).toISOString(),
    };
    for (const k of [...new Set([ticket.rootKey, ...(ticket.keys || [])])]) {
      const entry = db.sessions[k];
      if (!entry || !entry.phases) continue;
      if (!entry.phases[ticket.phase]) continue;
      entry.phases = { ...entry.phases, [ticket.phase]: { ...entry.phases[ticket.phase], ...item } };
      if (Array.isArray(entry.rounds) && entry.rounds.length) {
        const rounds = entry.rounds.slice();
        for (let i = rounds.length - 1; i >= 0; i--) {
          if (rounds[i] && rounds[i].pending && rounds[i].phase === ticket.phase) {
            rounds[i] = { ...rounds[i], ...item };
            break;
          }
        }
        entry.rounds = rounds;
      }
    }
    writeDb(stateDir, db);
    return { ok: item.ok, verdicts: list };
  } finally {
    unlockDb(lock);
  }
}

// ── 运维入口 ────────────────────────────────────────────────────────────

/**
 * 清空账本（只给人用）。
 * agent 没有工具入口能到这里；只有人工改文件这一条路（这是有意的：force 参数不是权限边界）。
 */
export function resetRework(stateDir, key = null) {
  const db = readDb(stateDir);
  if (key) delete db.sessions[key];
  else db.sessions = {};
  writeDb(stateDir, db);
  return db;
}

/** 清理超出保留期的记录。❗只影响文件体积，**不影响额度判定**。 */
export function pruneRework(stateDir, { retentionMs = DEFAULT_RETENTION_MS, now = Date.now() } = {}) {
  const db = readDb(stateDir);
  let removed = 0;
  for (const [key, entry] of Object.entries(db.sessions || {})) {
    const t = Date.parse(entry && entry.updatedAt);
    if (Number.isFinite(t) && now - t > retentionMs) { delete db.sessions[key]; removed++; }
  }
  if (removed) writeDb(stateDir, db);
  return { removed };
}

/** 体检数据：tandem_status 用。 */
export function reworkStatus(stateDir) {
  const db = readDb(stateDir);
  const out = [];
  for (const [key, entry] of Object.entries(db.sessions || {})) {
    if (!entry || !entry.phases) continue;
    const phases = {};
    for (const p of PHASES) {
      const rec = entry.phases[p];
      if (!rec) continue;
      phases[p] = {
        at: rec.at || null,
        ok: rec.ok === undefined ? null : rec.ok,
        pending: !!rec.pending,
        verdicts: Array.isArray(rec.verdicts) ? rec.verdicts : [],
      };
    }
    if (!Object.keys(phases).length) continue;
    out.push({
      key,
      rootSession: entry.rootSession || '',
      used: Object.keys(phases),
      phases,
      summary: describeUsed(entry),
    });
  }
  return out;
}

export { CorruptStateError };
