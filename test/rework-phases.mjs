// 固定环节闸（design / delivery，各一轮一次）的验收 —— 替代旧的「返工轮计数」那套。
//
// 用户要求（2026-11-17，两句话合并成这个机制）：
//   「限制为一轮对话只能审两次或者说固定两个环节会审」
//   「这个固定环节可以是，设计完成动手前和动手完成交付前」
//
// ❗2026-11-19 用户纠正了「一轮对话」的口径，原话：
//   「我图一的意思是一轮对话两个额度啊，不是本会话两个额度！你还说你改好了」
//   即「一轮对话」= 一个 turn（用户发一句话 → 我干一轮活），不是整个 Session。
//   turn 号来自内核 `ctx.agents.turnBoundaryOf(session).lastTurn`（见 index.js 的 turnOf）。
//   v0.9.3 之前按「根会话」记账，导致一个跨几十轮的会话总共只给两格 —— 那正是被纠正的错。
//
// 为什么必须换掉最早那套：旧机制按「会话 + 返工轮」计数，但它判断「上一次是不是 fail」
// 用的是会话内的历史记录；只要不改措辞就会一直卡在同一格，而改写措辞就能绕过。
// 真原因是它**允许无限次「首审」之外的返工**（上限 5），而且上限是数字，可以反复触碰。
// 固定环节闸把它变成**每轮两个离散的格子**：design 用掉就没了，delivery 用掉就没了，
// 判 fail 也不返还 —— 没有「再来一轮」这个概念；但下一轮对话自动重新给两格。
//
// 这里测十二件事：
//   A. 同一轮里 design 一次、delivery 一次，各放行
//   B. 同一轮同一阶段第二次 → phase-used 拒绝，且**不消耗对方那格**
//   C. phase 缺失 / 拼错 / 大小写混写 → bad-phase 拒绝，**不消耗任何额度**
//   D. 大小写与空白要容错（"Design"、" delivery " 都认）
//   E. fail 判定不返还额度（recordRework 之后仍是 phase-used）
//   F. 子代理不能拿新额度（同一轮、链上任何一代用过就拒绝）
//   G. 账本损坏 → corrupt-state 拒绝（fail-closed，不能静默当成零次）
//   H. 旧格式（version 1 = 返工轮计数）→ 明确拒绝，不当成空账本
//   I. 材料指纹（只测函数本身，见用例里的说明）
//   J. reworkStatus 能读出阶段使用情况
//   K. PHASES 常量与 DB_VERSION
//   L. **不同 turn 各自两格**（用户要的那条，2026-11-19）
//   M. **v2 账本自动迁移到 v3**（老记录改名成 `#t?` 保留，不被静默清空）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claimRework,
  recordRework,
  reworkStatus,
  reworkPath,
  identityOf,
  PHASES,
  DB_VERSION,
  materialFingerprint,
} from '../lib/rework.js';

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'tandem-phases-'));
}

/** 一次「完整的会审」：领格 → 记录判定。返回 claim 结果。 */
function round(stateDir, opts) {
  const c = claimRework(stateDir, opts);
  if (c.allowed) recordRework(stateDir, c._ticket, { ok: opts.ok !== false, verdicts: opts.verdicts || ['pass'], ms: 100 });
  return c;
}

test('A. 同一轮里 design 与 delivery 各放行一次', () => {
  const dir = sandbox();
  const chain = ['s:root1'];

  const d = round(dir, { chain, turn: 7, phase: 'design', question: 'q-design' });
  assert.equal(d.allowed, true, d.error);
  assert.equal(d.phase, 'design');
  assert.equal(d.turn, 7);

  const v = round(dir, { chain, turn: 7, phase: 'delivery', question: 'q-delivery' });
  assert.equal(v.allowed, true, v.error);
  assert.equal(v.phase, 'delivery');
  // 第二次领的时候，design 已经记在 used 里了
  assert.deepEqual([...v.used].sort(), ['delivery', 'design']);
});

test('B. 同一轮同一阶段第二次 → phase-used，且没消耗另一格', () => {
  const dir = sandbox();
  const chain = ['s:root2'];

  round(dir, { chain, turn: 7, phase: 'design', question: 'q1' });
  const again = claimRework(dir, { chain, turn: 7, phase: 'design', question: 'q2-改写了措辞' });
  assert.equal(again.allowed, false);
  assert.equal(again.reason, 'phase-used');
  assert.match(again.error, /design/);
  // ❗改写 question 换不来新额度（旧机制的漏洞正是这一点）
  // 而且 delivery 那格还在
  const v = claimRework(dir, { chain, turn: 7, phase: 'delivery', question: 'q3' });
  assert.equal(v.allowed, true, v.error);
});

