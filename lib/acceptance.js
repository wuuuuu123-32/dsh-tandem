/**
 * 机械验收 —— 给 tandem_delegate 的产物跑一组可核对的命令，把「干没干完」从一句话
 * 变成一份证据。
 *
 * 设计边界（v0.2.0 会审后明确，写进工具描述）：
 *  - 只做「退出码 + 输出包含/不包含」的机械门禁，**不提供独立 oracle**：
 *    checks 由主 agent 编写，语义验收仍由主 agent 负责；
 *  - checks 在首次 tandem_check 时冻结（哈希），同一任务后续不能改判据；
 *  - 不防「执行方改测试文件」—— 那是代码审阅要看的 diff，不是这里的职责。
 *
 * 语义（会审指出必须写明，否则 notContains 会出假阳性）：
 *  - 每条检查的断言全部 AND：退出码、contains、notContains 都要满足；
 *  - exit 默认 0；显式给 expect.exit = N 时可要求非零退出；
 *  - 输出取 stdout+stderr 合并后的【头 2KB + 尾 6KB】，中间省略并标注。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const MAX_CHECKS = 10;
const MAX_CMD = 2000;
const DEFAULT_CMD_TIMEOUT = 120000;
const MAX_CMD_TIMEOUT = 600000;
const DEFAULT_TOTAL_TIMEOUT = 300000;
const MAX_TOTAL_TIMEOUT = 900000;
const OUTPUT_CAP = 200 * 1024;

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/** 校验并规范化 checks；不合法项直接报错，不猜测。 */
export function normalizeChecks(input) {
  const errors = [];
  if (!Array.isArray(input) || input.length === 0) {
    return { errors: ['checks 必须是非空数组'], checks: [] };
  }
  if (input.length > MAX_CHECKS) {
    return { errors: [`最多 ${MAX_CHECKS} 条检查，收到 ${input.length} 条`], checks: [] };
  }
  const checks = input.map((item, i) => {
    const at = `checks[${i}]`;
    if (!item || typeof item !== 'object') { errors.push(`${at} 必须是对象`); return null; }
    const cmd = String(item.cmd || '').trim();
    if (!cmd) errors.push(`${at}.cmd 不能为空`);
    if (cmd.length > MAX_CMD) errors.push(`${at}.cmd 超过 ${MAX_CMD} 字符`);
    const exp = item.expect || {};
    if (exp && typeof exp !== 'object') errors.push(`${at}.expect 必须是对象`);
    if (exp?.exit !== undefined && !Number.isInteger(exp.exit)) errors.push(`${at}.expect.exit 必须是整数`);
    if (exp?.contains !== undefined && typeof exp.contains !== 'string') errors.push(`${at}.expect.contains 必须是字符串`);
    if (exp?.notContains !== undefined) {
      const arr = Array.isArray(exp.notContains) ? exp.notContains : [exp.notContains];
      if (arr.some(x => typeof x !== 'string' || !x)) errors.push(`${at}.expect.notContains 必须是非空字符串数组`);
    }
    if (item.timeoutMs !== undefined && (!Number.isInteger(item.timeoutMs) || item.timeoutMs < 1000)) {
      errors.push(`${at}.timeoutMs 必须是 ≥1000 的整数`);
    }
    const normalized = {
      cmd,
      expect: {
        exit: Number.isInteger(exp?.exit) ? exp.exit : 0,
        ...(typeof exp?.contains === 'string' && exp.contains ? { contains: exp.contains } : {}),
        ...(exp?.notContains ? { notContains: (Array.isArray(exp.notContains) ? exp.notContains : [exp.notContains]).filter(Boolean) } : {}),
      },
      ...(item.timeoutMs ? { timeoutMs: item.timeoutMs } : {}),
    };
    return normalized;
  }).filter(Boolean);
  return { errors, checks };
}

export function checksHash(checks) {
  return createHash('sha1').update(JSON.stringify(checks)).digest('hex').slice(0, 16);
}

