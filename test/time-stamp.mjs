// 「时间显示带时区」的回归测试（2026-11-19，真实误判驱动）。
//
// 事故原样：会审拒绝文案里 `rec.at` 只换 'T'、截 16 字符，把 UTC 显示成
// 「2026-11-17 15:46」。我拿它比会话起点（本地 23:10），差七个多小时，于是判定
// 「额度在这次对话开始前就被用掉了」，还把插件当 bug 报给用户 —— 真实时间是本地
// 23:46，会话开始后 36 分钟，账没错。**一个不带时区标注的时间戳，任何读者都会按
// 本地时间理解**，所以这里把「必须能一眼看出时区」钉成断言。
//
// 测四件事：
//   A. localStamp 把 UTC 转本地并带 (UTC+8) 标注；实测那条骗到我的记录要变成 23:46
//   B. 认不出来的值必须给「明显不是时间」的占位，不能返回空串、也不能退回当前时间
//   C. phase-used / describeUsed / budget.describe 三条用户可见文案都必须带时区标注
//   D. 源码里不许再出现裸截断写法（防止有人改回去）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { localStamp, localClock, zoneLabel, parseTs } from '../lib/time.js';
import { claimRework, recordRework, reworkStatus } from '../lib/rework.js';
import { claimRound, recordRound } from '../lib/budget.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', 'lib');
const sandbox = () => mkdtempSync(join(tmpdir(), 'tandem-time-'));

// 事故里那两条记录（UTC）。断言按本地时区写会随机器变，所以这里只对「时区标注存在」
// 和「与 UTC 差多少」做判断，不硬编码 23:46（否则换台机器就红，那种测试会被关掉）。
const DESIGN_AT = '2026-11-17T15:46:46.852Z';
const DELIVERY_AT = '2026-11-17T18:28:38.818Z';

test('A. localStamp 转本地并带时区标注', () => {
  const s = localStamp(DESIGN_AT);
  assert.match(s, /^2026-11-\d\d \d\d:\d\d:\d\d \(UTC[+-][\d:]+\)$/, s);

  // 关键：显示出来的那个钟点必须等于「按本地时区解读这条 UTC」的结果，
  // 而不是把 UTC 的数字原样抄一遍（原 bug 就是抄了一遍）。
  const d = new Date(Date.parse(DESIGN_AT));
  const p = (n) => String(n).padStart(2, '0');
  const expectLocal = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  assert.ok(s.startsWith(expectLocal), '本地钟点应是 ' + expectLocal + '，实际 ' + s);

  // 东八区下必须能与裸 UTC 区分开（这就是当初读错的那一处）
  if (zoneLabel() === 'UTC+8') {
    assert.ok(!s.includes('15:46'), '不该再显示成裸 UTC 的 15:46：' + s);
    assert.ok(s.includes('23:46'), '东八区应显示 23:46：' + s);
  }

  assert.equal(localStamp(DESIGN_AT, { seconds: false }), localStamp(DESIGN_AT).slice(0, 16) + ' (' + zoneLabel() + ')');
  assert.equal(localStamp(DESIGN_AT, { zone: false }), localStamp(DESIGN_AT).slice(0, 19));
  assert.equal(localStamp(DELIVERY_AT).length > 20, true);
});

test('B. 认不出的值给「明显不是时间」的占位，不返回空、不假装是现在', () => {
  const nowStamp = localStamp(Date.now());
  for (const bad of ['', null, undefined, 'not-a-time', {}, []]) {
    const s = localStamp(bad);
    assert.ok(s.length > 0, '不能返回空串：' + JSON.stringify(bad));
    assert.match(s, /时间未知|时间无法解析/, '必须是显式占位，实际：' + s);
    assert.notEqual(s, nowStamp, '不能静默退回当前时间');
  }
  // 坏值要带上原文片段，便于排查
  assert.match(localStamp('2026-13-45T99:99:99Z'), /时间无法解析\(2026-13-45T99/);
  assert.equal(parseTs(''), null);
  assert.equal(parseTs(0), 0); // 0 是合法毫秒（1970），不能当「空」丢掉
  assert.equal(localClock('nope'), '--:--');
});

test('C. 三条用户可见文案都带时区标注', () => {
  const dir = sandbox();
  const chain = ['s:root-time'];
  const c1 = claimRework(dir, { chain, phase: 'design', question: 'q-time' });
  assert.equal(c1.allowed, true, c1.error);
  recordRework(dir, c1._ticket, { ok: false, verdicts: ['fail'], ms: 100 });

  // C1 phase-used 拒绝文案 —— 就是当初骗到我的那句
  const again = claimRework(dir, { chain, phase: 'design', question: 'q-time-again' });
  assert.equal(again.reason, 'phase-used');
  assert.match(again.error, /\(UTC[+-][\d:]+\)/, '拒绝文案必须标时区：' + again.error);

  // C2 tandem_status 里的 summary
  const rows = reworkStatus(dir);
  assert.equal(rows.length, 1);
  assert.match(rows[0].summary, /\(UTC[+-][\d:]+\)/, 'reworkStatus.summary 必须标时区：' + rows[0].summary);

  // C3 任务级预算的逐轮历史（budget.describe）
  const bdir = sandbox();
  const b = claimRound(bdir, 'k1');
  assert.equal(b.allowed, true);
  recordRound(bdir, 'k1', { ok: true, verdicts: ['pass'], ms: 10 });
  const b2 = claimRound(bdir, 'k1');
  assert.match(b2.historyText, /第1轮/, b2.historyText);
  assert.match(b2.historyText, /\(UTC[+-][\d:]+\)/, 'historyText 必须标时区：' + b2.historyText);
});

test('D. 源码里不许再有裸截断 UTC 的写法', () => {
  for (const f of ['rework.js', 'budget.js', 'time.js']) {
    const src = readFileSync(join(LIB, f), 'utf8');
    for (const [i, line] of src.split(/\r?\n/).entries()) {
      if (line.trimStart().startsWith('//')) continue; // 注释里引用旧写法是说明，不算违规
      assert.ok(!/replace\(\s*'T'\s*,\s*'\s*'\s*\)/.test(line),
        f + ':' + (i + 1) + ' 又出现了把 UTC 当本地显示的裸截断：' + line.trim());
    }
  }
});
