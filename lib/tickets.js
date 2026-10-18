/**
 * 验收票据 —— 一个 taskId 对应一次派活的完整上下文：目录、原始验收标准、冻结的 checks、
 * 已驳回轮次、最近一次检查结果。
 *
 * 为什么用票据而不是「按目录计数」：会审指出按目录计数会被改名、符号链接、大小写别名
 * 绕过。按 taskId 计数只要票据不丢就不会被路径别名骗到；但「新开一个任务」仍会重置，
 * 所以轮次上限只是防同一任务无限循环，**不是安全边界**（已写进工具描述）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export function ticketsFile(stateDir) {
  return join(stateDir, 'tickets.json');
}

export function loadTickets(stateDir) {
  try {
    const file = ticketsFile(stateDir);
    if (!existsSync(file)) return {};
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function saveTickets(stateDir, tickets) {
  const file = ticketsFile(stateDir);
  mkdirSync(stateDir, { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(tickets, null, 2));
  renameSync(tmp, file);
}

export function newTaskId() {
  return 'td-' + randomBytes(4).toString('hex');
}

/**
 * 路径规范化：realpath 解符号链接/联接后再小写（Windows 不区分大小写）。
 * 失败时退回 resolve + 小写 —— 规范化尽力而为，不阻断派活。
 */
export function normalizeDir(dir) {
  try {
    const real = realpathSync.native ? realpathSync.native(dir) : realpathSync(dir);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    const abs = resolve(dir);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  }
}

export function getTicket(tickets, taskId) {
  return tickets[taskId] || null;
}

/** 记录一次派活：taskId → 目录、验收标准、审计时间。 */
export function openTicket(tickets, { taskId, dir, acceptance }) {
  tickets[taskId] = {
    taskId,
    dir,
    acceptance: String(acceptance || ''),
    checks: null,
    checksHash: null,
    rounds: 0,
    lastCheck: null,
    createdAt: new Date().toISOString(),
  };
  return tickets[taskId];
}

/** 记一次检查结果（checks 已冻结的前提下）。details 供 tandem_reject 原样回灌。 */
export function recordCheck(ticket, result) {
  const failed = result.checks.filter(c => !c.ok);
  ticket.lastCheck = {
    at: new Date().toISOString(),
    ok: !!result.ok,
    failures: failed.map(c => `${c.cmd} → ${c.failures.join('；')}`),
    details: failed.map(c => ({
      cmd: c.cmd,
      code: c.code,
      failures: c.failures,
      output: String(c.output || '').slice(-1500),
    })),
  };
}
