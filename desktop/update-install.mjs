import { compareVersions } from './update-check.mjs';

// The updater owns the installer cache and verifies the SHA-512 value in latest.yml.
// Keep the install step separate so a normal application exit never starts an update.
export function createWindowsUpdater({ updater, currentVersion, emit = () => {} }) {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.disableDifferentialDownload = true;
  updater.allowPrerelease = currentVersion.includes('-');

  let state = { phase: 'idle', version: null, message: '' };
  let busy = false;
  const setState = (next) => { state = { ...state, ...next }; emit({ ...state }); return { ...state }; };
  updater.on('download-progress', (progress) => {
    if (state.phase !== 'downloading') return;
    const percent = Math.max(0, Math.min(100, Math.floor(Number(progress.percent) || 0)));
    setState({ percent, message: `下载中 ${percent}%` });
  });
  updater.on('error', (error) => {
    if (busy) return; // the awaited operation reports its own error
    setState({ phase: 'error', message: `更新失败：${error.message}` });
  });

  return {
    status: () => ({ ...state }),
    async check() {
      if (busy) throw new Error('更新操作正在进行');
      busy = true;
      setState({ phase: 'checking', version: null, percent: null, message: '正在检查更新…' });
      try {
        const result = await updater.checkForUpdates();
        const version = result?.updateInfo?.version;
        if (!version) throw new Error('发布信息不完整');
        const difference = compareVersions(version, currentVersion);
        if (difference <= 0) {
          setState({ phase: 'current', message: `当前已是最新版本（${currentVersion}）` });
          return { state: 'current', currentVersion, latestVersion: `v${version}`, message: state.message };
        }
        setState({ phase: 'available', version, message: `发现新版本 v${version}` });
        return { state: 'available', currentVersion, latestVersion: `v${version}`,
          canInstall: true, message: state.message };
      } catch (error) {
        setState({ phase: 'error', message: `检查失败：${error.message}` });
        throw error;
      } finally { busy = false; }
    },
    async download(version) {
      if (busy) throw new Error('更新操作正在进行');
      if (state.phase !== 'available' || state.version !== version) throw new Error('请先检查新版本');
      busy = true;
      setState({ phase: 'downloading', percent: 0, message: '准备下载…' });
      try {
        await updater.downloadUpdate();
        return setState({ phase: 'ready', percent: 100, message: `v${version} 已下载并校验，准备升级` });
      } catch (error) {
        setState({ phase: 'available', percent: null, message: `下载失败：${error.message}` });
        throw error;
      } finally { busy = false; }
    },
    install(version) {
      if (busy || state.phase !== 'ready' || state.version !== version) {
        throw new Error('请先完成下载和校验');
      }
      setState({ phase: 'installing', message: '正在启动原位升级…' });
      updater.quitAndInstall(true, true);
      if (state.phase === 'error') throw new Error(state.message);
    },
  };
}
