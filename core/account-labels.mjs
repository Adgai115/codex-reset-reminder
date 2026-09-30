const baseLabel = (scope) => scope.nickname || scope.displayName || 'Codex 账号';

// 相同脱敏邮箱、同邮箱工作区或相同昵称仍须有可辨认的账号归属。
export function accountDisplayLabels(scopes) {
  const groups = new Map();
  for (const scope of scopes) {
    const base = baseLabel(scope);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(scope);
  }
  const labels = new Map();
  for (const [base, group] of groups) {
    if (group.length === 1) { labels.set(group[0].scopeId, base); continue; }
    for (const scope of group) {
      let width = 6;
      while (group.some((other) => other.scopeId !== scope.scopeId
        && other.scopeId.slice(-width) === scope.scopeId.slice(-width))) width += 2;
      labels.set(scope.scopeId, `${base} · ${scope.scopeId.slice(-width)}`);
    }
  }
  return labels;
}
