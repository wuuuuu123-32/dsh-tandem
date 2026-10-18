/**
 * 并行派活：把若干互不依赖的任务交给本机 Codex CLI 同时执行。
 *
 * 为什么参数校验放在这里而不是 hook：工具参数不合法，调用当场就失败——
 * 这本身就是强制的，而且零延迟、零误伤。hook 只留给「不可逆操作」。
 *
 * 复用自 D:\dsh\config\codex\run.mjs 的实测经验：
 *  - Windows 下必须 danger-full-access，work*-write 会被静默降级成 read-only
 *  - 非 tty + 管道会把输出吞掉，所以 stdio 直接接日志文件
 *  - 超时要杀整棵进程树，否则 codex 子进程残留
 *  - 并发 >3 会被上游挂住
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { loadTickets, saveTickets, openTicket, newTaskId, normalizeDir } from './tickets.js';

const MAX_LOG_TAIL = 3000;

// tickets.json 的读改写必须串行：runTasks 是 Promise.all，多个任务同时结束时
// 各自「读全量 → 写全量」会互相覆盖，票据静默丢失（会审指出）。
let ticketChain = Promise.resolve();
function persistTicket(stateDir, taskId, dir, acceptance, skip) {
  if (skip || !stateDir) return Promise.resolve();
  ticketChain = ticketChain.then(() => {
    const tickets = loadTickets(stateDir);
    openTicket(tickets, { taskId, dir: normalizeDir(dir), acceptance });
    saveTickets(stateDir, tickets);
  }).catch(() => {});
  return ticketChain;
}


// Codex 跑完一轮后固定打印 "tokens used" 用量摘要。实测同一份 prompt 曾出现
// 「退出码 0、日志只有头部和 prompt、一个文件都没改」的空跑（37s，25 行），
// 而正常完成的日志都有这一行。所以退出码不能单独作为成功依据。
// 注意：这是人类可读输出，不是稳定接口，因此做成可关的开关（requireCompletionMarker:false）。
// 真实输出形如：
//   codex
//   <最后一段汇报>
//   tokens used
//   106,736
// 所以要求「行首 tokens used + 紧跟一行数字」，而不是在任意位置出现这两个词：
// 任务 prompt 或模型正文里提到 "tokens used" 不该被当成完成标记（独立评审指出的假成功口子）。
/**
 * Codex CLI 每次正常结束都会在最末尾打印 "tokens used" + 数字行。
 *
 * ❗匹配必须锚定在**日志结尾**，不能只在全文任意位置找：任务 prompt 会被原样回显进日志，
 * 只要 prompt 或正文里出现一行 "tokens used" 加一行数字，任意位置匹配就会把失败任务判成成功
 * （2026-10-17 独立复审第二次指出）。
 * 锚定结尾之后，prompt 里伪造的标记必然出现在真正的 summary 之前，不可能命中。
 *
 * ❗0.163 的结尾格式变了（2026-10-18 实测）：tokens used 之后**还有一段重复的最后消息**：
 *   codex
 *   <最终汇报>
 *   tokens used
 *   41,641
 *   <最终汇报（重复）>
 * 所以允许标记后跟最多 4000 字符的收尾文本，仍要求一路匹配到日志末尾。
 */
const COMPLETION_MARKER = /(?:^|\n)tokens used[ \t]*\r?\n[ \t]*[\d,]+[ \t]*(?:\r?\n[\s\S]{0,4000})?$/i;
// 日志上限 4 MB：正常任务几十 KB 到几百 KB；超大日志只按尾部 4 MB 处理，足够覆盖结尾。
const MAX_LOG_SCAN = 4 * 1024 * 1024;