test('C. phase 缺失/拼错 → bad-phase，且不消耗额度', () => {
  const dir = sandbox();
  const chain = ['s:root3'];

  for (const bad of [undefined, null, '', 'review', 'designs', 'deliver', 0, {}]) {
    const r = claimRework(dir, { chain, turn: 3, phase: bad, question: 'q' });
    assert.equal(r.allowed, false, 'phase=' + JSON.stringify(bad));
    assert.equal(r.reason, 'bad-phase', 'phase=' + JSON.stringify(bad));
    assert.deepEqual(r.used, [], 'phase=' + JSON.stringify(bad) + ' 不应消耗额度');
  }
  // 八次写错之后，两个格子都还在
  assert.equal(claimRework(dir, { chain, turn: 3, phase: 'design', question: 'q' }).allowed, true);
  assert.equal(claimRework(dir, { chain, turn: 3, phase: 'delivery', question: 'q' }).allowed, true);
});

test('D. 大小写与前后空白容错', () => {
  const dir = sandbox();
  assert.equal(claimRework(dir, { chain: ['s:root4'], turn: 2, phase: '  Design  ', question: 'q' }).allowed, true);
  assert.equal(claimRework(dir, { chain: ['s:root4'], turn: 2, phase: 'DELIVERY', question: 'q2' }).allowed, true);
});

test('E. fail 判定不返还额度', () => {
  const dir = sandbox();
  const chain = ['s:root5'];

  round(dir, { chain, turn: 5, phase: 'design', question: 'q-design', ok: false, verdicts: ['fail'] });
  const retry = claimRework(dir, { chain, turn: 5, phase: 'design', question: 'q-design-再问一次' });
  assert.equal(retry.allowed, false);
  assert.equal(retry.reason, 'phase-used');

  // unclear 一样不返还
  round(dir, { chain, turn: 5, phase: 'delivery', question: 'q-delivery', ok: true, verdicts: ['unclear'] });
  assert.equal(claimRework(dir, { chain, turn: 5, phase: 'delivery', question: 'q-delivery-again' }).reason, 'phase-used');
});

test('F. 子代理不能拿新额度（同一轮、链上任何一代用过就拒绝）', () => {
  const dir = sandbox();
  // 根在第 9 轮做了 design
  round(dir, { chain: ['s:root6'], turn: 9, phase: 'design', question: 'q-root' });

  // 子代理：链 ['s:child6', 's:root6']（叶子在前、根在后），turn 沿用根那一轮
  const child = claimRework(dir, { chain: ['s:child6', 's:root6'], turn: 9, phase: 'design', question: 'q-child' });
  assert.equal(child.allowed, false, '子代理不能在同一轮重新拿到 design');
  assert.equal(child.reason, 'phase-used');

  // 但子代理的 delivery 还没用过，应当放行（同一轮对话的第二个节点）
  const childV = claimRework(dir, { chain: ['s:child6', 's:root6'], turn: 9, phase: 'delivery', question: 'q-child-v' });
  assert.equal(childV.allowed, true, childV.error);

  // 反过来：子代理用了 delivery 之后，根也不能在同一轮再用
  round(dir, { chain: ['s:child6b', 's:root6'], turn: 9, phase: 'delivery', question: 'q-childb-v' }).allowed;
  const rootV = claimRework(dir, { chain: ['s:root6'], turn: 9, phase: 'delivery', question: 'q-root-v' });
  assert.equal(rootV.allowed, false, '根的 delivery 已被子代理在同一轮占用');
});

