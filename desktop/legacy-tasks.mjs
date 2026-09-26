import { spawnSync } from 'node:child_process';

export const legacyTasks = ['CodexResetCardSync', 'CodexResetCardExpiryReminder',
  'CodexResetCardNextReminder', 'CodexResetCardFeishuActions'];

const runTask = (args) => spawnSync('schtasks.exe', args,
  { encoding: 'utf8', timeout: 7000, windowsHide: true });

function taskState(name, run) {
  const result = run(['/Query', '/TN', name, '/XML']);
  if (result.status === 0) {
    return /<Enabled>\s*false\s*<\/Enabled>/i.test(result.stdout || '') ? 'disabled' : 'enabled';
  }
  const message = `${result.stderr || ''}\n${result.stdout || ''}`;
  if (/cannot find|does not exist|找不到|不存在|未找到/i.test(message)) return 'missing';
  return 'unknown';
}

// 只有确认旧任务已禁用或不存在，新版调度器才可以启动。
export function stopLegacyTasks(run = runTask) {
  const failures = [];
  for (const name of legacyTasks) {
    const state = taskState(name, run);
    if (state === 'missing') continue;
    if (state === 'unknown') { failures.push(name); continue; }
    if (state === 'enabled') {
      const changed = run(['/Change', '/TN', name, '/Disable']);
      if (changed.status !== 0 || taskState(name, run) !== 'disabled') {
        failures.push(name);
        continue;
      }
    }
    if (name === 'CodexResetCardFeishuActions') {
      // 禁用只阻止下次启动；当前监听任务也需要结束。
      run(['/End', '/TN', name]);
    }
  }
  return failures;
}