export function hasCompletionMarker(logPath) {
  try {
    const raw = readFileSync(logPath, 'utf8');
    const text = raw.length > MAX_LOG_SCAN ? raw.slice(-MAX_LOG_SCAN) : raw;
    // 允许结尾有空白/换行（Windows 下 CRLF、进程退出时可能多一个空行）
    return COMPLETION_MARKER.test(text.replace(/[ \t\r\n]+$/, ''));
  } catch {
    return false;
  }
}

export function normalizeRoots(roots) {
  return (Array.isArray(roots) ? roots : []).map(r => resolve(String(r)).replace(/\\/g, '/').toLowerCase());
}

/** dir 是否落在白名单根内（防越界写）。 */
export function insideRoots(dir, roots) {
  if (!isAbsolute(dir)) return false;
  const d = resolve(dir).replace(/\\/g, '/').toLowerCase();
  return roots.some(root => d === root || d.startsWith(root.endsWith('/') ? root : root + '/'));
}

/** 校验任务集；返回错误清单（空数组 = 通过）。 */
export function validateTasks(tasks, { roots, maxParallel }) {
  const errors = [];
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return ['tasks 必须是非空数组'];
  }
  if (tasks.length > maxParallel) {
    errors.push(`并发上限 ${maxParallel}，本次给了 ${tasks.length} 个任务；请拆成多批或减少任务数`);
  }
  const ids = new Set();
  const dirs = new Set();
  tasks.forEach((t, i) => {
    const at = `tasks[${i}]`;
    if (!t || typeof t !== 'object') return errors.push(`${at} 不是对象`);
    if (!t.id || typeof t.id !== 'string') errors.push(`${at}.id 缺失或不是字符串`);
    else if (ids.has(t.id)) errors.push(`${at}.id 重复：${t.id}`);
    else ids.add(t.id);
    if (!t.dir || typeof t.dir !== 'string') errors.push(`${at}.dir 缺失`);
    else if (!isAbsolute(t.dir)) errors.push(`${at}.dir 必须是绝对路径：${t.dir}`);
    else if (!insideRoots(t.dir, roots)) errors.push(`${at}.dir 不在允许根内（${roots.join(' | ')}）：${t.dir}`);
    else {
      // 只要求「dir 字符串不重复」不够：A 的 dir 若是 B 的 dir 的上级，两个 agent 会写同一棵树，
      // 后写的覆盖先写的，而且事后无法归因。这里把互相包含也拒绝掉。
      // （不做「运行前后快照对比越界文件」：并行任务与外部进程都会在审计窗口内改文件，
      //   快照只能看到差异、无法归因，mtime+size 的粒度还会漏掉同尺寸改写 —— 误报与漏报同时存在，
      //   不如只保证互不重叠这一个可确定的事实。）
      const norm = resolve(t.dir).replace(/\\/g, '/').toLowerCase();
      const clash = [...dirs].find(d => norm === d || norm.startsWith(d + '/') || d.startsWith(norm + '/'));
      if (clash) {
        errors.push(`${at}.dir 与另一个任务的目录互相包含（${t.dir} ↔ ${clash}）：并行写同一棵树会互相覆盖`);
      } else {
        dirs.add(norm);
      }
    }
    if (!t.prompt || typeof t.prompt !== 'string' || t.prompt.trim().length < 8) {
      errors.push(`${at}.prompt 缺失或过短（<8 字符）`);
    }
    if (!Number.isFinite(t.timeoutMs) || t.timeoutMs < 10000) {
      errors.push(`${at}.timeoutMs 必填且 ≥10000（单位毫秒）；没有超时的任务会一直挂着`);
    }
    if (!t.acceptance || typeof t.acceptance !== 'string' || t.acceptance.trim().length < 3) {
      errors.push(`${at}.acceptance 必填：写一句「怎么算干完了」（命令或可核对的判据）。没有验收标准的派活不算完成`);
    }
  });
  return errors;
}

export function killTree(pid) {
  return new Promise(resolveKill => {
    if (process.platform === 'win32') {
      const k = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
      k.on('exit', () => resolveKill());
      k.on('error', () => resolveKill());
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
      resolveKill();
    }
  });
}

