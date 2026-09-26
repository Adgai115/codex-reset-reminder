const releasesApi = 'https://api.github.com/repos/Adgai115/codex-reset-reminder/releases?per_page=20';
const releasesPage = 'https://github.com/Adgai115/codex-reset-reminder/releases';

function parseVersion(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(tag));
  return match ? { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.') || [] } : null;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error('版本号格式无效');
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return Math.sign(a.numbers[i] - b.numbers[i]);
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length - a.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    if (a.pre[i] === b.pre[i]) continue;
    const aNum = /^\d+$/.test(a.pre[i]);
    const bNum = /^\d+$/.test(b.pre[i]);
    if (aNum && bNum) return Math.sign(Number(a.pre[i]) - Number(b.pre[i]));
    if (aNum !== bNum) return aNum ? -1 : 1;
    return Math.sign(a.pre[i].localeCompare(b.pre[i], 'en'));
  }
  return 0;
}

export async function checkForUpdates(currentVersion, { fetcher = fetch } = {}) {
  const response = await fetcher(releasesApi, { headers: {
    Accept: 'application/vnd.github+json', 'User-Agent': `codex-reset-reminder/${currentVersion}`,
  }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`GitHub 更新检查失败（HTTP ${response.status}）`);
  const releases = await response.json();
  if (!Array.isArray(releases)) throw new Error('GitHub 返回的版本列表无效');
  const versions = releases.filter((item) => !item.draft && parseVersion(item.tag_name));
  versions.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  const latest = versions[0];
  if (!latest) return { state: 'none', currentVersion, message: '暂时没有公开发布的版本。' };
  const newer = compareVersions(latest.tag_name, currentVersion) > 0;
  return { state: newer ? 'available' : 'current', currentVersion,
    latestVersion: latest.tag_name,
    message: newer ? `发现新版本 ${latest.tag_name}，可前往 GitHub 下载。`
      : `当前已是最新公开版本（${currentVersion}）。` };
}

export function releasePageFor(tag) {
  if (!parseVersion(tag)) throw new Error('版本号格式无效');
  return `${releasesPage}/tag/${encodeURIComponent(tag)}`;
}
