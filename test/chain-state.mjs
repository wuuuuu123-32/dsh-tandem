#!/usr/bin/env node
/**
 * 会审链的状态与预算回归（不联网、不起 Codex）。
 *
 * 钉住 2026-11-07 四轮复查出来的交错：
 *   a  预算不足时「认领了当天的资格却一个进程都没起」→ 资格必须还回去；
 *   a2 当天资格的认领必须是**一次原子创建**，不存在「谁都以为自己拿到了」的窗口；
 *   b  两个会审并发写状态，一个写日期、一个写冷却 → 不能互相覆盖、不能复活旧冷却；
 *   d  三阶段链里主端不能把预算吃光 —— 备用必须真的有机会被启动。
 */
import fs, { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runConsult, planStages, readProviderState, writeProviderState, claimPortdanDay, releasePortdanDay,
  markPortdanStarted, portdanDayPath, portdanDayUsed, portdanUsedPath, tfExhaustedPath, localDay,
} from '../lib/consult.js';

const cases = [];
const t = (name, actual, want) => cases.push({ name, actual, want });
const dirs = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'tandem-chain-')); dirs.push(d); return d; };
const cfg = d => ({ stateDir: d, workRoots: [d], codexCommand: 'no-such-codex.exe', model: 'x' });
const byProvider = (res, tag) => (res.attemptsLog || []).filter(a => a.provider === tag).length;

// ── b：拆文件后两个字段各写各的，不互相覆盖 ───────────────────────────────
{
  const d = mk();
  writeProviderState(d, { lastPortdanDay: localDay(), lastPortdanAt: 111 });
  writeProviderState(d, { tfExhaustedAt: 222, tfExhaustedReason: '没余额' });
  const s = readProviderState(d);
  t('b 先写当天记录再写冷却，当天记录还在', s.lastPortdanDay, localDay());
  t('b 冷却记录也在', s.tfExhaustedAt, 222);
  t('b 冷却原因落盘', s.tfExhaustedReason, '没余额');
  t('b 两个字段各在自己的文件里', existsSync(portdanUsedPath(d)) && existsSync(tfExhaustedPath(d)), true);
}
{
  const d = mk();
  writeProviderState(d, { tfExhaustedAt: 333 });
  writeProviderState(d, { lastPortdanDay: '2026-01-01' });
  const s = readProviderState(d);
  t('b 反序写也不丢冷却', s.tfExhaustedAt, 333);
  t('b 反序写也留下当天记录', s.lastPortdanDay, '2026-01-01');
}
{
  const d = mk();
  writeProviderState(d, { tfExhaustedAt: 444 });
  writeProviderState(d, { tfExhaustedAt: undefined });
  t('b 传 undefined 能清掉冷却', readProviderState(d).tfExhaustedAt, undefined);
}
{
  const d = mk();
  writeFileSync(join(d, 'provider-state.json'), JSON.stringify({ lastPortdanDay: '2026-02-02', tfExhaustedAt: 555 }));
  const s = readProviderState(d);
  t('b 旧单文件仍能读出当天记录', s.lastPortdanDay, '2026-02-02');
  t('b 旧单文件仍能读出冷却', s.tfExhaustedAt, 555);
}
{
  // b4：同文件的「读旧值 → 暂停 → 别人清掉 → 写回」不能复活冷却。
  const d = mk();
  writeProviderState(d, { tfExhaustedAt: 666, tfExhaustedReason: 'x' });
  writeProviderState(d, { tfExhaustedReason: '只改原因' });
  t('b4 只给原因时 at 归 null（不抄旧值）', readProviderState(d).tfExhaustedAt, undefined);
}

// ── a：预算不足、一个进程都没起 → 当天资格要还回去 ─────────────────────────
{
  const d = mk();
  const stages = planStages(d, {});
  t('a 首次链第一家是 portdan', stages[0].tag, 'portdan');
  t('a 认领后当天文件在磁盘上', existsSync(portdanDayPath(d, localDay())), true);
  t('a 认领后 portdanDayUsed 为真', portdanDayUsed(d), true);
  rmSync(portdanDayPath(d, localDay()), { force: true });
}
{
  // 60s 预算下三家都该被跳过（预留吃满），一个进程都不起，资格必须归还。
  const d = mk();
  const res = await runConsult({ mode: 'review', question: 'x', config: cfg(d), deadlineMs: 60000 });
  t('a 预算不足时直接收手', res.stoppedBy, 'budget');
  t('a 主端一次都没起', byProvider(res, 'portdan'), 0);
  t('a 认领过又归还，结束时当天文件不在', existsSync(portdanDayPath(d, localDay())), false);
}
{
  const d = mk();
  planStages(d, {});
  const res = await runConsult({ mode: 'review', question: 'x', config: cfg(d), deadlineMs: 60000 });
  t('a 别人持锁时本次也收手', res.stoppedBy, 'budget');
  t('a 不会误删别人的资格', existsSync(portdanDayPath(d, localDay())), true);
}
{
  const d = mk();
  writeProviderState(d, { lastPortdanDay: localDay() });
  const res = await runConsult({ mode: 'review', question: 'x', config: cfg(d), deadlineMs: 60000 });
  t('a 非首次时预算不足也收手', res.stoppedBy, 'budget');
  t('a 非首次不会凭空造出当天文件', existsSync(portdanDayPath(d, localDay())), false);
}

