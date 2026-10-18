/**
 * 会审标记（reviewId）的单元测试 —— 不依赖真实 Codex。
 *
 * 覆盖两轮会审提出的反例：
 *  - 模型自己编的 id 必须查不到（findReview → null）；
 *  - 标记覆盖「路径范围」，不是「一次配额」：同一 id 可以在覆盖范围内反复用；
 *  - 轮转不能把票据正在引用的凭证丢掉；
 *  - 票据必须能带着 reviewId 往返。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  newReviewId, normalizePaths, appendReview, loadReviews, findReview,
  reviewCovers, pruneReviews, reviewsFile, fingerprintPaths,
} from '../lib/reviews.js';
import { loadTickets, saveTickets, openTicket, getTicket, newTaskId } from '../lib/tickets.js';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([name, true]); }
  catch (error) { results.push([name, false, error.message]); }
}

const dir = mkdtempSync(join(tmpdir(), 'tandem-review-'));

await test('newReviewId 格式固定且互不相同', () => {
  const a = newReviewId();
  const b = newReviewId();
  assert.match(a, /^rv-[0-9a-f]{16}$/);
  assert.notEqual(a, b);
});

await test('appendReview → findReview 往返；伪造 id 查不到', () => {
  const id = newReviewId();
  appendReview(dir, { reviewId: id, at: '2026-10-18T00:00:00.000Z', mode: 'review', paths: [dir] });
  const found = findReview(dir, id);
  assert.ok(found);
  assert.equal(found.mode, 'review');
  assert.equal(findReview(dir, 'rv-0000000000000000'), null);
  assert.equal(findReview(dir, ''), null);
});

await test('坏行不影响其他记录读取', () => {
  const id = newReviewId();
  appendReview(dir, { reviewId: id, at: '2026-10-18T00:00:00.000Z', mode: 'compare', paths: [] });
  const before = loadReviews(dir).length;
  writeFileSync(reviewsFile(dir), 'not-json\n' + loadReviews(dir).map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(loadReviews(dir).length, before);
  assert.ok(findReview(dir, id));
});

await test('normalizePaths 绝对化、去空、截断到 20 条', () => {
  const many = Array.from({ length: 30 }, (_, i) => `rel/${i}.js`);
  const out = normalizePaths(['  ', '', ...many]);
  assert.equal(out.length, 20);
  assert.ok(out.every(p => p.startsWith(resolve('.'))));
});

await test('reviewCovers 按路径前缀判断，不误伤兄弟目录', () => {
  const base = join(dir, 'proj');
  const rev = { paths: [base] };
  assert.equal(reviewCovers(rev, base), true);
  assert.equal(reviewCovers(rev, join(base, 'src', 'a.js')), true);
  assert.equal(reviewCovers(rev, join(dir, 'proj2', 'a.js')), false);
  assert.equal(reviewCovers({ paths: [] }, base), false);
});

await test('Windows 下大小写不同的同一路径视为覆盖', () => {
  if (process.platform !== 'win32') return;
  const base = join(dir, 'Proj');
  assert.equal(reviewCovers({ paths: [base] }, join(dir, 'proj', 'x.js')), true);
});

await test('pruneReviews 保留最近 max 条 + 被票据引用的旧凭证', () => {
  const d = mkdtempSync(join(tmpdir(), 'tandem-prune-'));
  const old = newReviewId();
  appendReview(d, { reviewId: old, at: '2026-01-01T00:00:00.000Z', mode: 'review', paths: [] });
  const recent = [];
  for (let i = 0; i < 5; i++) {
    const id = newReviewId();
    recent.push(id);
    appendReview(d, { reviewId: id, at: '2026-10-18T00:00:0' + i + '.000Z', mode: 'review', paths: [] });
  }
  pruneReviews(d, { max: 3, keep: new Set([old]) });
  const ids = loadReviews(d).map(r => r.reviewId);
  assert.ok(ids.includes(old), '被引用的旧凭证必须保住');
  assert.ok(ids.includes(recent[4]), '最近的必须保住');
  assert.ok(!ids.includes(recent[0]), '既旧又没被引用的应被清掉');
  rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

await test('fingerprintPaths 稳定；内容变则变；忽略 state 目录', () => {
  const d = mkdtempSync(join(tmpdir(), 'tandem-fp-'));
  writeFileSync(join(d, 'a.js'), 'x');
  const f1 = fingerprintPaths([d]);
  assert.match(f1, /^[0-9a-f]{16}$/);
  assert.equal(fingerprintPaths([d]), f1, '同一内容两次指纹必须一致');
  writeFileSync(join(d, 'a.js'), 'xy');
  assert.notEqual(fingerprintPaths([d]), f1, '内容变了指纹必须变');
  const f2 = fingerprintPaths([d]);
  mkdirSync(join(d, 'state'));
  writeFileSync(join(d, 'state', 'reviews.jsonl'), '{}');
  assert.equal(fingerprintPaths([d]), f2, 'state 目录不该参与指纹（否则标记一签发就过期）');
  rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

await test('同尺寸 + 恢复原 mtime 的改写也必须改变指纹（内容哈希，不是元数据）', () => {
  const d = mkdtempSync(join(tmpdir(), 'tandem-fp2-'));
  const f = join(d, 'a.js');
  writeFileSync(f, 'abc');
  const st = statSync(f);
  const before = fingerprintPaths([d]);
  writeFileSync(f, 'abd'); // 同尺寸
  utimesSync(f, st.atime, st.mtime); // 把修改时间恢复原样，只剩内容不同
  assert.notEqual(fingerprintPaths([d]), before, '同尺寸同 mtime 的内容改写必须被指纹发现');
  rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

await test('票据带着 reviewId 与覆盖路径往返不丢', () => {
  const d = mkdtempSync(join(tmpdir(), 'tandem-ticket-'));
  const tickets = {};
  const taskId = newTaskId();
  openTicket(tickets, {
    taskId, dir: d, acceptance: 'x', reviewId: 'rv-abcdef0123456789', reviewPaths: [d],
  });
  saveTickets(d, tickets);
  const back = getTicket(loadTickets(d), taskId);
  assert.equal(back.reviewId, 'rv-abcdef0123456789');
  assert.deepEqual(back.reviewPaths, [d]);
  rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

await test('没给 reviewId 的票据是 null，不会伪造成 undefined 字段', () => {
  const tickets = {};
  const taskId = newTaskId();
  openTicket(tickets, { taskId, dir, acceptance: 'x' });
  assert.equal(tickets[taskId].reviewId, null);
  assert.deepEqual(tickets[taskId].reviewPaths, []);
});

let failed = 0;
for (const [name, ok, error] of results) {
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ' — ' + error}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
process.exit(failed ? 1 : 0);
