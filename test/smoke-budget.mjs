// 会审轮次预算的验收（2026-11-13 用户要求：轮次上限必须是机制，不能靠对话记忆）。
//
// 背景：同一天我在「dsh-tandem 0.8.0 取凭证」这一件事上连问 9 轮会审，
// 每轮对方换一个新缺陷，用户等了 50 多分钟。当时「最多两轮」只写在我自己的回复里，
// 一压缩就没了。所以这里测的不是「代码能不能跑」，而是**第 3 轮会不会被拦住**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claimRound,
  recordRound,
  taskKeyFor,
  readBudget,
  resetBudget,
  budgetPath,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_WINDOW_MS,
} from '../lib/budget.js';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'tandem-budget-'));
  return dir;
}

const PATHS_A = ['D:/proj/lib/consult.js', 'D:/proj/index.js'];
const PATHS_B = ['D:/proj/lib/other.js'];

test('同一个任务：第 1、2 轮放行，第 3 轮拒绝', () => {
  const dir = sandbox();
  const key = taskKeyFor({ paths: PATHS_A });

  const r1 = claimRound(dir, key, { maxRounds: 2 });
  assert.equal(r1.allowed, true, '第 1 轮应当放行');
  assert.equal(r1.round, 1);
  assert.equal(r1.remaining, 1);
  recordRound(dir, key, { ok: true, verdicts: [{ verdict: 'fail' }], ms: 50000 });

  const r2 = claimRound(dir, key, { maxRounds: 2 });
  assert.equal(r2.allowed, true, '第 2 轮应当放行');
  assert.equal(r2.round, 2);
  assert.equal(r2.remaining, 0);
  recordRound(dir, key, { ok: true, verdicts: [{ verdict: 'fail' }], ms: 60000 });

  const r3 = claimRound(dir, key, { maxRounds: 2 });
  assert.equal(r3.allowed, false, '第 3 轮必须被拦住');
  assert.match(r3.historyText, /第1轮/);
  assert.match(r3.historyText, /第2轮/);
  assert.match(r3.historyText, /fail/);
  // 被拒的那一轮不能写进计数，否则会无限膨胀
  assert.equal(readBudget(dir).keys[key].rounds.length, 2);
});

test('forceRound 能越过上限，且照样记进历史', () => {
  const dir = sandbox();
  const key = taskKeyFor({ paths: PATHS_A });
  claimRound(dir, key, { maxRounds: 1 });
  recordRound(dir, key, { ok: true, verdicts: ['pass'] });

  const blocked = claimRound(dir, key, { maxRounds: 1 });
  assert.equal(blocked.allowed, false);

  const forced = claimRound(dir, key, { maxRounds: 1, force: true });
  assert.equal(forced.allowed, true, 'force=true 时应当放行');
  assert.equal(forced.forced, true, '要标出来这一轮是越过的');
  recordRound(dir, key, { ok: false, verdicts: ['fail'] });
  assert.equal(readBudget(dir).keys[key].rounds.length, 2, '越过的轮次同样入账');
});

test('换一批 paths 是另一个任务，不共享计数', () => {
  const dir = sandbox();
  const a = taskKeyFor({ paths: PATHS_A });
  const b = taskKeyFor({ paths: PATHS_B });
  assert.notEqual(a, b);

  claimRound(dir, a, { maxRounds: 2 });
  claimRound(dir, a, { maxRounds: 2 });
  assert.equal(claimRound(dir, a, { maxRounds: 2 }).allowed, false);

  const other = claimRound(dir, b, { maxRounds: 2 });
  assert.equal(other.allowed, true, '另一个任务不该被牵连');
  assert.equal(other.round, 1);
});

test('paths 顺序不同算同一个任务（按集合而不是按数组）', () => {
  const a = taskKeyFor({ paths: ['D:/x/a.js', 'D:/x/b.js'] });
  const b = taskKeyFor({ paths: ['D:/x/b.js', 'D:/x/a.js'] });
  assert.equal(a, b);
});

test('没有 paths 时按 question 认任务', () => {
  const dir = sandbox();
  const q = '这段签发判据有没有 bug？';
  const key = taskKeyFor({ question: q });
  claimRound(dir, key, { maxRounds: 1 });
  assert.equal(claimRound(dir, key, { maxRounds: 1 }).allowed, false);
  // 同一句问法（多空格差异）仍算同一任务
  assert.equal(taskKeyFor({ question: '这段签发判据有没有  bug？' }), key);
  // 另一句是新任务
  assert.equal(claimRound(dir, taskKeyFor({ question: '换个问题' }), { maxRounds: 1 }).allowed, true);
});

test('24 小时窗口：过期后自动清零', () => {
  const dir = sandbox();
  const key = taskKeyFor({ paths: PATHS_A });
  const t0 = Date.parse('2026-11-13T12:00:00Z');
  claimRound(dir, key, { maxRounds: 1, now: t0 });
  recordRound(dir, key, { ok: false, now: t0 });

  const later = claimRound(dir, key, { maxRounds: 1, now: t0 + 60 * 60 * 1000 });
  assert.equal(later.allowed, false, '一小时后仍在窗口内');

  const nextDay = claimRound(dir, key, { maxRounds: 1, now: t0 + DEFAULT_WINDOW_MS + 1000 });
  assert.equal(nextDay.allowed, true, '过了窗口应当重新可用');
  assert.equal(nextDay.round, 1);
});

test('默认值：2 轮', () => {
  assert.equal(DEFAULT_MAX_ROUNDS, 2);
});

test('recordRound 覆盖 pending 占位，不会一轮记成两条', () => {
  const dir = sandbox();
  const key = taskKeyFor({ paths: PATHS_A });
  claimRound(dir, key, { maxRounds: 3 });
  const item = recordRound(dir, key, { ok: true, verdicts: ['pass'], ms: 1234, reviewId: 'rv-abc' });
  assert.equal(item.reviewId, 'rv-abc');
  const rounds = readBudget(dir).keys[key].rounds;
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].pending, false);
  assert.deepEqual(rounds[0].verdicts, ['pass']);
  assert.equal(rounds[0].ms, 1234);
});

test('预算文件损坏时不挡会审（fail-open），并且不会把坏数据当成历史', () => {
  const dir = sandbox();
  const key = taskKeyFor({ paths: PATHS_A });
  writeFileSync(budgetPath(dir), '{ this is not json', 'utf8');
  const r = claimRound(dir, key, { maxRounds: 1 });
  assert.equal(r.allowed, true, '坏文件不能成为拒绝会审的理由');
  // 写回之后是可解析的
  const raw = JSON.parse(readFileSync(budgetPath(dir), 'utf8'));
  assert.equal(Array.isArray(raw.keys[key].rounds), true);
});

test('resetBudget 清空之后重新计数', () => {
  const dir = sandbox();
  const key = taskKeyFor({ paths: PATHS_A });
  claimRound(dir, key, { maxRounds: 1 });
  assert.equal(claimRound(dir, key, { maxRounds: 1 }).allowed, false);
  resetBudget(dir, key);
  assert.equal(claimRound(dir, key, { maxRounds: 1 }).allowed, true);
});
