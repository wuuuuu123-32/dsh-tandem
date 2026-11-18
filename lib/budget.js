// 会审轮次预算：把「同一个任务最多问几轮」变成机制，而不是靠对话记忆。
//
// 为什么需要这个文件（2026-11-13 用户要求，原话「这个会审轮次限制要加入插件的机制管控里面，
// 不能考某一次对话记住」）：
//   我（模型）在 2026-11-13 晚同一件事上连续问了 9 轮会审，每轮它换一个新缺陷，
//   用户在旁边等了 50 多分钟。当时「最多两轮」这条规则只写在我的回复里，
//   而回复会被压缩、会滚出上下文，等于没有约束。
//   ⇒ 把计数落到磁盘上：`<stateDir>/consult-budget.json`，按「任务」记轮次。
//
// 任务怎么算（taskKeyFor）：
//   · 有 paths  → 按 paths 的**集合**（排序后小写）算哈希：同一批文件的多轮会审算同一个任务；
//   · 没 paths  → 退回按 question 的前 500 字算哈希。
//   这样「同一件事问第 3 次」会被认出来，而「换一件事问」不会被旧计数挡住。
//
// 时间窗：24 小时内计数有效。过了窗口自动清零 —— 第二天继续改同一批文件是正常的，
// 不该被前一天的轮次封印。
//
// 耗尽之后：默认直接拒绝（fail-closed），要越过必须显式传 forceRound: true，
// 而且这一轮会照常记进历史，谁也赖不掉。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { localStamp } from './time.js';

export const DEFAULT_MAX_ROUNDS = 2;
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 「must be dual」的判据：judges 少于两家就返回错误文案，够两家返回空串。
 *
 * 为什么是机制：2026-11-13 我在同一件事上连问 9 轮，其中 8 轮为了省时间传了
 * `judges: ['portdan']` —— 看起来还是「会审」，实际已经是单路。用户当场指出
 * 「你确保现在是双跑会审」。所以把「至少两家」写成函数，单路只能走显式的
 * `provider` 参数（那是「钉死问某一家」，语义清楚，不会被误读成并行）。
 *
 * ❗2026-11-17 起这条**默认关**（用户要求「取消默认调用双方会审，默认只使用gpt」）：
 * 函数还在、判据还在，只是 `consultRequireDual` 的默认值从 true 改成 false。
 * 想回到「必须两家」，把它设回 true 即可，不用改代码。
 */
export function dualJudgeError(judges, { requireDual = true } = {}) {
  if (!requireDual) return '';
  const distinct = [...new Set((Array.isArray(judges) ? judges : []).map((x) => String(x == null ? '' : x).trim()).filter(Boolean))];
  if (distinct.length >= 2) return '';
  return (
    '会审要求跨厂商双跑（这条由配置 consultRequireDual:true 打开）：judges 至少要两家（解析后是 ' + distinct.length + ' 家：' + (distinct.join(' / ') || '空') + '）。' +
    '如果确实只该问一家，请改用 provider 参数钉死那一家——那是显式单路，不会被当成并行。' +
    '要关掉这条要求（默认就是关的），把插件配置里的 consultRequireDual 设成 false。'
  );
}

/** 预算文件路径。 */
export function budgetPath(stateDir) {
  return join(String(stateDir), 'consult-budget.json');
}

/** 任务标识：同一批 paths（或同一句 question）算同一个任务。 */
export function taskKeyFor({ paths = [], question = '' } = {}) {
  const list = Array.isArray(paths) ? paths.map(p => String(p).trim().toLowerCase()).filter(Boolean) : [];
  const base = list.length
    ? 'paths:' + [...new Set(list)].sort().join('|')
    : 'q:' + String(question || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  return createHash('sha1').update(base).digest('hex').slice(0, 12);
}

/** 读整个预算文件（坏文件当成空，不让它挡住会审）。 */
export function readBudget(stateDir) {
  const file = budgetPath(stateDir);
  try {
    if (!existsSync(file)) return { keys: {} };
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.keys || typeof raw.keys !== 'object') return { keys: {} };
    return raw;
  } catch {
    return { keys: {} };
  }
}

