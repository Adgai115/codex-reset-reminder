import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoSync } from './auto-sync.mjs';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(run) {
  let now = 0;
  let id = 0;
  const timers = new Map();
  const reasons = [];
  const errors = [];
  const sync = createAutoSync({ run, now: () => now,
    setTimer: (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id; },
    clearTimer: (key) => timers.delete(key), onSettled: (reason) => reasons.push(reason),
    onError: (error) => errors.push(error.message) });
  return { sync, timers, reasons, errors,
    async advance(ms) {
      now += ms;
      for (const [key, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(key); timer.fn(); }
      }
      await flush();
    } };
}

test('自动同步启动即执行，成功后每十五分钟执行，托盘运行不依赖页面', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { complete: true }; });
  f.sync.start(); f.sync.start(); await flush();
  assert.equal(calls, 1);
  assert.equal(f.sync.state().nextSyncAt, 900);
  await f.advance(899_999); assert.equal(calls, 1);
  await f.advance(1); assert.equal(calls, 2);
  assert.deepEqual(f.reasons, ['startup', 'automatic']);
  f.sync.stop(); await f.advance(900_000); assert.equal(calls, 2);
});

test('失败和不完整结果按1/5/15分钟恢复，持续故障保持十五分钟间隔，成功重置', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    if (calls === 1) throw new Error('ACCOUNT_UNAVAILABLE');
    return { complete: calls >= 5 };
  });
  f.sync.start(); await flush();
  assert.deepEqual(f.errors, ['ACCOUNT_UNAVAILABLE']);
  assert.equal(f.sync.state().nextSyncAt, 60);
  await f.advance(60_000); assert.equal(f.sync.state().nextSyncAt, 360);
  await f.advance(300_000); assert.equal(f.sync.state().nextSyncAt, 1260);
  await f.advance(900_000); assert.equal(f.sync.state().nextSyncAt, 2160);
  await f.advance(900_000);
  assert.equal(f.sync.state().recovering, false);
  assert.equal(f.sync.state().nextSyncAt, 3060);
  f.sync.stop();
});

test('手动刷新、恢复与自动同步合并在途请求，重复唤醒不会积压', async () => {
  let calls = 0;
  let finish;
  const f = fixture(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  f.sync.start(); await flush();
  const pending = f.sync.sync();
  await f.advance(120_000); f.sync.wake(); f.sync.wake();
  assert.equal(f.sync.sync(), pending);
  assert.equal(calls, 1);
  finish({ complete: true }); await pending;
  assert.equal(f.timers.size, 1);
  await f.advance(60_000); f.sync.wake(); await flush();
  assert.equal(calls, 2);
  f.sync.wake(); await flush(); assert.equal(calls, 2);
  finish({ complete: true }); await flush(); f.sync.stop();
});

test('退出期间在途同步完成不再登记计时器或触发提醒', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.sync.start(); await flush(); f.sync.stop();
  finish({ complete: true }); await flush();
  assert.equal(f.timers.size, 0);
  assert.equal(f.sync.state().nextSyncAt, null);
  assert.deepEqual(f.reasons, []);
  assert.equal(await f.sync.sync(), null);
});