/** 头 2KB + 尾 6KB，中间标注省略量。返回值用于断言与回传。 */
export function condenseOutput(text) {
  const head = 2000;
  const tail = 6000;
  if (text.length <= head + tail) return text;
  const omitted = text.length - head - tail;
  return text.slice(0, head) + `\n…[中间省略 ${omitted} 字符]…\n` + text.slice(-tail);
}

async function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
    }
  } catch { /* 进程可能已退出 */ }
}

function runOne(dir, check, index, timeoutMs) {
  return new Promise(resolveOne => {
    const started = Date.now();
    let out = '';
    let truncated = false;
    let settled = false;
    const finish = patch => {
      if (settled) return;
      settled = true;
      resolveOne({
        index,
        cmd: check.cmd,
        ms: Date.now() - started,
        output: condenseOutput(out),
        truncated,
        ...patch,
      });
    };
    let child;
    try {
      child = spawn(check.cmd, { cwd: dir, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return finish({ ok: false, code: null, failures: ['启动失败：' + error.message] });
    }
    const timer = setTimeout(async () => {
      await killTree(child.pid);
      finish({ ok: false, code: null, timedOut: true, failures: [`超时 ${timeoutMs}ms，已杀进程树`] });
    }, timeoutMs);
    const onData = chunk => {
      if (out.length < OUTPUT_CAP) out += chunk.toString('utf8');
      else truncated = true;
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', error => {
      clearTimeout(timer);
      finish({ ok: false, code: null, failures: ['spawn 出错：' + error.message] });
    });
    child.on('close', code => {
      clearTimeout(timer);
      const text = condenseOutput(out);
      const exp = check.expect || {};
      const failures = [];
      const wantExit = Number.isInteger(exp.exit) ? exp.exit : 0;
      if (code !== wantExit) failures.push(`退出码 ${code}，期望 ${wantExit}`);
      if (exp.contains && !text.includes(exp.contains)) failures.push(`输出不含 ${JSON.stringify(exp.contains)}`);
      for (const n of exp.notContains || []) if (text.includes(n)) failures.push(`输出包含禁止内容 ${JSON.stringify(n)}`);
      finish({ ok: failures.length === 0, code, failures });
    });
  });
}

/**
 * 依次跑完全部检查（串行，遇错不中断 —— 一次拿全所有缺口比逐条试快）。
 * 总时限到点后剩余检查直接判失败，不再启动。
 */
export async function runChecks(dir, checks, options = {}) {
  const totalMs = clamp(Number(options.totalTimeoutMs) || DEFAULT_TOTAL_TIMEOUT, 1000, MAX_TOTAL_TIMEOUT);
  const started = Date.now();
  const deadline = started + totalMs;
  const results = [];
  for (let i = 0; i < checks.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      results.push({ index: i, cmd: checks[i].cmd, ok: false, code: null, ms: 0, output: '', failures: ['总时限已到，未运行'] });
      continue;
    }
    const want = Number(checks[i].timeoutMs) || DEFAULT_CMD_TIMEOUT;
    const perCmd = Math.min(clamp(want, 1000, MAX_CMD_TIMEOUT), remaining);
    results.push(await runOne(dir, checks[i], i, perCmd));
  }
  return {
    ok: results.every(r => r.ok),
    ms: Date.now() - started,
    totalTimeoutMs: totalMs,
    checks: results,
  };
}

/** 把失败结果压成给 Codex 看的缺口清单（限长，避免回灌把上下文灌爆）。 */
export function buildGapReport(results, perItemLimit = 1500, totalLimit = 8000) {
  const parts = [];
  let used = 0;
  for (const r of results.filter(x => !x.ok)) {
    const head = `[${r.index + 1}] 命令：${r.cmd}\n退出码：${r.code}\n失败断言：${r.failures.join('；')}\n输出尾部：\n`;
    let body = r.output.slice(-perItemLimit);
    if (used + head.length + body.length > totalLimit) {
      const room = Math.max(0, totalLimit - used - head.length);
      body = body.slice(-room);
      if (!body) break;
    }
    parts.push(head + body);
    used += head.length + body.length;
  }
  return parts.join('\n\n');
}
