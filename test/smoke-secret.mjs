// 凭据黑名单的实测。每一项都真的在临时目录里造出文件再交给 collectMaterials，
// 不是只正则匹配字符串 —— 那样测不出「Windows 会忽略尾点，所以 key.pem. 等价于 key.pem」。
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { collectMaterials } from '../lib/consult.js';

const root = 'D:/dsh/config/.tmp-secret-test';
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const secrets = [
  '.env', '.env.local', '.envrc', '.npmrc', '.netrc', '.pypirc', '.pgpass',
  '.git-credentials', 'credentials', 'credentials.yaml', 'auth.json',
  'id_rsa', 'id_ecdsa', 'id_dsa', 'id_ed25519', 'key.pem', 'cert.p8',
  'my.jks', 'store.ppk', 'app.tfstate', 'terraform.tfvars', 'kubeconfig',
  'service-account-prod.json', 'secrets.yaml', 'secret.json',
  // ❗第 6 轮会审 portdan 的反例：凭据名 + 下载标记流。原来 `:Zone.Identifier`
  // 直接 return false，等于给所有凭据名开了一条 ADS 后门。
  'prod.env:Zone.Identifier',
];
const allowed = ['normal.js', 'README.md', 'data.json', 'notes.txt',
  // ❗普通文件的 NTFS 下载标记流必须放行：浏览器/资源管理器给「从网络下载来的文件」
  // 自动加这个元数据流，它出现在任何一个正常文件名后面。挡掉它 = 误杀正常材料
  //（会审 opus 指出：原来只测了凭据文件，没测这种普通文件）。
  'README.md:Zone.Identifier'];

const dot = join(root, 'key.pem.');
const short = join(root, 'CREDEN~1.YAM');
for (const f of [...secrets, ...allowed]) writeFileSync(join(root, f), 'AKIA-very-secret-value');
writeFileSync(dot, 'AKIA-very-secret-value');
writeFileSync(short, 'AKIA-very-secret-value');
mkdirSync(join(root, '.aws'), { recursive: true });
writeFileSync(join(root, '.aws', 'credentials'), 'AKIA-very-secret-value');
mkdirSync(join(root, '.docker'), { recursive: true });
writeFileSync(join(root, '.docker', 'config.json'), '{"auths":{}}');

let bad = 0;
const check = (path, wantReject, label) => {
  const r = collectMaterials([path], { roots: [root], base: root });
  const rejected = r.rejected.length > 0;
  const ok = rejected === wantReject;
  if (!ok) bad++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + ' → ' + (rejected ? '拒绝（' + r.rejected[0].reason + '）' : '读入 ' + (r.items[0] ? r.items[0].bytes : 0) + 'B'));
};

for (const f of secrets) check(f, true, f);
check('key.pem.', true, 'key.pem. （Win32 会忽略尾点）');
check('CREDEN~1.YAM', true, 'CREDEN~1.YAM （8.3 短名）');
check('.aws/credentials', true, '.aws/credentials');
check('.docker/config.json', true, '.docker/config.json');
for (const f of allowed) check(f, false, f);

rmSync(root, { recursive: true, force: true });
console.log(bad ? '\n有 ' + bad + ' 条不符' : '\n全部符合');
process.exit(bad ? 1 : 0);
