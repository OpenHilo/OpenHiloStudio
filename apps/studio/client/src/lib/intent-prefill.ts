/** History stores entry names; the library exposes names qualified by namespace. */
export function resolveIntentPrefill<T extends { name: string }>(intents: readonly T[], hint: string): T | undefined {
  const exact = intents.filter(intent => intent.name === hint);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1 || hint.includes('.')) return undefined;
  const matches = intents.filter(intent => intent.name.split('.').pop() === hint);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Match the host's explicit path identities; a basename alone is not a workflow identity. */
export function resolveRetryIntent<T extends { ittPath: string; relativeIttPath?: string }>(intents: readonly T[], hint: string): T | undefined {
  const exact = intents.filter(intent => intent.ittPath === hint);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  if (!hint || hint.startsWith('/') || /^[A-Za-z]:/.test(hint) || hint.split('/').includes('..')) return undefined;
  const relative = hint.split('/').filter(part => part && part !== '.').join('/');
  const matches = intents.filter(intent => intent.relativeIttPath === relative);
  return matches.length === 1 ? matches[0] : undefined;
}
