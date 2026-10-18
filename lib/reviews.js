/**
 * 会审标记（reviewId）—— 证明「这一部分改动经过独立复核」的凭证。
 *
 * 由谁签发：只有 consult 工具在 Codex 真返回有效四段答案后、在**本进程内**生成。
 * 随机不可猜，模型写不出真的；伪造只能得到一个查不到的 id，加载/检查时当场暴露。
 *
 * 覆盖范围（paths）：一次会审对应一组路径（目录或文件）。同一凭证可以在这些路径上
 * 派多个活、做多次检查 —— 它标的是「这块内容审过」，不是「你只准用一次」。
 *
 * 落盘：<stateDir>/reviews.jsonl，一行一条，只追加；轮转时保留最近的与仍被票据引用的。
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

export function reviewsFile(stateDir) {
  return join(stateDir, 'reviews.jsonl');
}

export function newReviewId() {
  return 'rv-' + randomBytes(8).toString('hex');
}

export const MAX_PATHS = 20;

/**
 * 路径规范：能 realpath 就 realpath（解开符号链接/联接，否则改指向能骗过前缀判断），
 * 不存在时退回 resolve（会审时目标目录可能还没建）。
 */
export function normalizePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths
    .filter(p => typeof p === 'string' && p.trim())
    .map(p => {
      const abs = resolve(p.trim());
      try {
        return realpathSync.native ? realpathSync.native(abs) : realpathSync(abs);
      } catch {
        return abs;
      }
    })
    .slice(0, MAX_PATHS);
}

// 指纹只认源码与文档：日志/状态/reviews.jsonl 自己会变，算进去会让标记一签发就过期。
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', 'build', 'coverage', '.next', '.cache', 'state', 'target', '__pycache__', '.venv']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.yml', '.yaml', '.py', '.rs', '.go', '.toml', '.css', '.html', '.sh']);
const MAX_FILES = 300;
const MAX_HASH_BYTES = 1024 * 1024;

/**
 * 内容指纹：把路径下的源码文件按「相对路径 + 内容 sha1」聚合成一个短 hash。
 * 只收 CODE_EXT 里的扩展名 —— 一个目录里没有源码文件时指纹恒定（此时它判断不了任何事）。
 *
 * 为什么需要它：reviewId 只绑了路径，路径上的内容换了它照样命中 —— 那就会给出
 * 「审过」的假信号（盲审反例 #1）。指纹变了不阻断验收，只把标记判为过期（reviewed:false + stale:true）。
 */
export function fingerprintPaths(paths) {
  const entries = [];
  const walk = (root, dir, depth) => {
    if (entries.length >= MAX_FILES || depth > 12) return;
    let names = [];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of names) {
      if (entries.length >= MAX_FILES) return;
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name.toLowerCase())) continue;
        walk(root, full, depth + 1);
      } else if (item.isFile()) {
        const dot = item.name.lastIndexOf('.');
        const ext = dot >= 0 ? item.name.slice(dot).toLowerCase() : '';
        if (!CODE_EXT.has(ext)) continue;
        try {
          const st = statSync(full);
          const rel = relative(root, full);
          // 真内容哈希（盲审指出 size+mtime 不是内容：同尺寸改写能骗过）。
          // 超大文件才退回 size+mtime，并在指纹里标 weak 以便辨认。
          if (st.size <= MAX_HASH_BYTES) {
            entries.push(`${rel}|h:${createHash('sha1').update(readFileSync(full)).digest('hex').slice(0, 12)}`);
          } else {
            entries.push(`${rel}|weak:${st.size}|${Math.round(st.mtimeMs)}`);
          }
        } catch {}
      }
    }
  };
  for (const p of Array.isArray(paths) ? paths : []) {
    try {
      const st = statSync(p);
      if (st.isDirectory()) walk(p, p, 0);
      else entries.push(`.|${st.size}|${Math.round(st.mtimeMs)}`);
    } catch {}
  }
  entries.sort();
  return createHash('sha1').update(entries.join('\n')).digest('hex').slice(0, 16);
}

export function appendReview(stateDir, review) {
  if (!stateDir) return null;
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(reviewsFile(stateDir), JSON.stringify(review) + '\n');
  return review;
}

/** 读出全部会审记录（新的在后）。坏行跳过 —— 一条坏记录不该让整个标记体系不可用。 */
export function loadReviews(stateDir) {
  if (!stateDir) return [];
  const file = reviewsFile(stateDir);
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const item = JSON.parse(text);
      if (item && typeof item.reviewId === 'string') out.push(item);
    } catch {
      // 坏行忽略
    }
  }
  return out;
}

/** 按 id 查一条；不存在返回 null（伪造 id 就落在这里）。 */
export function findReview(stateDir, reviewId) {
  if (!reviewId) return null;
  const all = loadReviews(stateDir);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].reviewId === reviewId) return all[i];
  }
  return null;
}

/** 这个 id 的覆盖范围里是否包含 path（按前缀判断，Windows 不区分大小写）。 */
export function reviewCovers(review, path) {
  if (!review || !Array.isArray(review.paths) || !path) return false;
  const target = resolve(path);
  const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p);
  const t = norm(target);
  return review.paths.some(p => {
    const base = norm(resolve(p));
    return t === base || t.startsWith(base.endsWith('\\') || base.endsWith('/') ? base : base + (process.platform === 'win32' ? '\\' : '/'));
  });
}

/**
 * 轮转：保留最近 max 条 + 所有被 keep 引用的（票据上的 reviewId 不能因为轮转丢）。
 * 返回是否重写过文件。
 */
export function pruneReviews(stateDir, { max = 200, keep = new Set() } = {}) {
  const all = loadReviews(stateDir);
  if (all.length <= max) return false;
  const kept = [];
  const tail = all.slice(-max);
  const tailIds = new Set(tail.map(r => r.reviewId));
  for (const id of keep) {
    if (tailIds.has(id)) continue;
    const found = all.find(r => r.reviewId === id);
    if (found) kept.push(found);
  }
  // 硬上限：票据会长期保留，「被引用」集合会一直变大，光靠 max 就不再是实际上限（盲审反例）。
  const next = [...kept, ...tail].slice(-2000);
  const file = reviewsFile(stateDir);
  const tmp = file + '.tmp';
  writeFileSync(tmp, next.map(r => JSON.stringify(r)).join('\n') + '\n');
  renameSync(tmp, file);
  return true;
}
