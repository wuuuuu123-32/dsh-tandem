/**
 * 验证会审提的第 1 条反例：DENY_SEGMENT 是否真的挡不住 Windows 单反斜杠路径。
 * 这条若成立就是安全漏洞（凭据文件被发给第三方），必须实测而不是看正则像不像。
 */
import { collectMaterials } from '../lib/consult.js';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';

const root = 'D:/dsh/config/.tmp-deny-test';
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
mkdirSync(root + '/.ssh', { recursive: true });
mkdirSync(root + '/.git', { recursive: true });
mkdirSync(root + '/node_modules', { recursive: true });
mkdirSync(root + '/ok', { recursive: true });
writeFileSync(root + '/.ssh/id_rsa', 'PRIVATE KEY MATERIAL\n');
writeFileSync(root + '/.git/config', '[core]\n');
writeFileSync(root + '/node_modules/x.js', 'module\n');
writeFileSync(root + '/ok/fine.txt', 'hello\n');

// 三种写法：正斜杠 / 单反斜杠（Windows 原生）/ 双反斜杠
const variants = [
  root + '/.ssh/id_rsa',
  root.replace(/\//g, '\\') + '\\.ssh\\id_rsa',
  root.replace(/\//g, '\\\\') + '\\\\.ssh\\\\id_rsa',
  root + '/.git/config',
  root.replace(/\//g, '\\') + '\\.git\\config',
  root + '/node_modules/x.js',
  root.replace(/\//g, '\\') + '\\node_modules\\x.js',
];

const r = collectMaterials(variants, { roots: [root], base: root });
console.log('=== 被读进来的（危险，说明漏过了）');
for (const i of r.items) console.log('  LEAK  ' + i.path);
console.log('=== 被拒绝的');
for (const x of r.rejected) console.log('  ' + x.path.slice(-40) + '  →  ' + x.reason);
console.log('');
const leaked = r.items.length;
console.log(leaked === 0 ? 'PASS 七个路径全部被挡' : 'FAIL 有 ' + leaked + ' 个漏过');
rmSync(root, { recursive: true, force: true });
process.exit(leaked === 0 ? 0 : 1);
