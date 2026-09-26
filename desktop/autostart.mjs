import { app } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const linuxEntry = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'autostart', 'com.adgai.codexresetreminder.desktop');

export function autoStartEnabled() {
  if (process.platform === 'linux') return existsSync(linuxEntry());
  if (process.platform === 'win32') {
    // 兼容旧版无参数的启动项；新启动项只在托盘运行。
    return app.getLoginItemSettings({ args: ['--background'] }).openAtLogin
      || app.getLoginItemSettings().openAtLogin;
  }
  return app.getLoginItemSettings().openAtLogin;
}

export async function setAutoStart(enabled) {
  if (process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: enabled === true,
      ...(process.platform === 'win32' ? { args: ['--background'] } : {}) });
    return autoStartEnabled();
  }
  const entry = linuxEntry();
  if (!enabled) {
    try { await unlink(entry); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return false;
  }
  const executable = process.env.APPIMAGE || process.execPath;
  if (/[\r\n]/.test(executable)) throw new Error('应用路径不能写入开机启动项');
  const quoted = `"${executable.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  await mkdir(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart'), { recursive: true });
  await writeFile(entry, `[Desktop Entry]\nType=Application\nName=Codex Reset Reminder\nExec=${quoted} --background\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`, 'utf8');
  return true;
}
