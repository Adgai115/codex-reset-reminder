import { spawn } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function createMockCodex(directory) {
  const fixtures = join(import.meta.dirname, 'fixtures');
  if (process.platform !== 'win32') {
    const script = join(directory, 'mock-codex.mjs');
    await copyFile(join(fixtures, 'mock-codex.mjs'), script);
    return script;
  }
  const executable = join(directory, 'mock-codex.exe');
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; Add-Type -TypeDefinition (Get-Content -LiteralPath $env:CODEX_RESET_SMOKE_SOURCE -Raw -Encoding UTF8) -OutputAssembly $env:CODEX_RESET_SMOKE_EXE -OutputType ConsoleApplication'],
    { windowsHide: true, env: { ...process.env,
      CODEX_RESET_SMOKE_SOURCE: join(fixtures, 'mock-codex.cs'),
      CODEX_RESET_SMOKE_EXE: executable }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    // Windows 托管 runner 冷启动 PowerShell/.NET 时可能超过 30 秒；独立请求期限仍由调用方检查。
    const timer = setTimeout(() => { child.kill(); reject(new Error('编译模拟 Codex 超时')); }, 60000);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`编译模拟 Codex 失败：${output}`));
    });
  });
  return executable;
}