/** 跑一个任务。resolve 永远不 reject——失败信息放进结果里。 */
export function runOne(task, config) {
  const started = Date.now();
  const dir = resolve(task.dir);
  const logPath = join(dir, 'codex.log');
  // ❗只有配了 model 才传 -m（同 consult.js：否则会变成 "-m undefined" 直接 404）
  const modelArgs = config.model ? ['-m', String(config.model)] : [];
  const args = [
    'exec', '--skip-git-repo-check',
    '-s', 'danger-full-access',
    '-c', 'approval_policy=never',
    // ❗同 consult.js：Codex 0.163 的 multi_agent 在非交互 exec 下会调 collab wait 永久挂起。
    '--disable', 'multi_agent',
    // ❗禁用全局 MCP 服务器（桌面端配的 node_repl / computer-use）：非交互 exec 里它们反复
    // 启动失败（日志满屏 mcp: cua_repl/js (failed)），实测把一个 12 字节文件的活拖到 90~130s。
    // 用 -c 只覆盖本次进程，不改用户 ~/.codex/config.toml。
    '-c', 'mcp_servers={}',
    ...modelArgs,
    '-C', dir,
    task.prompt,
  ];
  return new Promise(resolveRun => {
    let fd;
    try {
      mkdirSync(dir, { recursive: true });
      fd = openSync(logPath, 'w');
    } catch (error) {
      return resolveRun({ id: task.id, ok: false, error: `准备目录/日志失败：${error.message}`, ms: Date.now() - started });
    }
    let child;
    try {
      child = spawn(config.codexCommand, args, {
        cwd: dir,
        stdio: ['ignore', fd, fd],
        env: process.env,
        windowsHide: true,
      });
    } catch (error) {
      closeSync(fd);
      return resolveRun({ id: task.id, ok: false, error: `启动失败：${error.message}`, ms: Date.now() - started });
    }
    let settled = false;
    const finish = async (patch) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { closeSync(fd); } catch {}
      let tail = '';
      try { tail = readFileSync(logPath, 'utf8').slice(-MAX_LOG_TAIL); } catch {}
      // 只有成功的派活才开验收票据：失败的 taskId 没有可验收的产物。
      const taskId = newTaskId();
      if (patch.ok) await persistTicket(config.stateDir, taskId, dir, task.acceptance, config.skipTicket);
      resolveRun({ id: task.id, ...(patch.ok ? { taskId } : {}), dir, log: logPath, acceptance: task.acceptance, tail, ms: Date.now() - started, ...patch });
    };
    const timer = setTimeout(async () => {
      await killTree(child.pid);
      finish({ ok: false, timedOut: true, error: `超时 ${task.timeoutMs}ms，已杀进程树` });
    }, task.timeoutMs);
    child.on('error', error => finish({ ok: false, error: `spawn 出错：${error.message}` }));
    // 用 close 而不是 exit：exit 触发时 stdio 可能还没排空，此时读日志会读到残缺内容。
    child.on('close', code => {
      if (code !== 0) return finish({ ok: false, code });
      if (config.requireCompletionMarker === false) return finish({ ok: true, code });
      if (!hasCompletionMarker(logPath)) {
        return finish({
          ok: false,
          code,
          emptyRun: true,
          error: 'Codex 退出码 0，但日志里没有完成标记（tokens used），判定为空跑；已按失败处理以便重派',
        });
      }
      finish({ ok: true, code });
    });
  });
}

/** 顺序无关地并行跑 N 个任务（N ≤ maxParallel）。 */
export async function runTasks(tasks, config) {
  const results = await Promise.all(tasks.map(task => runOne(task, config)));
  return results;
}

export function summarize(results) {
  const ok = results.filter(r => r.ok).length;
  return { total: results.length, ok, failed: results.length - ok };
}
