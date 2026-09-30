export function mergeReminderItems(previous, incoming, nowSeconds = Math.floor(Date.now() / 1000)) {
  const byId = new Map();
  for (const item of [...previous, ...incoming]) {
    if (typeof item.creditId !== 'string' || !item.creditId || !Number.isInteger(item.expiresAt)
      || item.expiresAt <= nowSeconds) continue;
    const old = byId.get(item.creditId);
    if (old?.expiresAt === item.expiresAt && old.nodeAt > item.nodeAt) continue;
    byId.set(item.creditId, item);
  }
  return [...byId.values()].sort((a, b) => a.expiresAt - b.expiresAt || a.creditId.localeCompare(b.creditId));
}

export function reminderStillActive(item, snapshot, nowSeconds = Math.floor(Date.now() / 1000)) {
  const account = snapshot.accounts?.find((scope) => scope.scopeId === item.accountScopeId) || snapshot.account;
  if (account?.state !== 'verified' || account.remindersEnabled === false) return false;
  const card = snapshot.cards.find((candidate) => candidate.id === item.creditId);
  if (!card || card.status !== 'available' || card.expiresAt !== item.expiresAt || card.expiresAt <= nowSeconds) return false;
  const snooze = card.snooze?.expiresAt === card.expiresAt ? card.snooze : null;
  if (item.nodeKind === 'snooze') return snooze?.targetAt === item.nodeAt;
  return !snooze || snooze.targetAt < item.nodeAt;
}
