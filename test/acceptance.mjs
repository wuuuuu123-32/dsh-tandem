/**
 * 机械验收与票据的单元测试（不依赖真实 Codex）。
 * 覆盖会审指出的几个反例：
 *  - `echo PASS && exit /b 1` 配 contains:PASS 不能通过（exit 断言默认 0）；
 *  - `notContains:error` 不能让退出码非零的命令通过；
 *  - 超时命令必须判失败且杀掉；
 *  - 票据读改写往返不丢字段。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeChecks, checksHash, runChecks, condenseOutput } from '../lib/acceptance.js';
import { loadTickets, saveTickets, openTicket, recordCheck, getTicket, newTaskId } from '../lib/tickets.js';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([name, true]); }
  catch (error) { results.push([name, false, error.message]); }
}

const dir = mkdtempSync(join(tmpdir(), 'tandem-accept-'));

await test('normalizeChecks 拒绝空数组/超长/空 cmd/非整数 exit', () => {
  assert.ok(normalizeChecks([]).errors.length > 0);
  assert.ok(normalizeChecks(new Array(11).fill({ cmd: 'x' })).errors.length > 0);
  assert.ok(normalizeChecks([{ cmd: '' }]).errors.length > 0);
  assert.ok(normalizeChecks([{ cmd: 'x', expect: { exit: '1' } }]).errors.length > 0);
  assert.equal(normalizeChecks([{ cmd: 'x' }]).errors.length, 0);
});

await test('normalizeChecks 填充默认 expect.exit=0 与 notContains 归一', () => {
  const { checks } = normalizeChecks([{ cmd: 'x', expect: { notContains: 'e' } }]);
  assert.equal(checks[0].expect.exit, 0);
  assert.deepEqual(checks[0].expect.notContains, ['e']);
});

await test('checksHash 同内容稳定、异内容不同', () => {
  const a = normalizeChecks([{ cmd: 'node -v' }]).checks;
  const b = normalizeChecks([{ cmd: 'node -v' }]).checks;
  const c = normalizeChecks([{ cmd: 'node --version' }]).checks;
  assert.equal(checksHash(a), checksHash(b));
  assert.notEqual(checksHash(a), checksHash(c));
});

await test('contains 命中且 exit 0 → 通过', async () => {
  const r = await runChecks(dir, normalizeChecks([{ cmd: 'node -e "console.log(\'PASS\')"', expect: { contains: 'PASS' } }]).checks, {});
  assert.equal(r.ok, true);
  assert.equal(r.checks[0].ok, true);
});

await test('反例：echo PASS && exit 1 必须失败（exit 断言默认 0）', async () => {
  const r = await runChecks(dir, normalizeChecks([{ cmd: 'echo PASS && exit 1', expect: { contains: 'PASS' } }]).checks, {});
  assert.equal(r.ok, false);
  assert.match(r.checks[0].failures.join(' '), /退出码/);
});

await test('反例：notContains 不能让非零退出的命令通过', async () => {
  const r = await runChecks(dir, normalizeChecks([{ cmd: 'exit 3', expect: { notContains: 'error' } }]).checks, {});
  assert.equal(r.ok, false);
  assert.match(r.checks[0].failures.join(' '), /退出码/);
});

await test('超时命令判失败并标记 timedOut', async () => {
  const r = await runChecks(dir, normalizeChecks([{ cmd: 'node -e "setTimeout(()=>{},10000)"', timeoutMs: 1000 }]).checks, {});
  assert.equal(r.ok, false);
  assert.equal(r.checks[0].timedOut, true);
});

await test('总时限到点后剩余检查直接判失败', async () => {
  const r = await runChecks(dir, normalizeChecks([{ cmd: 'node -e "setTimeout(()=>{},2000)"', timeoutMs: 5000 }, { cmd: 'echo later' }]).checks, { totalTimeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.checks[1].ok, false);
});

await test('condenseOutput 保留头尾并标注省略', () => {
  const text = 'H'.repeat(3000) + 'M'.repeat(3000) + 'T'.repeat(3000);
  const out = condenseOutput(text);
  assert.ok(out.startsWith('H'));
  assert.ok(out.endsWith('T'));
  assert.match(out, /中间省略/);
});

await test('票据往返：开票→记录失败→读回 details', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tandem-tickets-'));
  const tickets = {};
  const taskId = newTaskId();
  openTicket(tickets, { taskId, dir, acceptance: 'node test.js 退出码 0' });
  const ticket = getTicket(tickets, taskId);
  assert.equal(ticket.rounds, 0);
  recordCheck(ticket, {
    ok: false,
    checks: [{ index: 0, cmd: 'node test.js', ok: false, code: 1, failures: ['退出码 1，期望 0'], output: 'boom' }],
  });
  saveTickets(stateDir, tickets);
  const back = loadTickets(stateDir);
  assert.equal(back[taskId].lastCheck.ok, false);
  assert.equal(back[taskId].lastCheck.details[0].output, 'boom');
  try { rmSync(stateDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
});

try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows 句柄释放慢 */ }

let failed = 0;
for (const [name, ok, error] of results) {
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) { failed += 1; console.log('   ' + error); }
}
console.log(failed === 0 ? `\n全部通过（${results.length} 项）` : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
