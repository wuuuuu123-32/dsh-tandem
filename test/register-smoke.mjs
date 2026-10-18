/**
 * 注册冒烟测试：用假的 ctx 走一遍 apply，确认五个工具都能注册成功。
 *
 * 为什么必须有这一条：真机验证要重启 DSH（几十秒 + 打断用户），而 schema 写错
 * 时 register() 会抛错、插件整体失效。这个脚本把「值不值得重启」变成一条命令。
 */
import assert from 'node:assert/strict';

const registered = [];
const ctx = {
  tools: {
    register(tool) {
      assert.ok(tool && typeof tool.name === 'string' && tool.name, '工具必须有 name');
      assert.ok(tool.parameters && tool.parameters.type === 'object', `${tool.name} 的 parameters 必须是 object schema`);
      const required = tool.parameters.required || [];
      for (const key of required) {
        assert.ok(tool.parameters.properties && tool.parameters.properties[key], `${tool.name} 的必填项 ${key} 没在 properties 里`);
      }
      registered.push(tool.name);
      return () => {};
    },
  },
};

const mod = await import('../index.js');
assert.equal(typeof mod.apply, 'function', '插件必须导出 apply');
await mod.apply(ctx, {});

const want = ['tandem_status', 'tandem_delegate', 'tandem_consult', 'tandem_check', 'tandem_reject'];
assert.deepEqual(registered.slice().sort(), want.slice().sort(), `注册结果不符：${registered.join(', ')}`);
console.log('✅ 五个工具全部注册成功：' + registered.join(', '));
