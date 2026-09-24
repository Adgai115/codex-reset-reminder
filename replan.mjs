import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));

export function replanScheduledTask() {
  const result = spawnSync(process.env.CODEX_REMINDER_PWSH || 'pwsh.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', join(directory, 'schedule-next.ps1')],
    { windowsHide: true, stdio: 'ignore', timeout: 20000 });
  return !result.error && result.status === 0;
}
