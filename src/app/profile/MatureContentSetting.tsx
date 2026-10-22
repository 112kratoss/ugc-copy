'use client';

import { useEffect, useState } from 'react';
import { EyeOff, Loader2, RefreshCw } from 'lucide-react';

import type { ConfirmationRequest } from '@/components/feedback-state';
import { useConfirmation } from '@/components/useConfirmation';

type PreferenceState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; showMature: boolean };

const TURN_ON_QUESTION: ConfirmationRequest = {
  title: 'Turn on mature content?',
  message: 'Confirm that you are 18 or older. NSFW posts stay covered until you choose to reveal one.',
  confirmLabel: 'I’m 18 or older',
  cancelLabel: 'Not now',
};

/**
 * The account's mature-content preference as a settings row, so it can be
 * turned off without first finding an NSFW post. Turning it on shows nothing
 * by itself: every NSFW post stays covered until it is revealed, one at a
 * time. Either change clears the reveals already made (the route does it).
 * The route takes the change from the website's own cookie session only, so
 * no bearer token is sent.
 */
export default function MatureContentSetting() {
  const [preference, setPreference] = useState<PreferenceState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const askToConfirm = useConfirmation();

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/content-preferences', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as { showMature?: unknown } | null;
        if (!response.ok || typeof body?.showMature !== 'boolean') throw new Error('Unreadable preference');
        setPreference({ status: 'ready', showMature: body.showMature });
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreference({ status: 'failed' });
      });
    return () => controller.abort();
  }, [attempt]);

  const retry = () => {
    setPreference({ status: 'loading' });
    setAttempt((current) => current + 1);
  };

  const changePreference = async (showMature: boolean) => {
    if (preference.status !== 'ready' || isSaving) return;
    if (showMature && !(await askToConfirm(TURN_ON_QUESTION))) return;

    setIsSaving(true);
    setSaveError(null);
    try {
      const response = await fetch('/api/content-preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(showMature ? { showMature: true, confirmAdult: true } : { showMature: false }),
      });
      const body = await response.json().catch(() => null) as { showMature?: unknown; error?: unknown } | null;
      if (!response.ok) {
        throw new Error(typeof body?.error === 'string' && body.error ? body.error : 'Could not change mature content. Please retry.');
      }
      setPreference({ status: 'ready', showMature: body?.showMature === true });
    } catch (error) {
      setSaveError(error instanceof Error && error.message ? error.message : 'Could not change mature content. Please retry.');
    } finally {
      setIsSaving(false);
    }
  };

  const isOn = preference.status === 'ready' && preference.showMature;
  const detail = preference.status === 'loading'
    ? 'Loading your setting…'
    : preference.status === 'failed'
      ? 'Your setting did not load.'
      : isOn
        ? 'On. NSFW posts stay covered until you reveal one.'
        : 'Off. NSFW posts stay hidden; turn on (18+) to reveal one at a time.';

  return (
    <div className="col-span-2 flex min-h-14 items-center gap-3 rounded-[20px] border border-white/8 bg-[var(--ui-surface-1)] px-4 py-3 lg:col-span-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.05] text-zinc-300"><EyeOff className="h-4 w-4" aria-hidden /></span>
      <span className="min-w-0 flex-1">
        <span id="mature-content-label" className="block text-sm font-bold text-white">Mature content</span>
        <span id="mature-content-detail" className="mt-0.5 block text-xs text-zinc-500">{detail}</span>
        {saveError ? <span role="alert" className="mt-1 block text-xs text-rose-300">{saveError}</span> : null}
      </span>
      {preference.status === 'failed' ? (
        <button
          type="button"
          onClick={retry}
          className="ui-focus-ring inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 text-sm font-bold text-zinc-100 transition hover:bg-white/10"
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          Retry
        </button>
      ) : (
        <button
          type="button"
          role="switch"
          aria-checked={isOn}
          aria-labelledby="mature-content-label"
          aria-describedby="mature-content-detail"
          aria-busy={preference.status === 'loading' || isSaving || undefined}
          disabled={preference.status !== 'ready' || isSaving}
          onClick={() => void changePreference(!isOn)}
          className="ui-focus-ring inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full px-1 text-sm font-bold text-zinc-100 disabled:opacity-60"
        >
          <span aria-hidden className="w-7 text-right">{isOn ? 'On' : 'Off'}</span>
          <span
            aria-hidden
            className={`relative inline-flex h-6 w-11 items-center rounded-full border transition ${isOn
              ? 'border-transparent bg-[var(--ui-primary)]'
              : 'border-white/15 bg-white/[0.08]'}`}
          >
            {isSaving || preference.status === 'loading'
              ? <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin text-white" />
              : <span className={`absolute h-4 w-4 rounded-full bg-white shadow transition-transform ${isOn ? 'translate-x-6' : 'translate-x-1'}`} />}
          </span>
        </button>
      )}
    </div>
  );
}
