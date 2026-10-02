import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, [join(dirname(fileURLToPath(import.meta.url)), 'main.mjs'), ...process.argv.slice(2)], {
  // This is the interactive authorization window, rather than a background helper.
  env, windowsHide: false, stdio: 'inherit',
});
child.on('error', () => { process.stderr.write('无法启动微信直连验证工具。\n'); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
