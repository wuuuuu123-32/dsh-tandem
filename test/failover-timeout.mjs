// 超时归因自测：超时必须记成 timeout，且不重试、不切换。
// 真上游一次要 20 到 50 秒，给 15 秒（最小值）必然超时 —— 这是唯一不需要进程桩就能触发的超时路径。
import { runConsult } from '../lib/consult.js';

const CODEX = 'C:/Users/123/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
const cfg = { codexCommand: CODEX, model: 'gpt-6.1-sol', stateDir: 'C:/Users/123/.dsh/tandem-state/_failover-timeout', workRoots: ['D:/dsh/work'], maxParallel: 3, taskTimeoutMs: 900000 };
// ❗两个都踩过（2026-10-28）：
// ① 同一个问题第二次问会命中上游缓存，15 秒内就答完 → 假阳性失败；
// ② 短问题本来就可能 10 秒内答完 → 同样证不出超时。
// 所以：随机编号防缓存 + 要求逐字复述长文本逼出长输出（15 秒答不完）。
const BODY = Array.from({ length: 240 }, (_, i) =>
  '第' + (i + 1) + '条：所有请求都应在 ' + (20 + (i % 7)) + ' 秒内返回，否则算失败；例外是批量导出与冷启动第一次调用。').join('');
const Q = '这是自动化测试用的自包含问题（编号 ' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) +
  '）。请先把下面这段材料逐字复述一遍（一个字都不能省、不能概括），再给出四段式回答：\n\n' + BODY;
const r = await runConsult({ mode: 'review', question: Q, config: cfg, failover: false, timeoutMs: 15000, deadlineMs: 60000 });
const got = { ok: r.ok, reason: r.reason, attempts: r.attempts, failoverFrom: r.failoverFrom, log: (r.attemptsLog || []).map(a => ({ p: a.provider, ok: a.ok, r: a.reason, t: a.timeoutMs })) };
const bad = [];
if (r.ok !== false) bad.push('不该成功');
if (r.reason !== 'timeout') bad.push('reason 应为 timeout（不是 unknown/code 退出）');
if (r.attempts !== 1) bad.push('超时不应重试，attempts 应为 1');
if ((r.failoverFrom || null) !== null) bad.push('failover:false 时不该记录切换');
console.log((bad.length ? 'FAIL ' : 'ok   ') + 'T_timeout_attribution ' + JSON.stringify(got) + (bad.length ? '  << ' + bad.join('; ') : ''));
console.log(bad.length ? 'TIMEOUT TEST FAILED' : 'TIMEOUT TEST PASS');