// ── d：预留按剩余阶段数放大，主端不能再把预算吃干 ─────────────────────────
{
  const d = mk();
  // 180s 预算 + 三阶段：主端要留 180s、第二家要留 90s，两家都轮不上，
  // 剩下的预算全部交给 aisz —— 这正是 d4 要的行为（备用真的被启动）。
  const res = await runConsult({ mode: 'review', question: 'x', config: cfg(d), deadlineMs: 180000 });
  // 算一遍：left≈177s；主端 reserve=180s → 跳过；第二家 reserve=90s → 177-90=87s ≥15s，启动。
  // 旧实现主端 reserve 只有 90s，会自己吃掉 87s 再失败，第二家一次都起不来（会审 d4）。
  t('d 三阶段链在 180s 预算下主端不启动', byProvider(res, 'portdan'), 0);
  t('d 预算真的留给了第二家', byProvider(res, 'tokenfuture'), 1);
  t('d 只启动了一家', (res.attemptsLog || []).length, 1);
}

// ── e：预算跳过不会死循环（能返回就是证明） ────────────────────────────────
{
  const d = mk();
  const res = await runConsult({ mode: 'review', question: 'x', config: cfg(d), deadlineMs: 60000, failover: false });
  t('e failover:false 且预算不足时也能正常返回', typeof res.ok, 'boolean');
}

// ── a2：认领是一次原子创建，没有「读到旧状态再动手」的窗口 ───────────────
{
  const d = mk();
  mkdirSync(d, { recursive: true });
  const file = portdanDayPath(d, localDay());
  writeFileSync(file, JSON.stringify({ pid: 999999, at: Date.now() }));
  t('a2 当天已被别人认领 → 不再认领', claimPortdanDay(d, localDay()), false);
  t('a2 未标 started 的认领可以归还', releasePortdanDay(d, localDay()), true);
  t('a2 归还后文件消失', existsSync(file), false);
}
{
  const d = mk();
  t('a2 自己的认领成功', claimPortdanDay(d, localDay()), true);
  t('a2 归还成功', releasePortdanDay(d, localDay()), true);
  t('a2 归还后文件消失', existsSync(portdanDayPath(d, localDay())), false);
}
{
  const d = mk();
  claimPortdanDay(d, localDay());
  markPortdanStarted(d, localDay());
  t('a2 标记 started 后文件里 started 为真', JSON.parse(fs.readFileSync(portdanDayPath(d, localDay()), 'utf8')).started, true);
  t('a2 已经真跑过就不许归还', releasePortdanDay(d, localDay()), false);
  t('a2 文件还在', existsSync(portdanDayPath(d, localDay())), true);
}
{
  const d = mk();
  const a = claimPortdanDay(d, localDay());
  const b = claimPortdanDay(d, localDay());
  t('a2 同时认领只有一个成功', [a, b], [true, false]);
}

// ── a4：跨午夜时，释放「昨天」的认领不能删掉「今天」那份 ─────────────────
{
  const d = mk();
  const yesterday = '2026-01-01';
  claimPortdanDay(d, yesterday);
  claimPortdanDay(d, localDay());
  t('a4 释放昨天的认领', releasePortdanDay(d, yesterday), true);
  t('a4 今天那份不受影响', existsSync(portdanDayPath(d, localDay())), true);
  t('a4 昨天的文件已删', existsSync(portdanDayPath(d, yesterday)), false);
}
{
  const d = mk();
  const yesterday = '2026-01-02';
  claimPortdanDay(d, yesterday);
  markPortdanStarted(d, yesterday);
  t('a4 标记也按传入的日期走（不动今天）', existsSync(portdanDayPath(d, localDay())), false);
}

// ── b2：显式清除冷却后，旧单文件不能把它复活 ───────────────────────────────
{
  const d = mk();
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'provider-state.json'), JSON.stringify({ tfExhaustedAt: 777 }));
  writeProviderState(d, { tfExhaustedAt: undefined });
  t('b2 新文件存在时旧文件的冷却不再复活', readProviderState(d).tfExhaustedAt, undefined);
}

// ── a3：当天已经用过 portdan 时，绝不再认领（否则「每天两次首选」） ──────────
{
  const d = mk();
  writeProviderState(d, { lastPortdanDay: localDay() });
  const stages = planStages(d, {});
  t('a3 当天已用过 → 不再是 portdan 打头', stages[0].tag, 'tokenfuture');
  t('a3 当天已用过 → 不产生认领文件', existsSync(portdanDayPath(d, localDay())), false);
}

let fails = 0;
for (const c of cases) {
  const ok = JSON.stringify(c.actual) === JSON.stringify(c.want);
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + c.name + (ok ? '' : '  期望=' + JSON.stringify(c.want) + ' 实际=' + JSON.stringify(c.actual)));
}
console.log((cases.length - fails) + '/' + cases.length);
for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
process.exit(fails ? 1 : 0);
