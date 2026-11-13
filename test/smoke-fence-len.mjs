// 材料围栏不能被文件内容提前闭合。
// 这不是理论风险：本次被审的 diff 里就含 ```json 字样，而材料原文原来就是用 ``` 包的。
// 围栏一旦被提前闭合，文件后半段就会被 judge 当成 prompt 指令读 —— 等于让人自己给自己发通行证。
import { renderMaterials } from '../lib/consult.js';

let bad = 0;
const render = text => renderMaterials({
  items: [{ path: 'x.js', text, bytes: String(text).length, truncated: false }],
  rejected: [],
});
const report = (name, pass, detail) => {
  if (!pass) bad++;
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name);
  if (!pass && detail) console.log('        ' + detail);
};

// 开围栏 = 紧跟在 "=== x.js ===" 标题行之后的那一行
const openFence = out => {
  const lines = out.split('\n');
  const i = lines.findIndex(l => l.startsWith('=== '));
  const m = i >= 0 ? (lines[i + 1] || '').match(/^(`{3,})$/) : null;
  return m ? m[1].length : 0;
};

// ① 普通内容：3 个反引号就够
{
  const out = render('const a = 1;');
  report('普通内容用 3 个反引号', openFence(out) === 3, 'n=' + openFence(out));
}

// ② 内容含 ```json 与单独一行 ```：围栏必须比内容里最长的连续反引号还长（否则提前闭合）
{
  const text = '```json\n{"a":1}\n```';
  const out = render(text);
  const longest = Math.max(...[...text.matchAll(/`{3,}/g)].map(m => m[0].length));
  report('内容含 ``` 围栏 → 开围栏 ' + openFence(out) + ' > 内容最长 ' + longest,
    openFence(out) > longest, '提前闭合了');
}

// ③ 内容含 5 个反引号：围栏要至少 6
{
  const text = 'a ````` b';
  const out = render(text);
  report('内容含 5 个反引号 → 开围栏 ≥6', openFence(out) >= 6, 'n=' + openFence(out));
}

// ④ 内容本身是一整段围栏（最坏情况）
{
  const text = '````\ninner\n````';
  const out = render(text);
  report('内容本身是 4 反引号围栏 → 开围栏 >4', openFence(out) > 4, 'n=' + openFence(out));
}

// ⑤ 没有材料时不产生任何输出
{
  const out = renderMaterials({ items: [], rejected: [] });
  report('没有材料 → 空串', out === '', JSON.stringify(out));
}

console.log(bad ? '\n有 ' + bad + ' 条不符' : '\n全部符合');
process.exit(bad ? 1 : 0);
