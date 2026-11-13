// checkMaterialFreshness 的实测：材料注入的字节 vs 此刻磁盘上的字节。
// 起因（第 16 轮会审 portdan）：`fingerprintPaths` 记的是「调用方声称读完材料那一刻」，
// 它与「真的注入了什么字节」之间还隔着一次读取。sha 是 collectMaterials 对**同一段字节**算的，
// 签发前再读一次比对，才能钉死「凭证记的版本 = judge 看过的版本」。
import { mkdirSync, writeFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { collectMaterials, checkMaterialFreshness } from '../lib/consult.js';

const root = 'D:/dsh/config/.tmp-fresh-test';
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const A = root + '/a.js';
writeFileSync(A, 'export const a = 1;\n');

let bad = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + ' → ' + JSON.stringify(got));
};

const mats = collectMaterials([A], { roots: [root], base: root });
t('刚读完、没动过 → 新鲜', checkMaterialFreshness([A], mats), { ok: true, changed: [] });

// 内容变了 → 不新鲜
writeFileSync(A, 'export const a = 2;\n');
const after = checkMaterialFreshness([A], mats);
t('内容被改 → 不新鲜', { ok: after.ok, n: after.changed.length }, { ok: false, n: 1 });

// 追加一行也算变了
const mats2 = collectMaterials([A], { roots: [root], base: root });
appendFileSync(A, '// tail\n');
t('被追加一行 → 不新鲜', checkMaterialFreshness([A], mats2).ok, false);

// 只有 mtime 变、内容不变 → 仍然新鲜（sha 比的是字节，不是时间戳）
const mats3 = collectMaterials([A], { roots: [root], base: root });
writeFileSync(A, 'export const a = 2;\n// tail\n');
t('内容未变（重写同一份）→ 仍然新鲜', checkMaterialFreshness([A], mats3).ok, true);

// 被截断的文件只比前 bytes 个字节：尾巴变了不影响
const big = root + '/big.js';
writeFileSync(big, 'x'.repeat(70000));
const mats4 = collectMaterials([big], { roots: [root], base: root });
const trunc = !!(mats4.items[0] && mats4.items[0].truncated);
if (!trunc) { bad++; console.log('FAIL  前提：big.js 应被截断'); }
writeFileSync(big, 'x'.repeat(61440) + 'y'.repeat(10000));
t('截断文件的截断区之后变了 → 仍算新鲜（只承诺前 bytes 字节）', checkMaterialFreshness([big], mats4).ok, true);

// diff 覆盖的文件没有 sha → 跳过，不算变化
t('没有材料项 → 视为新鲜（不误报）', checkMaterialFreshness([A], null).ok, true);

rmSync(root, { recursive: true, force: true });
console.log(bad ? '\n有 ' + bad + ' 条不符' : '\n全部符合');
process.exit(bad ? 1 : 0);
