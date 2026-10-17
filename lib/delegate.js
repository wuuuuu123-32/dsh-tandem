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

const MAX_LOG_TAIL = 3000;

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
  const args = [
    'exec', '--skip-git-repo-check',
    '-s', 'danger-full-access',
    '-c', 'approval_policy=never',
    '-m', config.model,
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
      resolveRun({ id: task.id, dir, log: logPath, acceptance: task.acceptance, tail, ms: Date.now() - started, ...patch });
    };
    const timer = setTimeout(async () => {
      await killTree(child.pid);
      finish({ ok: false, timedOut: true, error: `超时 ${task.timeoutMs}ms，已杀进程树` });
    }, task.timeoutMs);
    child.on('error', error => finish({ ok: false, error: `spawn 出错：${error.message}` }));
    child.on('exit', code => finish({ ok: code === 0, code }));
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
