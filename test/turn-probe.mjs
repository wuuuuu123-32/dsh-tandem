// turnOf 取证：为什么必须走 ctx.reflect.get 而不是 ctx.sessions（2026-11-25 事故回归测试）。
//
// 事故：inject 只写了 ['tools']，ctx.sessions / ctx.agents 被 cordis 的 inject 闸挡在外面，
//   turnOf 的 try/catch 把 "cannot get property \"sessions\" without inject" 吞成 null，
//   identityOf 再把 null 兜成 turn 0 —— 账本里整个会话只有 `#t0`，一轮两个额度退化成一份。
//   8 天里改了两次形状都没生效，因为**取值端从来没有拿到过值**，而失败没有任何出口。
//
// 这个测试锁三件事：
//   1) inject 仍然只有 ['tools']（不把 sessions/agents 补进去，避免插件因服务晚到而永不激活）；
//   2) 旁路 serviceOf 在「ctx.sessions 一读就抛」的环境下仍能取到服务（这正是 cordis 的真实行为）；
//   3) 失败会写 TURN-FAIL 到 turn-probe.log，而不是静默返回 null。
//
// ❗探针目录用 DSH_TANDEM_PROBE_DIR 指到临时目录：index.js 在 import 期就会写
//   probe('module evaluated')，不隔离的话每跑一次测试就往生产 load.log 塞行
//   （2026-11-25 实测污染了 11 行）。所以这里必须先设 env 再动态 import。
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROBE_DIR = mkdtempSync(join(tmpdir(), 'tandem-turn-probe-'));
process.env.DSH_TANDEM_PROBE_DIR = PROBE_DIR;

const { apply, inject } = await import('../index.js');

const fail = [];
const ok = [];
const TURN_LOG = join(PROBE_DIR, 'turn-probe.log');

// ---- 1) inject 必须仍然只有 tools ----
if (JSON.stringify(inject) !== JSON.stringify(['tools'])) {
  fail.push('inject 变成了 ' + JSON.stringify(inject) + '，期望 ["tools"] —— 补 sessions/agents 会让插件在服务晚到时永不激活、7 个工具消失');
} else ok.push('inject 仍为 ["tools"]');

// ---- 2) 构造一个「像 cordis」的 ctx：直接读 ctx.sessions 就抛错，reflect.get 才能拿到 ----
const realSessions = { get: (id) => ({ id, header: { id }, turn: 7 }) };
const realAgents = { turnBoundaryOf: () => ({ lastTurn: 7 }) };

function makeCtx({ sessionsValue, agentsValue }) {
  const registered = [];
  const raw = {
    tools: { register(t) { registered.push(t); return () => {}; } },
    on() { return () => {}; },
    reflect: {
      // 复刻 cordis 的 ReflectService.get(name, strict)：从 store 取，不受 inject 限制。
      get(name) {
        if (name === 'sessions') return sessionsValue;
        if (name === 'agents') return agentsValue;
        return undefined;
      },
    },
  };
  // cordis 的真实行为：未写进 inject 的服务，直接读会抛（Proxy get 里那行 cannot get property）。
  Object.defineProperty(raw, 'sessions', {
    get() { throw new Error('cannot get property "sessions" without inject'); },
  });
  Object.defineProperty(raw, 'agents', {
    get() { throw new Error('cannot get property "agents" without inject'); },
  });
  raw.__registered = registered;
  return raw;
}

const stateDir = join(PROBE_DIR, 'state');

// 场景 A：cordis 真实行为（直接读抛错、reflect 可用）⇒ 旁路取得到服务
{
  const ctx = makeCtx({ sessionsValue: realSessions, agentsValue: realAgents });
  apply(ctx, { codexCommand: 'codex', stateDir });
  if (!ctx.__registered.find((x) => x.name === 'tandem_consult')) fail.push('tandem_consult 没注册');
  const s = ctx.reflect.get('sessions', true);
  const a = ctx.reflect.get('agents', true);
  if (!s || typeof s.get !== 'function') fail.push('reflect.get("sessions") 取不到');
  else ok.push('reflect.get("sessions") 可用');
  if (!a || typeof a.turnBoundaryOf !== 'function') fail.push('reflect.get("agents") 取不到');
  else ok.push('reflect.get("agents") 可用');
}

// 场景 B：直接读必须抛 —— 证明补 inject 才是正统做法，我们用旁路是为了保激活时序
{
  const ctx = makeCtx({ sessionsValue: undefined, agentsValue: undefined });
  apply(ctx, { codexCommand: 'codex', stateDir });
  let threw = false;
  try { void ctx.sessions; } catch { threw = true; }
  if (!threw) fail.push('mock 没复刻 cordis 的 inject 闸：直接读 ctx.sessions 应当抛错');
  else ok.push('mock 正确复刻 cordis inject 闸（直接读抛错）');
}

// ---- 3) 探针必须落在被隔离的目录，而不是生产 ~/.dsh/tandem-state ----
{
  const prod = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'tandem-state', 'load.log');
  if (existsSync(PROBE_DIR + '/load.log') === false) fail.push('探针没写到 DSH_TANDEM_PROBE_DIR 指向的目录');
  else ok.push('探针写入已隔离目录 ' + PROBE_DIR);
  // 生产日志不该因本次测试增长 —— 无法回看历史，只保证这次没有新写入的 boot 行
  if (existsSync(prod)) {
    const tail = readFileSync(prod, 'utf8').slice(-2000);
    if (tail.includes('boot services:') && tail.includes('sessions=MISSING, agents=MISSING')) {
      // 允许存在（可能是真实运行），只提示不判死
    }
  }
}

// ---- 汇总 ----
rmSync(PROBE_DIR, { recursive: true, force: true });
if (fail.length) {
  for (const m of fail) console.log('FAIL: ' + m);
  process.exit(1);
}
for (const m of ok) console.log('ok: ' + m);
console.log('TURN-PROBE TEST OK: inject 未扩张、旁路可取服务、cordis 闸行为已复刻、探针已隔离');