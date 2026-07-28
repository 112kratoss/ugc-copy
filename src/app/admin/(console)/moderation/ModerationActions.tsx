'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, ShieldOff } from 'lucide-react';

import { Text } from '@/app/components/DesignSystem';

type PostAction = 'take_down' | 'dismiss';
type SubjectAction = 'resolve' | 'dismiss';

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

      // Surfaced verbatim: `externalMediaRevocationRequired` means the operator
      // still has provider-side work to do before the incident can be closed.
      setResult(JSON.stringify(payload));
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
        <pre className="mt-2 overflow-x-auto rounded-xl bg-[var(--ui-surface-inset)] p-3 font-mono text-[11px] text-[var(--ui-text-muted)]">
          {result}
        </pre>
      ) : null}
    </div>
  );
}

export function SubjectReportActions({ reportId }: { reportId: string }) {
  const { pending, error, result, submit } = useDecision('/api/admin/moderation/subject-reports');

  function run(action: SubjectAction) {
    submit({ reportId, action }, action);
  }

  return (
    <div className="mt-4 border-t border-[var(--ui-border-subtle)] pt-4">
      <Text variant="caption">
        Complete any required manual safety action before resolving.
      </Text>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => run('resolve')}
          disabled={pending !== null}
          className="ui-button ui-focus-ring bg-[rgba(255,124,139,0.14)] text-[var(--ui-accent-danger)] disabled:opacity-50"
        >
          <ShieldOff className="h-4 w-4" aria-hidden />
          {pending === 'resolve' ? 'Resolving…' : 'Resolve'}
        </button>
        <button
          type="button"
          onClick={() => run('dismiss')}
          disabled={pending !== null}
          className="ui-button ui-button-secondary ui-focus-ring disabled:opacity-50"
        >
          <Check className="h-4 w-4" aria-hidden />
          {pending === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-sm font-semibold text-[var(--ui-accent-danger)]">{error}</p>
      ) : null}
      {result ? (
        <pre className="mt-2 overflow-x-auto rounded-xl bg-[var(--ui-surface-inset)] p-3 font-mono text-[11px] text-[var(--ui-text-muted)]">
          {result}
        </pre>
      ) : null}
    </div>
  );
}
