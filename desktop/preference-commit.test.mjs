import test from 'node:test';
import assert from 'node:assert/strict';
import { commitPreferences } from './preference-commit.mjs';

test('自启失败时不写入提醒配置', async () => {
  let written = false;
  await assert.rejects(commitPreferences({ previousAutoStart: false, nextAutoStart: true,
    setAutoStart: async () => { throw new Error('权限不足'); }, write: async () => { written = true; } }), /权限不足/);
  assert.equal(written, false);
});
test('配置写入失败会恢复系统自启，未修改自启时不重设系统项', async () => {
  let enabled = false;
  await assert.rejects(commitPreferences({ previousAutoStart: false, nextAutoStart: true,
    setAutoStart: async (value) => (enabled = value), write: async () => { throw new Error('磁盘不可写'); } }), /磁盘不可写/);
  assert.equal(enabled, false);
  let writes = 0;
  await commitPreferences({ previousAutoStart: false, nextAutoStart: false,
    setAutoStart: async () => { throw new Error('不应调用'); }, write: async () => { writes++; } });
  assert.equal(writes, 1);
});
test('系统拒绝自启变更时不会假报保存成功', async () => {
  await assert.rejects(commitPreferences({ previousAutoStart: false, nextAutoStart: true,
    setAutoStart: async () => false, write: async () => assert.fail('不应保存') }), /尚未接受/);
});
