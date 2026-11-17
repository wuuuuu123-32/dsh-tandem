// 固定环节闸（design / delivery 各一次）的验收 —— 替代旧的「返工轮计数」那套。
//
// 用户要求（2026-11-17，两句话合并成这个机制）：
//   「限制为一轮对话只能审两次或者说固定两个环节会审」
//   「这个固定环节可以是，设计完成动手前和动手完成交付前」
//
// 为什么必须换掉旧机制：旧机制按「会话 + 返工轮」计数，但它判断「上一次是不是 fail」
// 用的是会话内的历史记录；只要不改措辞就会一直卡在同一格，而我每轮改写问题就能……
// 其实旧机制被换掉的真原因是它**允许无限次「首审」之外的返工**（上限 5），
// 而且上限是数字，可以反复触碰。新机制把它变成**两个离散的格子**：
// design 用掉就没了，delivery 用掉就没了，判 fail 也不返还 —— 没有「再来一轮」这个概念。
//
// 这里测八件事：
//   A. design 一次、delivery 一次，各放行
//   B. 同一阶段第二次 → phase-used 拒绝，且**不再写账本**（不消耗对方那格）
//   C. phase 缺失 / 拼错 / 大小写混写 → bad-phase 拒绝，**不消耗任何额度**（改对再来）
//   D. 大小写与空白要容错（"Design"、" delivery " 都认）
//   E. fail 判定不返还额度（recordRework 之后仍是 phase-used）
//   F. 子代理不能拿新额度（链上任何一代用过就拒绝）
//   G. 账本损坏 → corrupt-state 拒绝（fail-closed，不能静默当成零次）
//   H. 旧格式（version 1 = 返工轮计数）→ 明确拒绝，不当成空账本
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

test('A. design 与 delivery 各放行一次', () => {
  const dir = sandbox();
  const chain = ['s:root1'];

  const d = round(dir, { chain, phase: 'design', question: 'q-design' });
  assert.equal(d.allowed, true, d.error);
  assert.equal(d.phase, 'design');

  const v = round(dir, { chain, phase: 'delivery', question: 'q-delivery' });
  assert.equal(v.allowed, true, v.error);
  assert.equal(v.phase, 'delivery');
  // 第二次领的时候，design 已经记在 used 里了
  assert.deepEqual([...v.used].sort(), ['delivery', 'design']);
});

test('B. 同一阶段第二次 → phase-used，且没消耗另一格', () => {
  const dir = sandbox();
  const chain = ['s:root2'];

  round(dir, { chain, phase: 'design', question: 'q1' });
  const again = claimRework(dir, { chain, phase: 'design', question: 'q2-改写了措辞' });
  assert.equal(again.allowed, false);
  assert.equal(again.reason, 'phase-used');
  assert.match(again.error, /design/);
  // ❗改写 question 换不来新额度（旧机制的漏洞正是这一点）
  // 而且 delivery 那格还在
  const v = claimRework(dir, { chain, phase: 'delivery', question: 'q3' });
  assert.equal(v.allowed, true, v.error);
});

test('C. phase 缺失/拼错 → bad-phase，且不消耗额度', () => {
  const dir = sandbox();
  const chain = ['s:root3'];

  for (const bad of [undefined, null, '', 'review', 'designs', 'deliver', 0, {}]) {
    const r = claimRework(dir, { chain, phase: bad, question: 'q' });
    assert.equal(r.allowed, false, 'phase=' + JSON.stringify(bad));
    assert.equal(r.reason, 'bad-phase', 'phase=' + JSON.stringify(bad));
    assert.deepEqual(r.used, [], 'phase=' + JSON.stringify(bad) + ' 不应消耗额度');
  }
  // 八次写错之后，两个格子都还在
  assert.equal(claimRework(dir, { chain, phase: 'design', question: 'q' }).allowed, true);
  assert.equal(claimRework(dir, { chain, phase: 'delivery', question: 'q' }).allowed, true);
});

