/**
 * 凭据注入：Codex 读的是环境变量，而 DSH 的 key 存在 ~/.dsh/.credentials.yaml。
 *
 * 为什么要这一层：插件被 DSH 加载时，进程环境里不一定有 PORTDAN_API_KEY，
 * 而用户不该为了插件再手工配一遍环境变量。缺失时直接从凭据文件补，补不到就让
 * status 明确报出来（而不是等到派活时 Codex 报一句 Missing environment variable）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function credentialsPath() {
  return join(homedir(), '.dsh', '.credentials.yaml');
}

/** 从扁平 YAML（refs:\n  KEY: value）里取一个键；取不到返回 null。 */
export function loadCredentialRef(key) {
  if (!key) return null;
  const p = credentialsPath();
  if (!existsSync(p)) return null;
  let text = '';
  try { text = readFileSync(p, 'utf8'); } catch { return null; }
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = text.match(new RegExp('^\\s+' + escaped + ':[ \\t]*(.+)$', 'm'));
  if (!m) return null;
  const value = m[1].trim().replace(/^["']|["']$/g, '');
  return value || null;
}

/** 保证 process.env[key] 可用；返回来源，便于 status 展示。 */
export function ensureEnv(key) {
  if (!key) return { ok: true, source: 'none' };
  if (process.env[key]) return { ok: true, source: 'env' };
  const value = loadCredentialRef(key);
  if (!value) return { ok: false, source: 'missing' };
  process.env[key] = value;
  return { ok: true, source: 'credentials' };
}
