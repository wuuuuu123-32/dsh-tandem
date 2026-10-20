/**
 * 自动求援自检：在真实会话轨迹上跑一遍统计与判据，再用手工构造的会话验触发/交付/冷却。
 * 跑法：node test/rescue.test.mjs
 */

import { readFileSync } from 'node:fs';
import { survey, createRescue, formatAnswer, anomalyOf, textOf } from '../lib/rescue.js';

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`);
  }
}

/* ------------------------- 1. 真实会话：统计是否合理 ------------------------ */

const SAMPLE = 'C:/Users/123/AppData/Local/Temp/dsh-GfiFZe/apk.session.jsonl';
let events = [];
try {
  for (const line of readFileSync(SAMPLE, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      events.push(JSON.parse(s));
    } catch {}
  }
} catch {
  console.log('（样例会话不存在，跳过真实样本检查）');
}

if (events.length) {
  const sv = survey(events);
  console.log(
    `\n真实样本：事件 ${events.length}，自最后用户消息以来 ${sv.callsSinceUser} 次调用，` +
      `异常 ${sv.anomCount} 次（最长连续 ${sv.anomMax}），turnOpen=${sv.turnOpen}，轨迹 ${sv.trace.length} 步`
  );
  console.log('  目标片段：' + (sv.goal || '').slice(0, 60).replace(/\n/g, ' '));
  check('轨迹截断到 30 步', sv.trace.length <= 30);
  const all = survey(events, false);
  check('全量调用数 >= 100', all.callsTotal > 100, String(all.callsTotal));
  check('按用户消息切分生效（sinceUser <= total）', sv.callsSinceUser <= all.callsTotal);
  check('连续异常段 < 3（证明该判据在本样本不响）', sv.anomMax < 3, String(sv.anomMax));
  check('取到了用户目标', sv.goal.length > 0);
  check('最后一条用户消息是真实用户（不是 runtime-context）', sv.lastUserAt > 0);
  check('轨迹里有异常标记', sv.trace.some((x) => x.anom));
}

check('anomalyOf 认非零退出', anomalyOf('x\n[exit code: 1]\n') === 'exit');
check('anomalyOf 认 traceback', anomalyOf('Traceback (most recent call last):') === 'traceback');
check('anomalyOf 不误判正常输出', anomalyOf('total 50703\ndrwxr-xr-x 1 123') === '');
check('textOf 取块数组', textOf([{ type: 'text', text: 'ab' }, { type: 'image' }]) === 'ab');

/* --------------------------- 2. 手工会话：判据 --------------------------- */

const MIN = 60000;

function mkSession({ calls = 0, userAgoMin = 30, anomRun = 0, turnEnded = false, id = 'sess-1' }) {
  const now = Date.now();
  const evs = [];
  let seq = 0;
  const t0 = now - userAgoMin * MIN;
  evs.push({
    type: 'user/message',
    seq: seq++,
    time: t0,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把那个 APK 的 lua 明文拿出来' }] },
  });
  evs.push({ type: 'turn/start', seq: seq++, time: t0, data: { turn: 1 } });
  for (let i = 0; i < calls; i++) {
    const cid = 'c' + i;
    const at = t0 + i * 1000;
    evs.push({ type: 'tool/call', seq: seq++, time: at, data: { turn: 1, step: i, callId: cid, name: 'ops_bash', arguments: JSON.stringify({ command: 'adb shell ls /data/' + i }) } });
    const bad = anomRun > 0 && i >= calls - anomRun;
    evs.push({
      type: 'tool/result',
      seq: seq++,
      time: at + 10,
      data: { turn: 1, step: i, toolCallId: cid, message: { role: 'tool', content: [{ type: 'text', text: bad ? '[exit code: 1]\nPermission denied' : 'ok' }] } },
    });
  }
  if (turnEnded) evs.push({ type: 'turn/end', seq: seq++, time: now, data: { turn: 1 } });
  return { id, events: evs };
}

const CFG = {
  autoRescue: true,
  rescueAfterCalls: 15,
  rescueAfterMin: 10,
  rescueCooldownMin: 20,
  rescueMaxPerSession: 3,
  rescueTimeoutMs: 30000,
  rescueTtlMin: 30,
};

function mkRun(impl) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return impl ? impl(args) : { ok: true, answer: { conclusion: 'NO_STUCK 它在正常推进', evidence: ['x'], counterexamples: ['y'], verification: ['z'] } };
  };
  fn.calls = calls;
  return fn;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

{
  // 14 次调用：不够格
  const run = mkRun();
  const r = createRescue({ config: CFG, run });
  const s = mkSession({ calls: 14 });
  for (let i = 0; i < 3; i++) {
    const text = r.observe(s);
    check(`第 ${i + 1} 次 observe 不注入`, text === null);
  }
  check('14 次调用未触发求援', run.calls.length === 0);
}

{
  // 15 次调用 + 30 分钟没用户消息：第 15 次触发，下一次 observe 交付
  const run = mkRun();
  const r = createRescue({ config: CFG, run });
  const s = mkSession({ calls: 15 });
  const first = r.observe(s);
  check('触发当轮就给即时提示', /已把最近/.test(String(first)), String(first).slice(0, 40));
  check('即时提示标明自动求援', /自动求援/.test(String(first)));
  check('当轮不注入结论（还没回来）', !/不是用户说话/.test(String(first)));
  await sleep(5);
  check('已发出求援', run.calls.length === 1, String(run.calls.length));
  const q = run.calls[0] || {};
  check('求援 mode=review', q.mode === 'review');
  check('材料含用户目标', String(q.context).includes('APK'));
  check('材料含统计行', String(q.context).includes('自最后一条用户消息以来'));
  check('无异常时不带异常标记', !String(q.context).includes('⚠️'));
  const second = r.observe(s);
  check('之后 observe 注入结论', typeof second === 'string' && second.length > 0);
  check('注入明写「不是用户说话」', /不是用户说话/.test(String(second)));
  check('NO_STUCK 走轻量分支', /仍在正常推进/.test(String(second)));
  check('交付后 pending 清空', r._states.get('sess-1').pending === null);
}

{
  // 卡住结论：四段都要出现在注入文本里
  const ans = {
    conclusion: '卡在第 8 到 12 步：一直换 adb 命令但没换假设',
    evidence: ['第 9 步失败后只是重试同类命令'],
    counterexamples: ['「需要 root」这个前提没有验证过'],
    verification: ['先跑 adb shell id 确认 uid', '看 /proc/1/status 的 CapEff'],
  };
  const run = mkRun(async () => ({ ok: true, answer: ans }));
  const r = createRescue({ config: CFG, run });
  const s = mkSession({ calls: 20 });
  r.observe(s);
  await sleep(5);
  const text = r.observe(s);
  check('注入含结论', String(text).includes(ans.conclusion));
  check('注入含建议方向', String(text).includes('adb shell id'));
  check('注入含反例', String(text).includes('需要 root'));
  check('注入允许忽略', /直接忽略/.test(String(text)));
}

{
  // 失败：也要注入，但必须是「没拿到结论」
  const run = mkRun(async () => ({ ok: false, reason: 'timeout', hint: '稍后再试' }));
  const r = createRescue({ config: CFG, run });
  const s = mkSession({ calls: 20 });
  r.observe(s);
  await sleep(5);
  const text = r.observe(s);
  check('失败也注入', typeof text === 'string' && text.length > 0);
  check('失败文案含 reason', String(text).includes('timeout'));
  check('失败文案说明未获复核', /没有拿到结论/.test(String(text)));
}

{
  // turn 已结束（在等用户）：不打扰
  const run = mkRun();
  const r = createRescue({ config: CFG, run });
  const s = mkSession({ calls: 30, turnEnded: true });
  for (let i = 0; i < 5; i++) r.observe(s);
  await sleep(5);
  check('等用户时不触发', run.calls.length === 0);
}

{
  // 冷却：一次问完，紧接着不该再问
  const run = mkRun();
  const r = createRescue({ config: CFG, run });
  const s = mkSession({ calls: 20 });
  r.observe(s); // 触发 + 当轮给出即时提示
  await sleep(5);
  for (let i = 0; i < 20; i++) {
    s.events.push({ type: 'tool/call', seq: 900 + i, time: Date.now(), data: { turn: 1, callId: 'z' + i, name: 'ops_bash', arguments: '{}' } });
    s.events.push({ type: 'tool/result', seq: 950 + i, time: Date.now(), data: { turn: 1, toolCallId: 'z' + i, message: { content: [{ type: 'text', text: 'ok' }] } } });
    r.observe(s);
  }
  await sleep(5);
  check('冷却期内不重复求援', run.calls.length === 1, String(run.calls.length));
}

{
  // 加速因子：连续 3 次异常，但调用数不够 —— 不触发（会审要求：不能单点触发）
  const run = mkRun();
  const r = createRescue({ config: CFG, run });
  const s = mkSession({ calls: 6, anomRun: 3 });
  for (let i = 0; i < 3; i++) r.observe(s);
  await sleep(5);
  check('异常因子不能独立触发', run.calls.length === 0, String(run.calls.length));
}

{
  // 加速因子 + 主判据同时成立 —— 触发，且理由里写明异常
  const run = mkRun();
  const r = createRescue({ config: CFG, run });
  const s = mkSession({ calls: 16, anomRun: 3 });
  r.observe(s);
  await sleep(5);
  check('异常因子叠加主判据后触发', run.calls.length === 1);
  const text = String(r._states.get('sess-1').pending?.text || '');
  check('触发原因写明连续异常', /连续 3 次异常/.test(text), text.slice(0, 80));
}

{
  // TTL：结论放太久就不交付
  const run = mkRun();
  const r = createRescue({ config: CFG, run });
  const s = mkSession({ calls: 20 });
  r.observe(s);
  await sleep(5);
  const st = r._states.get('sess-1');
  st.pending.at = Date.now() - 31 * MIN;
  const text = r.observe(s);
  check('过期结论不注入', text === null);
  check('过期后 pending 被丢弃', st.pending === null);
}

{
  // 会审回归 1：同一次求援只给一条「已发出求援」，不能每次 observe 都再喊一遍。
  const run = mkRun();
  const r = createRescue({ config: CFG, run });
  const s = mkSession({ calls: 20 });
  const a1 = r.observe(s);
  const a2 = r.observe(s);
  const a3 = r.observe(s);
  check('即时提示只出现一次', /已把最近/.test(String(a1)) && !/已把最近/.test(String(a2)) && !/已把最近/.test(String(a3)));
}

{
  // 会审回归 2：用户消息滑出回看窗口时，沉默下界取窗口起点，不能当成「无限久」。
  const now = Date.now();
  const evs = [{ type: 'turn/start', time: now - 30 * MIN, data: { turn: 1 } }];
  for (let i = 0; i < 20; i++) {
    evs.push({ type: 'tool/call', time: now - 30 * MIN + i * 1000, data: { turn: 1, callId: 'c' + i, name: 'ops_bash', arguments: '{"command":"ls"}' } });
    evs.push({ type: 'tool/result', time: now - 30 * MIN + i * 1000 + 5, data: { turn: 1, toolCallId: 'c' + i, message: { content: [{ type: 'text', text: 'ok' }] } } });
  }
  check('没有用户消息时沉默下界取自窗口起点', survey(evs).lastUserAt === now - 30 * MIN);

  // 反过来：才开 2 分钟的会话，同样没有用户消息 —— 不许触发（否则新会话第一批调用就被问）。
  const fresh = [{ type: 'turn/start', time: now - 2 * MIN, data: { turn: 1 } }];
  for (let i = 0; i < 20; i++) {
    fresh.push({ type: 'tool/call', time: now - 2 * MIN + i * 1000, data: { turn: 1, callId: 'd' + i, name: 'ops_bash', arguments: '{"command":"ls"}' } });
    fresh.push({ type: 'tool/result', time: now - 2 * MIN + i * 1000 + 5, data: { turn: 1, toolCallId: 'd' + i, message: { content: [{ type: 'text', text: 'ok' }] } } });
  }
  const run2 = mkRun();
  const r2 = createRescue({ config: CFG, run: run2 });
  r2.observe({ id: 'sess-fresh', events: fresh });
  await sleep(5);
  check('刚开 2 分钟、没有用户消息的会话不触发', run2.calls.length === 0, String(run2.calls.length));
}

{
  // 会审回归 3：状态回收把触发过的会话删掉 = 每会话上限归零，2 小时后又能再问一遍。
  const run = mkRun();
  const r = createRescue({ config: { ...CFG, rescueMaxPerSession: 1 }, run });
  const s = mkSession({ calls: 20 });
  r.observe(s);
  await sleep(5);
  const st = r._states.get('sess-1');
  check('已触发过一次', st.fired === 1, String(st.fired));
  st.lastSeenAt = Date.now() - 3 * 60 * MIN;
  r.tick();
  check('触发过的会话状态不被回收（否则上限归零）', r._states.has('sess-1'));
}


console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
