#!/usr/bin/env node
// 会审历史统计：对比 portdan(gpt-6.1-sol) 与 aisz(gpt-6.1-terra) 两个后端的表现
//
// 用法: node scripts/consult-stats.mjs [--json]
//
// 口径说明（2026-10-28 双轨会审后的定论，别改回简单成功率）：
//  1) ok 只代表「调用成功 + 四段格式合规」，不代表判断正确。这里只报可用性，质量另由盲评给。
//  2) 老记录没有 provider 字段，那时的默认配置就是 portdan → 标为「推定 portdan」，
//     并同时输出「仅新记录」口径做敏感性比较，避免把时间混杂读成模型差异。
//  3) timeout 是撞调用方上限的右删失观测，不作为完成耗时的样本，单独计数。
//     成功样本的耗时会系统性排除最慢的请求，所以耗时同时给「成功样本」与「全部有限 ms 观测」两列，
//     并标明各自用了多少条样本。
//  4) 样本量小（每边 10 条上下），一条就能移动 10 个百分点 → 只报观测与区间，不排名次。
//  5) provider 字段出现未知值时单列为 other，不并进任何一侧（拼错或未来新增后端都不会被静默吞掉）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HISTORY = path.join(os.homedir(), '.dsh', 'tandem-state', 'consult-history.jsonl');

// Wilson 95% 区间：小样本下比正态近似稳；k=n 时上界正好为 1
export function wilson(k, n) {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

function quantile(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
}

// Fisher 精确检验（双侧，按「概率不大于观测表概率」求和）。
// 已用 [[11,0],[9,1]] 核对：观测表概率 10/21=0.4762 为最小，故 p=0.4762。
export function fisher(a, b, c, d) {
  const n = a + b + c + d;
  const r1 = a + b, r2 = c + d, c1 = a + c;
  const lf = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) lf[i] = lf[i - 1] + Math.log(i);
  const p = x => Math.exp(lf[r1] + lf[r2] + lf[c1] + lf[n - c1] - lf[n] - lf[x] - lf[r1 - x] - lf[c1 - x] - lf[r2 - c1 + x]);
  const lo = Math.max(0, c1 - r2), hi = Math.min(r1, c1);
  const pObs = p(a);
  let sum = 0;
  for (let x = lo; x <= hi; x++) { const px = p(x); if (px <= pObs * (1 + 1e-9)) sum += px; }
  return Math.min(1, sum);
}

export function loadHistory(file = HISTORY) {
  const raw = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return raw.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function bucket(rec) {
  const p = rec.provider;
  if (p === 'aisz') return 'aisz';
  if (p === 'portdan') return 'portdan';
  if (p === 'default') return 'portdan';        // default = 沿用全局配置 = portdan
  if (p === undefined || p === null || p === '') return 'legacy';  // 老记录，推定 portdan
  return 'other';                                // 未知值：单列，不并入任何一侧
}

function summarize(rows) {
  const n = rows.length;
  const ok = rows.filter(r => r.ok).length;
  const byReason = {};
  for (const r of rows) if (!r.ok) byReason[r.reason || 'unknown'] = (byReason[r.reason || 'unknown'] || 0) + 1;
  const okMs = rows.filter(r => r.ok && Number.isFinite(r.ms)).map(r => r.ms);
  const allMs = rows.filter(r => Number.isFinite(r.ms)).map(r => r.ms);
  const at = rows.map(r => r.at).filter(Boolean).sort();
  return {
    n, ok, fail: n - ok, ci: wilson(ok, n), byReason,
    okMsN: okMs.length, okP50: quantile(okMs, .5), okP90: quantile(okMs, .9),
    allMsN: allMs.length, allP50: quantile(allMs, .5), allP90: quantile(allMs, .9),
    from: at[0] || null, to: at[at.length - 1] || null,
  };
}

export function report(rows) {
  const groups = { portdan: [], legacy: [], aisz: [], other: [] };
  for (const r of rows) groups[bucket(r)].push(r);
  const out = { all: {} };
  for (const [k, v] of Object.entries(groups)) out.all[k] = summarize(v);
  out.recent = {
    portdan: summarize(rows.filter(r => bucket(r) === 'portdan' && r.provider)),
    aisz: summarize(rows.filter(r => bucket(r) === 'aisz' && r.provider)),
  };
  out.mergedPortdan = summarize(groups.portdan.concat(groups.legacy));
  const rp = out.recent.portdan, ra = out.recent.aisz;
  out.test = { scope: '仅新记录', fisherP: fisher(rp.ok, rp.fail, ra.ok, ra.fail) };
  return out;
}

function fmtMs(v) { return v == null ? '-' : (v / 1000).toFixed(1) + 's'; }
function fmtDay(iso) { return iso ? iso.slice(0, 10) : '-'; }

function main() {
  const rows = loadHistory();
  const r = report(rows);
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 1)); return; }
  const table = (title, o) => {
    console.log('\n### ' + title);
    console.log('| 分组 | 请求 | 有效 | 有效率 | 95% 区间 | 失败构成 | 成功耗时 p50/p90 (n) | 全部有限 ms p50/p90 (n) | 时间范围 |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    for (const [k, s] of Object.entries(o)) {
      const reasons = Object.entries(s.byReason).map(([a, b]) => a + ':' + b).join(' ') || '-';
      console.log('| ' + k + ' | ' + s.n + ' | ' + s.ok + ' | ' + (100 * s.ok / Math.max(1, s.n)).toFixed(1) + '% | '
        + (100 * s.ci[0]).toFixed(0) + '-' + (100 * s.ci[1]).toFixed(0) + '% | ' + reasons + ' | '
        + fmtMs(s.okP50) + ' / ' + fmtMs(s.okP90) + ' (' + s.okMsN + ') | '
        + fmtMs(s.allP50) + ' / ' + fmtMs(s.allP90) + ' (' + s.allMsN + ') | '
        + fmtDay(s.from) + ' 到 ' + fmtDay(s.to) + ' |');
    }
  };
  console.log('总记录 ' + rows.length + ' 条');
  table('全量（legacy = 推定 portdan；other = 未知 provider，不并入）', r.all);
  table('合并口径（legacy 计入 portdan）', { portdan: r.mergedPortdan, aisz: r.all.aisz });
  table('仅新记录（带 provider 字段，排除时间混杂）', r.recent);
  console.log('\nFisher 精确检验（' + r.test.scope + '）p = ' + r.test.fisherP.toFixed(4) + '（双侧，按概率不大于观测表求和）');
  console.log('\n注意：ok 只表示「调用成功 + 四段格式合规」，不表示判断正确；');
  console.log('      timeout 是撞调用方上限的删失观测，不计入成功耗时，但仍在「全部有限 ms」列里、且不代表真实完成时间；');
  console.log('      样本量在 10 条上下时一条就能移动约 10 个百分点，只作观察不作排名。');
}

if (import.meta.url === 'file:///' + process.argv[1].replace(/\\/g, '/')) main();