test('G. 账本损坏 → corrupt-state（不能静默当成零次）', () => {
  const dir = sandbox();
  writeFileSync(reworkPath(dir), '{ 这不是 JSON', 'utf8');
  const r = claimRework(dir, { chain: ['s:root7'], turn: 1, phase: 'design', question: 'q' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'corrupt-state');
  assert.match(r.error, /读不出来|不是合法 JSON/);
});

test('H. 旧格式（version 1）明确拒绝，不当成空账本', () => {
  const dir = sandbox();
  writeFileSync(reworkPath(dir), JSON.stringify({
    version: 1,
    sessions: { 's:old': { rounds: [{ at: '2026-11-17T00:00:00Z', rework: true, cost: 1, verdicts: ['fail'] }] } },
  }), 'utf8');
  const r = claimRework(dir, { chain: ['s:old'], turn: 1, phase: 'design', question: 'q' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'corrupt-state');
  assert.match(r.error, /version=1/);
});

test('I. 材料指纹：同输入同值、换问题换值、无 paths 返回空串', () => {
  // ❗这里**不测** same-as-last 那条拒绝分支，因为在「每轮两格」的语义下它几乎不可达：
  //   same-as-last 只在「同一轮、同一阶段」重复提交时才会命中，
  //   而那种情况一定先被 phase-used 拦住 —— 额度是离散的两格，同一轮没有第二次机会。
  //   保留那段代码是纵深防御（万一将来放宽成「每阶段多轮」它会立刻生效），
  //   但把它写成「一定拦得住」的测试是假的，所以只测指纹函数本身。
  const file = reworkPath(sandbox());
  writeFileSync(file, 'stable content', 'utf8');
  const base = { paths: [file], question: '同一个问题' };
  const fp1 = materialFingerprint(base);
  const fp2 = materialFingerprint({ ...base });
  const fp3 = materialFingerprint({ paths: [file], question: '换了措辞的问题' });

  assert.match(fp1, /^.+|q:/);
  assert.equal(fp1, fp2, '同输入必须同值');
  assert.notEqual(fp1, fp3, '换问题必须换值（否则同一格会被误判成重复提交）');
  assert.equal(materialFingerprint({ paths: [], question: 'q' }), '', '没材料就不伪造指纹');
});

test('J. reworkStatus 能读出两个阶段的使用情况', () => {
  const dir = sandbox();
  round(dir, { chain: ['s:root10'], turn: 4, phase: 'design', question: 'q', verdicts: ['fail'] });
  const rows = reworkStatus(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rootSession, 'root10');
  assert.equal(rows[0].turn, 4);
  assert.deepEqual(rows[0].used, ['design']);
  assert.deepEqual(rows[0].phases.design.verdicts, ['fail']);
  assert.match(rows[0].summary, /design/);
  // 摘要必须带轮次，否则同一根会话多行分不清
  assert.match(rows[0].summary, /第 4 轮/);
});

test('K. PHASES 常量与 DB_VERSION', () => {
  assert.deepEqual([...PHASES], ['design', 'delivery']);
  assert.equal(DB_VERSION, 3);
});

test('L. 不同 turn 各自两格（用户 2026-11-19 要的那条）', () => {
  const dir = sandbox();
  const chain = ['s:rootL'];

  // 第 10 轮：两格都用掉
  round(dir, { chain, turn: 10, phase: 'design', question: 'q-10d' });
  round(dir, { chain, turn: 10, phase: 'delivery', question: 'q-10v' });
  assert.equal(claimRework(dir, { chain, turn: 10, phase: 'design', question: 'q-10d2' }).reason, 'phase-used');
  assert.equal(claimRework(dir, { chain, turn: 10, phase: 'delivery', question: 'q-10v2' }).reason, 'phase-used');

  // 第 11 轮：重新有完整两格 —— 这正是「一轮对话两个额度」
  const d11 = round(dir, { chain, turn: 11, phase: 'design', question: 'q-11d' });
  assert.equal(d11.allowed, true, d11.error);
  const v11 = round(dir, { chain, turn: 11, phase: 'delivery', question: 'q-11v' });
  assert.equal(v11.allowed, true, v11.error);

  // 回到第 10 轮仍然是满的（不会因为第 11 轮用过就解锁）
  assert.equal(claimRework(dir, { chain, turn: 10, phase: 'design', question: 'q-10d3' }).reason, 'phase-used');

  // 键的形状：根会话 + #t<turn>
  assert.equal(identityOf({ chain, turn: 11 }).rootKey, 's:rootL#t11');
  assert.equal(identityOf({ chain, turn: 11 }).leafKey, 's:rootL#t11');
  // turn 拿不到 → 退化成 #t0，绝不退化成「不带后缀」（后者会与 v2 老键混淆、且语义不明）
  assert.equal(identityOf({ chain, turn: null }).rootKey, 's:rootL#t0');
  assert.equal(identityOf({ chain, turn: undefined }).rootKey, 's:rootL#t0');
  assert.equal(identityOf({ chain, turn: -1 }).rootKey, 's:rootL#t0');
  assert.equal(identityOf({ chain, turn: 1.5 }).rootKey, 's:rootL#t0');

  // 账本里应该有三条记录（#t10、#t11 各一条；#t10 被写过两次但只有一条）
  const rows = reworkStatus(dir);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.turn).sort((a, b) => a - b), [10, 11]);
});

test('M. v2 账本自动迁移到 v3（老记录改名 #t? 保留，不被静默清空）', () => {
  const dir = sandbox();
  // v2 的形状：键是 s:<根会话>，没有 #t 后缀
  const v2 = {
    version: 2,
    sessions: {
      's:legacy1': {
        phases: { design: { at: '2026-11-17T15:46:46.852Z', ok: null, pending: false, verdicts: [] } },
        rounds: [],
        rootSession: 'legacy1',
        chain: ['legacy1'],
        updatedAt: '2026-11-17T15:46:46.852Z',
      },
    },
  };
  writeFileSync(reworkPath(dir), JSON.stringify(v2, null, 2), 'utf8');

  // 迁移是读的时候发生的：reworkStatus 能读出来，且带 #t? 后缀
  const rows = reworkStatus(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 's:legacy1#t?');
  assert.deepEqual(rows[0].used, ['design']);

  // 迁移后仍然能正常领新额度（按真实 turn 的键是干净的）
  const fresh = round(dir, { chain: ['s:legacy1'], turn: 12, phase: 'design', question: 'q-new' });
  assert.equal(fresh.allowed, true, fresh.error);

  // 落盘的 version 已经是 3（下一次写账本时写的）—— 用 claim 触发一次写
  const raw = JSON.parse(readFileSync(reworkPath(dir), 'utf8'));
  assert.equal(raw.version, 3);
  // 老键还在（改名成 #t?），没有被删
  assert.ok(raw.sessions['s:legacy1#t?'], '老记录必须保留，只是改名');
  assert.deepEqual(Object.keys(raw.sessions['s:legacy1#t?'].phases), ['design']);
  // 新键也写进去了
  assert.ok(raw.sessions['s:legacy1#t12'], '新轮次的键必须存在');
});