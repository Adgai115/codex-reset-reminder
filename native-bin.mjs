import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function codexCommand(codexScript) {
  if (process.platform !== 'win32') return { executable: process.execPath, prefix: [codexScript] };
  const packageRoot = dirname(dirname(resolve(codexScript)));
  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const platformPackage = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
  const candidates = [
    join(packageRoot, 'node_modules', '@openai', platformPackage, 'vendor', target, 'bin', 'codex.exe'),
    join(packageRoot, 'vendor', target, 'bin', 'codex.exe'),
  ];
  const executable = candidates.find(existsSync);
  if (!executable) throw new Error('找不到 Codex 原生程序；请重新安装 Codex CLI');
  const env = { ...process.env, CODEX_MANAGED_PACKAGE_ROOT: packageRoot };
  for (const name of ['CODEX_MANAGED_BY_NPM', 'CODEX_MANAGED_BY_BUN',
    'CODEX_MANAGED_BY_PNPM', 'CODEX_MANAGED_BY_VITE_PLUS']) delete env[name];
  env.CODEX_MANAGED_BY_NPM = '1';
  return { executable, prefix: [], env };
}

export function larkCommand(config) {
  if (!config.larkCliScript) throw new Error('未配置本机 lark-cli 路径');
  if (process.platform !== 'win32') {
    if (!config.nodePath) throw new Error('未配置 Node.js 路径');
    return { executable: config.nodePath, prefix: [config.larkCliScript] };
  }
  const packageRoot = dirname(dirname(resolve(config.larkCliScript)));
  const executable = join(packageRoot, 'bin', 'lark-cli.exe');
  if (!existsSync(executable)) throw new Error('找不到飞书 CLI 原生程序；请重新安装 lark-cli');
  return { executable, prefix: [] };
}
