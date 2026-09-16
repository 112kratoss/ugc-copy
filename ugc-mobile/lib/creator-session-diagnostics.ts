/**
 * What support needs to know about the last draft this launch opened, shown in
 * Settings above the version line (audit: "OTA and the reported iPhone issue").
 *
 * An OTA publish does not show that a phone applied it, and an applied update
 * does not show that an old saved draft was repaired. With this line, someone
 * reopening a draft can read off how it came back. It holds counts and
 * outcomes only: never a prompt, a link or who is signed in. It lives in memory
 * for this launch, because a check is "reopen the draft, then open Settings".
 */

export type CreatorRestoreOutcome = 'new' | 'resumed' | 'restored' | 'recovered' | 'restore_failed';

export type CreatorSessionDiagnostics = {
  tool: 'image' | 'video' | 'motion';
  outcome: CreatorRestoreOutcome;
  referenceCount: number;
  catalogRevision: string | null;
  /** How saved drafts are keyed on this build. */
  draftFormat: string;
};

let current: CreatorSessionDiagnostics | null = null;
const listeners = new Set<() => void>();

export function recordCreatorSession(session: CreatorSessionDiagnostics) {
  current = { ...session };
  for (const listener of listeners) listener();
}

export function readCreatorSession(): CreatorSessionDiagnostics | null {
  return current;
}

export function subscribeCreatorSession(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetCreatorSessionForTests() {
  current = null;
}

const OUTCOME_LABELS: Record<CreatorRestoreOutcome, string> = {
  new: 'started new',
  resumed: 'resumed',
  restored: 'restored from its source',
  recovered: 'repaired from its source',
  restore_failed: 'restore failed',
};

export function formatSupportDetails({
  runtimeVersion,
  channel,
  session,
}: {
  runtimeVersion: string | null;
  channel: string | null;
  session: CreatorSessionDiagnostics | null;
}): string | null {
  const parts = [
    runtimeVersion ? `runtime ${runtimeVersion}` : null,
    channel ? `channel ${channel}` : null,
    session
      ? `${session.tool} draft ${OUTCOME_LABELS[session.outcome]}, ${session.referenceCount} ${session.referenceCount === 1 ? 'reference' : 'references'}`
      : null,
    session?.catalogRevision ? `catalog ${session.catalogRevision}` : null,
    session ? `drafts ${session.draftFormat}` : null,
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return null;
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}
