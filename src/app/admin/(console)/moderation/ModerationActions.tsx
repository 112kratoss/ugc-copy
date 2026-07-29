'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, ShieldOff } from 'lucide-react';
import clsx from 'clsx';

import { Text } from '@/app/components/DesignSystem';

type PostAction = 'take_down' | 'dismiss';
type SubjectAction = 'resolve' | 'dismiss';

type Outcome = {
  status?: string;
  resolvedReportCount?: number;
  revokedMediaCount?: number;
  mediaRevocationVerified?: boolean;
  externalMediaRevocationRequired?: boolean;
  commentRemoved?: boolean;
};

/**
 * Raw JSON was unreadable under time pressure and buried the one line that
 * matters: `externalMediaRevocationRequired` means the incident is NOT closed —
 * a provider-hosted copy still needs revoking by hand.
 */
function describeOutcome(payload: Outcome): string {
  const parts: string[] = [];

  switch (payload.status) {
    case 'taken_down': parts.push('Post taken down and hidden from public surfaces.'); break;
    case 'dismissed': parts.push('Report dismissed. The content was left untouched.'); break;
    case 'resolved': parts.push('Report resolved.'); break;
    case 'already_resolved': parts.push('This report had already been resolved — nothing changed.'); break;
    default: parts.push('Decision recorded.');
  }

  if (payload.commentRemoved) {
    parts.push('The comment was soft-removed and reply counts repaired.');
  }
  if ((payload.resolvedReportCount ?? 0) > 1) {
    parts.push(`${payload.resolvedReportCount} duplicate reports for the same target were closed too.`);
  }
  if (payload.mediaRevocationVerified) {
    const count = payload.revokedMediaCount ?? 0;
    parts.push(
      count > 0
        ? `${count} stored media object${count === 1 ? '' : 's'} deleted and verified gone.`
        : 'No stored media needed deleting.',
    );
  }
  if (payload.externalMediaRevocationRequired) {
    parts.push(
      'ACTION STILL REQUIRED: this post also references provider-hosted media that '
      + 'this tool cannot delete. Revoke it at the provider and record that before closing the case.',
    );
  }

  return parts.join(' ');
}

function useDecision(endpoint: string) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function submit(body: Record<string, unknown>, label: string) {
    setPending(label);
    setError(null);
    setResult(null);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(typeof payload?.error === 'string' ? payload.error : 'Action failed.');
        return;
      }

      setResult(describeOutcome(payload));
      router.refresh();
    } catch {
      setError('Action failed. Check your connection and try again.');
    } finally {
      setPending(null);
    }
  }

  return { pending, error, result, submit };
}

export function PostReportActions({ reportId }: { reportId: string }) {
  const { pending, error, result, submit } = useDecision('/api/admin/moderation/post-reports');
  const [note, setNote] = useState('');

  function run(action: PostAction) {
    if (!note.trim()) return;
    submit({ reportId, action, note }, action);
  }

  return (
    <div className="mt-4 border-t border-[var(--ui-border-subtle)] pt-4">
      <label htmlFor={`note-${reportId}`}>
        <Text as="span" variant="label">Resolution note (required)</Text>
      </label>
      <textarea
        id={`note-${reportId}`}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        maxLength={1000}
        placeholder="Policy section and concise evidence summary"
        className="ui-focus-ring mt-1.5 w-full rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-3 py-2 text-sm text-[var(--ui-text-primary)] placeholder:text-[var(--ui-text-faint)]"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => run('take_down')}
          disabled={!note.trim() || pending !== null}
          className="ui-button ui-focus-ring bg-[rgba(255,124,139,0.14)] text-[var(--ui-accent-danger)] disabled:opacity-50"
        >
          <ShieldOff className="h-4 w-4" aria-hidden />
          {pending === 'take_down' ? 'Taking down…' : 'Take down'}
        </button>
        <button
          type="button"
          onClick={() => run('dismiss')}
          disabled={!note.trim() || pending !== null}
          className="ui-button ui-button-secondary ui-focus-ring disabled:opacity-50"
        >
          <Check className="h-4 w-4" aria-hidden />
          {pending === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
        </button>
        {!note.trim() ? <Text variant="caption">Add a note to enable actions</Text> : null}
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-sm font-semibold text-[var(--ui-accent-danger)]">{error}</p>
      ) : null}
      {result ? (
        <p
          role="status"
          className={clsx(
            'mt-2 rounded-xl px-3 py-2 text-sm font-semibold',
            result.includes('ACTION STILL REQUIRED')
              ? 'bg-[rgba(255,196,107,0.12)] text-[#ffc46b]'
              : 'bg-[rgba(94,233,164,0.10)] text-[#5ee9a4]',
          )}
        >
          {result}
        </p>
      ) : null}
    </div>
  );
}

export function SubjectReportActions({ reportId }: { reportId: string }) {
  const { pending, error, result, submit } = useDecision('/api/admin/moderation/subject-reports');
  const [note, setNote] = useState('');

  function run(action: SubjectAction) {
    if (!note.trim()) return;
    submit({ reportId, action, note }, action);
  }

  return (
    <div className="mt-4 border-t border-[var(--ui-border-subtle)] pt-4">
      <Text variant="caption">
        Complete any required manual safety action before resolving.
      </Text>

      <label htmlFor={`subject-note-${reportId}`} className="mt-3 block">
        <Text as="span" variant="label">Resolution note (required)</Text>
      </label>
      <textarea
        id={`subject-note-${reportId}`}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        maxLength={1000}
        placeholder="Policy section, evidence summary, and any external action taken"
        className="ui-focus-ring mt-1.5 w-full rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-3 py-2 text-sm text-[var(--ui-text-primary)] placeholder:text-[var(--ui-text-faint)]"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => run('resolve')}
          disabled={!note.trim() || pending !== null}
          className="ui-button ui-focus-ring bg-[rgba(255,124,139,0.14)] text-[var(--ui-accent-danger)] disabled:opacity-50"
        >
          <ShieldOff className="h-4 w-4" aria-hidden />
          {pending === 'resolve' ? 'Resolving…' : 'Resolve'}
        </button>
        <button
          type="button"
          onClick={() => run('dismiss')}
          disabled={!note.trim() || pending !== null}
          className="ui-button ui-button-secondary ui-focus-ring disabled:opacity-50"
        >
          <Check className="h-4 w-4" aria-hidden />
          {pending === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
        </button>
        {!note.trim() ? <Text variant="caption">Add a note to enable actions</Text> : null}
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-sm font-semibold text-[var(--ui-accent-danger)]">{error}</p>
      ) : null}
      {result ? (
        <p
          role="status"
          className={clsx(
            'mt-2 rounded-xl px-3 py-2 text-sm font-semibold',
            result.includes('ACTION STILL REQUIRED')
              ? 'bg-[rgba(255,196,107,0.12)] text-[#ffc46b]'
              : 'bg-[rgba(94,233,164,0.10)] text-[#5ee9a4]',
          )}
        >
          {result}
        </p>
      ) : null}
    </div>
  );
}
