/**
 * A run's completion push reaching the app while it is in front
 * (`generation_succeeded` or `generation_failed`, read off the push by the root
 * layout). Whatever is waiting to read a run's status again reads it now rather
 * than at the end of its wait: the creator watching a run, whose waits grow to
 * 30 s (`pollGenerationStatus`). The push does not say which run ended, so each
 * listener reads its own and goes on waiting if that one is still working.
 *
 * Kept free of React Native and Expo imports, so the creator's polling and its
 * tests take it without the notification module behind it.
 */

const GENERATION_SETTLED_PUSH_TYPES: ReadonlySet<string> = new Set(['generation_succeeded', 'generation_failed']);

const listeners = new Set<() => void>();

export function isGenerationSettledPush(type: string | null | undefined): boolean {
  return typeof type === 'string' && GENERATION_SETTLED_PUSH_TYPES.has(type);
}

export function announceGenerationSettledPush() {
  for (const listener of [...listeners]) listener();
}

/** Calls `listener` at each completion push until the returned function is called. */
export function subscribeToGenerationSettledPush(listener: () => void) {
  const entry = () => listener();
  listeners.add(entry);
  return () => {
    listeners.delete(entry);
  };
}