test('D. 大小写与前后空白容错', () => {
  const dir = sandbox();
  assert.equal(claimRework(dir, { chain: ['s:root4'], phase: '  Design  ', question: 'q' }).allowed, true);
  assert.equal(claimRework(dir, { chain: ['s:root4'], phase: 'DELIVERY', question: 'q2' }).allowed, true);
});

test('E. fail 判定不返还额度', () => {
  const dir = sandbox();
  const chain = ['s:root5'];

  round(dir, { chain, phase: 'design', question: 'q-design', ok: false, verdicts: ['fail'] });
  const retry = claimRework(dir, { chain, phase: 'design', question: 'q-design-再问一次' });
  assert.equal(retry.allowed, false);
  assert.equal(retry.reason, 'phase-used');

  // unclear 一样不返还
  round(dir, { chain, phase: 'delivery', question: 'q-delivery', ok: true, verdicts: ['unclear'] });
  assert.equal(claimRework(dir, { chain, phase: 'delivery', question: 'q-delivery-again' }).reason, 'phase-used');
});

test('F. 子代理不能拿新额度（链上任何一代用过就拒绝）', () => {
  const dir = sandbox();
  // 根做了 design
  round(dir, { chain: ['s:root6'], phase: 'design', question: 'q-root' });

  // 子代理：链 ['s:child6', 's:root6']（叶子在前、根在后）
  const child = claimRework(dir, { chain: ['s:child6', 's:root6'], phase: 'design', question: 'q-child' });
  assert.equal(child.allowed, false, '子代理不能重新拿到 design');
  assert.equal(child.reason, 'phase-used');

  // 但子代理的 delivery 还没用过，应当放行（同一轮对话的第二个节点）
  const childV = claimRework(dir, { chain: ['s:child6', 's:root6'], phase: 'delivery', question: 'q-child-v' });
  assert.equal(childV.allowed, true, childV.error);

  // 反过来：子代理用了 delivery 之后，根也不能再用
  round(dir, { chain: ['s:child6b', 's:root6'], phase: 'delivery', question: 'q-childb-v' }).allowed;
  // 这条可能因为 delivery 已被上面用掉而拒绝，只断言「不出现 allowed=true 且拿的是新额度」
  const rootV = claimRework(dir, { chain: ['s:root6'], phase: 'delivery', question: 'q-root-v' });
  assert.equal(rootV.allowed, false, '根的 delivery 已被子代理占用');
});

test('G. 账本损坏 → corrupt-state（不能静默当成零次）', () => {
  const dir = sandbox();
  writeFileSync(reworkPath(dir), '{ 这不是 JSON', 'utf8');
  const r = claimRework(dir, { chain: ['s:root7'], phase: 'design', question: 'q' });
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
  const r = claimRework(dir, { chain: ['s:old'], phase: 'design', question: 'q' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'corrupt-state');
  assert.match(r.error, /version=1/);
});

test('I. 材料指纹：同输入同值、换问题换值、无 paths 返回空串', () => {
  // ❗这里**不测** same-as-last 那条拒绝分支，因为在新语义下它不可达：
  //   same-as-last 只在「同一会话、同一阶段」重复提交时才会命中，
  //   而那种情况一定先被 phase-used 拦住 —— 额度是离散的两格，没有第二次机会。
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
  round(dir, { chain: ['s:root10'], phase: 'design', question: 'q', verdicts: ['fail'] });
  const rows = reworkStatus(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rootSession, 'root10');
  assert.deepEqual(rows[0].used, ['design']);
  assert.deepEqual(rows[0].phases.design.verdicts, ['fail']);
  assert.match(rows[0].summary, /design/);
});

test('K. PHASES 常量与 DB_VERSION', () => {
  assert.deepEqual([...PHASES], ['design', 'delivery']);
  assert.equal(DB_VERSION, 2);
});
