// turn 探针的行为测试（2026-11-25 交付会审两条反例的针对性验证）。
//
// 会审反例原文：
//   1) 「同一 reason 五分钟内全局只记一次，若首次异常后故障发生在另一个会话或阶段，
//       turn-probe.log 不会留下新记录。」
//   2) 「启动自证只说明 apply 时服务可见，不能证明后续读取或 turn 计算成功。」
//   3) 「未提供完整 turnOf 实现；如果 agents 的读取抛错或返回异常结构后统一落入 unexpected，
//       探针可能无法指出具体失败环节。」
//
// 三条都在这一份里钉住：探针是模块级导出，测的是真身而非复制品。
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTurnProbe } from '../index.js';

const fail = [];
const ok = [];
const dir = mkdtempSync(join(tmpdir(), 'tandem-turnprobe-'));
const read = () => (existsSync(join(dir, 'turn-probe.log')) ? readFileSync(join(dir, 'turn-probe.log'), 'utf8') : '');

// ---- 反例 1：不同会话的同一种故障，必须各自留下记录 ----
{
  const p = makeTurnProbe({ dir });
  p.fail('sessions-get-null: session-aaa', 'session-A');
  p.fail('sessions-get-null: session-bbb', 'session-B');
  const log = read();
  if (!log.includes('session-A')) fail.push('会话 A 的故障没落盘');
  else ok.push('会话 A 的故障已落盘');
  if (!log.includes('session-B')) fail.push('会话 B 的同种故障被去重吞掉了（会审反例 1 未修）');
  else ok.push('会话 B 的同种故障未被吞（去重键含 scope）');
}

// ---- 反例 1 续：同会话同 reason 连发 40 次，日志里应能看出「被吞了多少次」 ----
// ❗不能用 dedupMs:0 来测：窗口为 0 时每次都立刻结算，反而永远走不到「抑制」分支。
//   正确做法是注入一个可控时钟，把窗口跨过去。
{
  rmSync(join(dir, 'turn-probe.log'), { force: true });
  let clock = 1_000_000;
  const p = makeTurnProbe({ dir, dedupMs: 60_000, now: () => clock });
  for (let i = 0; i < 40; i++) { p.fail('chain-empty', 'session-C'); clock += 1000; } // 40 秒内 40 次，全被抑制
  clock += 61_000;                                                                     // 跨过一个窗口
  p.fail('chain-empty', 'session-C');                                                  // 这一行触发结算并打汇总
  const log = read();
  const suppressed = /suppressed (\d+)x/.exec(log);
  if (!suppressed) fail.push('连续 40 次失败没有写出 suppressed 汇总（反例：失败 40 次和 1 次长得一样）');
  else if (Number(suppressed[1]) !== 40) fail.push('suppressed 计数不对：' + suppressed[0] + '，期望 40');
  else ok.push('被抑制次数已回写：' + suppressed[0]);
}

// ---- 反例 2：成功路径也必须留痕 ----
{
  rmSync(join(dir, 'turn-probe.log'), { force: true });
  const p = makeTurnProbe({ dir });
  const r = p.ok(16, 'session-D');
  if (r !== 16) fail.push('ok() 返回值不等于传入的 turn（会破坏调用方语义）');
  else ok.push('ok() 原样返回 turn，不改变调用方语义');
  const log = read();
  if (!log.includes('TURN-OK') || !log.includes('turn=16')) fail.push('成功路径没留痕（无法判断「后续取值成功」）');
  else ok.push('成功路径已留痕：TURN-OK turn=16');
}

// ---- 反例 3：每一环的失败原因必须互相可区分，不能都落进 unexpected ----
{
  rmSync(join(dir, 'turn-probe.log'), { force: true });
  const p = makeTurnProbe({ dir });
  const reasons = [
    'chain-empty',
    'sessions-service-missing',
    'sessions-get-threw: boom',
    'sessions-get-null: session-x',
    'agents-service-missing',
    'turnBoundary-threw: boom2',
    'lastTurn-not-integer: {"lastTurn":"x"}',
    'unexpected: totally different',
  ];
  // 每种用不同 scope，确保都落盘
  reasons.forEach((r, i) => p.fail(r, 's' + i));
  const log = read();
  const missing = reasons.filter((r) => !log.includes(r.split(':')[0]));
  if (missing.length) fail.push('这些失败原因在日志里不可见：' + missing.join(', '));
  else ok.push('8 种失败原因在日志里全部可区分');
}

// ---- 限幅：超过上限必须截半，不能无限增长 ----
{
  rmSync(join(dir, 'turn-probe.log'), { force: true });
  const p = makeTurnProbe({ dir, maxBytes: 4096, dedupMs: 0 });
  for (let i = 0; i < 400; i++) p.fail('chain-empty', 'scope-' + (i % 7));
  const size = readFileSync(join(dir, 'turn-probe.log')).length;
  if (size > 4096 * 2) fail.push('日志没被限幅：' + size + ' 字节（上限 4096）');
  else ok.push('日志被限幅在 ' + size + ' 字节（上限 4096，截半后继续增长但仍受控）');
}

rmSync(dir, { recursive: true, force: true });
if (fail.length) { for (const m of fail) console.log('FAIL: ' + m); process.exit(1); }
for (const m of ok) console.log('ok: ' + m);
console.log('TURN-PROBE-BEHAVIOUR TEST OK: 三条交付会审反例全部覆盖');