/**
 * 定位 Codex CLI。
 *
 * 为什么不能只写 "codex"：DSH 是桌面应用，它的 PATH 不一定包含 npm 全局目录，
 * 直接 spawn "codex" 会 ENOENT 或者命中错误的壳。这里按「显式配置 → npm 全局安装位置 → PATH」
 * 的顺序探测，并把 .exe 排在 .cmd 前面——Windows 下 spawn 一个 .cmd 需要额外包一层 cmd.exe。
 */
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

export function resolveCodexCommand(preferred) {
  const candidates = [];
  if (typeof preferred === 'string' && preferred.trim()) {
    const p = preferred.trim();
    if (isAbsolute(p)) candidates.push(p);
    else if (p !== 'codex' && p !== 'codex.cmd') candidates.push(p);
  }
  const appData = process.env.APPDATA;
  if (appData) {
    candidates.push(join(appData, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
    candidates.push(join(appData, 'npm', 'codex.cmd'));
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return typeof preferred === 'string' && preferred.trim() ? preferred.trim() : 'codex';
}