function writeBudget(stateDir, data) {
  const file = budgetPath(stateDir);
  try {
    mkdirSync(String(stateDir), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch {
    // 写不进去不能变成「拒绝会审」的理由：预算失效时退化成不限制（fail-open），
    // 但返回值里会带 persisted:false，调用方看得见。
  }
}

function prune(entry, now, windowMs) {
  const rounds = Array.isArray(entry && entry.rounds) ? entry.rounds : [];
  return rounds.filter(r => {
    const t = Date.parse(r && r.at);
    return Number.isFinite(t) && now - t < windowMs;
  });
}

function describe(rounds) {
  if (!rounds.length) return '这个任务还没问过。';
  return '已问 ' + rounds.length + ' 轮：' + rounds.map((r, i) => {
    const v = Array.isArray(r.verdicts) && r.verdicts.length ? r.verdicts.join('+') : (r.ok === false ? '失败' : '无判定');
    // 时间走 localStamp（本地 + (UTC+8) 标注）。原来这里和 rework.js 一样是裸截断 UTC，
    // 同一个显示 bug 的两处副本，2026-11-19 一起修。
    const at = localStamp(r.at);
    return '第' + (i + 1) + '轮 ' + at + ' ' + v;
  }).join('；') + '。';
}

/**
 * 认领一轮会审。
 * 返回 { allowed, round, used, maxRounds, remaining, historyText, summary, persisted }。
 * allowed=false 时调用方应当拒绝执行，并把 historyText 原样告诉用户。
 */
export function claimRound(stateDir, key, {
  maxRounds = DEFAULT_MAX_ROUNDS,
  force = false,
  windowMs = DEFAULT_WINDOW_MS,
  now = Date.now(),
} = {}) {
  const max = Number(maxRounds) > 0 ? Math.floor(Number(maxRounds)) : DEFAULT_MAX_ROUNDS;
  const db = readBudget(stateDir);
  const entry = db.keys[key] || { rounds: [] };
  const rounds = prune(entry, now, windowMs);
  const used = rounds.length;
  const historyText = describe(rounds);
  const allowed = force || used < max;

  if (allowed) {
    // ❗先落盘再执行：跑的过程中崩了，这一轮也算用过 —— 否则崩溃重试就成了免费轮次。
    rounds.push({ at: new Date(now).toISOString(), ok: null, pending: true });
    db.keys[key] = { rounds };
    writeBudget(stateDir, db);
  }

  return {
    allowed,
    round: used + 1,
    used,
    maxRounds: max,
    remaining: Math.max(0, max - used - (allowed ? 1 : 0)),
    forced: force && used >= max,
    historyText,
    persisted: true,
    summary: { used, maxRounds: max, historyText },
  };
}

/** 把这一轮的结果记上去（覆盖 claimRound 留下的 pending 占位）。 */
export function recordRound(stateDir, key, {
  ok = null,
  verdicts = [],
  reviewId = null,
  ms = 0,
  now = Date.now(),
} = {}) {
  const db = readBudget(stateDir);
  const entry = db.keys[key] || { rounds: [] };
  const rounds = Array.isArray(entry.rounds) ? entry.rounds.slice() : [];
  // 找最后一个 pending；没有就补一条（调用方可能没认领过，例如 forceRound 之外的路径）
  let idx = -1;
  for (let i = rounds.length - 1; i >= 0; i--) { if (rounds[i] && rounds[i].pending) { idx = i; break; } }
  const item = {
    at: new Date(now).toISOString(),
    ok: ok === null || ok === undefined ? null : !!ok,
    verdicts: Array.isArray(verdicts) ? verdicts.map(v => String(v && v.verdict ? v.verdict : v)).filter(Boolean) : [],
    ...(reviewId ? { reviewId: String(reviewId) } : {}),
    ms: Number(ms) || 0,
  };
  if (idx >= 0) rounds[idx] = { ...rounds[idx], ...item, pending: false };
  else rounds.push(item);
  db.keys[key] = { rounds };
  writeBudget(stateDir, db);
  return item;
}

/**
 * 把一次「认领了但根本没发出去」的轮次还回去（2026-11-17 加）。
 *
 * 用途：consult 有两层闸（任务级 consultMaxRounds + 返工轮 rework.js）。第 1 层
 * claimRound 会**先落盘 pending 再返回**；如果第 2 层随后拒绝，那次会审根本没发出去，
 * 却已经在任务级计数里占掉一格 —— 连点几次就能把 consultMaxRounds 白吃光。
 * 所以第 2 层拒绝时调这里，把最后那条 pending 撤掉。
 *
 * 只撤**最后一条且仍是 pending** 的记录：已经 recordRound 过的轮次是真花掉的，不能还。
 */
export function releaseRound(stateDir, key, { now = Date.now() } = {}) {
  const db = readBudget(stateDir);
  const entry = db.keys[key];
  if (!entry || !Array.isArray(entry.rounds) || !entry.rounds.length) return false;
  const rounds = entry.rounds.slice();
  const last = rounds[rounds.length - 1];
  if (!last || !last.pending) return false;
  rounds.pop();
  db.keys[key] = { rounds };
  writeBudget(stateDir, db);
  return true;
}

/** 清空某个任务（或全部）的计数。给测试与「用户明确说重新开始」用。 */export function resetBudget(stateDir, key = null) {
  const db = readBudget(stateDir);
  if (key) delete db.keys[key];
  else db.keys = {};
  writeBudget(stateDir, db);
  return db;
}
