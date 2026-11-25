// 启动自证回归：apply 必须把 sessions / agents 的取用结果写进探针目录的 load.log。
//
// 为什么需要这条：2026-11-25 之前 inject 只写 ['tools']，sessions/agents 一直取不到，
// 但失败没有任何出口，于是「8 天改两次都不生效」。这条测试锁住那个出口本身 ——
// 只要有人删掉 probe('boot services: ...')，或把 serviceOf 改回 ctx.sessions，
// 这个测试就会红。
//
// ❗探针目录必须用 DSH_TANDEM_PROBE_DIR 指到临时目录后再动态 import ——
//   index.js 在 import 期就写 probe('module evaluated')，否则每跑一次测试就污染生产日志。
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROBE_DIR = mkdtempSync(join(tmpdir(), 'tandem-boot-probe-'));
process.env.DSH_TANDEM_PROBE_DIR = PROBE_DIR;

const { apply } = await import('../index.js');

const fail = [];
const LOG = join(PROBE_DIR, 'load.log');
const before = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';

const sessions = { get: () => ({ id: 'session-x' }) };
const agents = { turnBoundaryOf: () => ({ lastTurn: 3 }) };

// 复刻 cordis：inject 之外的服务直接读会抛，只有 reflect.get 能取到。
const ctx = {
  tools: { register() { return () => {}; } },
  on() { return () => {}; },
  reflect: { get: (name) => (name === 'sessions' ? sessions : name === 'agents' ? agents : undefined) },
};
Object.defineProperty(ctx, 'sessions', { get() { throw new Error('cannot get property "sessions" without inject'); } });
Object.defineProperty(ctx, 'agents', { get() { throw new Error('cannot get property "agents" without inject'); } });

apply(ctx, { codexCommand: 'codex', stateDir: join(PROBE_DIR, 'state') });

const after = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
const added = after.slice(before.length);
const bootLine = added.split('\n').find((l) => l.includes('boot services:'));

if (!bootLine) fail.push('apply 没有写出 boot services 自证行（added=' + JSON.stringify(added.slice(-300)) + '）');
else {
  if (!bootLine.includes('sessions=ok')) fail.push('自证行没报 sessions=ok：' + bootLine);
  if (!bootLine.includes('agents=ok')) fail.push('自证行没报 agents=ok：' + bootLine);
}

// 反向：服务缺失时必须报 MISSING，不能因为吞异常就静默显示 ok
{
  const before2 = readFileSync(LOG, 'utf8');
  const ctx2 = {
    tools: { register() { return () => {}; } },
    on() { return () => {}; },
    reflect: { get: () => undefined }, // 服务真没提供
  };
  apply(ctx2, { codexCommand: 'codex', stateDir: join(PROBE_DIR, 'state') });
  const line2 = readFileSync(LOG, 'utf8').slice(before2.length).split('\n').find((l) => l.includes('boot services:'));
  if (!line2) fail.push('服务缺失时没写自证行');
  else if (!line2.includes('sessions=MISSING') || !line2.includes('agents=MISSING')) {
    fail.push('服务缺失时没报 MISSING（会掩盖故障）：' + line2);
  }
}

rmSync(PROBE_DIR, { recursive: true, force: true });
if (fail.length) { for (const m of fail) console.log('FAIL: ' + m); process.exit(1); }
console.log('ok: boot services 自证行已写入 → ' + (bootLine || '').trim());
console.log('ok: 服务缺失时报 MISSING，不会静默显示 ok');
console.log('ok: 探针已隔离到临时目录，未污染 ' + join(process.env.USERPROFILE || '', '.dsh', 'tandem-state'));
console.log('BOOT-PROBE TEST OK');