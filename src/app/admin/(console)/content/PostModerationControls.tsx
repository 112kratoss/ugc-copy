'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { EyeOff, RotateCcw, ShieldOff } from 'lucide-react';
import clsx from 'clsx';

import { Text } from '@/app/components/DesignSystem';

type Action = 'hide' | 'take_down' | 'restore';

type Outcome = {
  status?: string;
  action?: string;
  postReviewStatus?: string;
  resolvedReportCount?: number;
  affectedBundleCount?: number;
  affectedAssetCount?: number;
  revokedMediaCount?: number;
  mediaRevocationVerified?: boolean;
  externalMediaRevocationRequired?: boolean;
};

/**
 * The two removal actions are deliberately not styled alike.
 *
 * `hide` is a provisional call an operator can walk back; `take_down` destroys
 * the creator's media and cannot be undone. Presenting them as a matched pair
 * of buttons would invite reaching for the destructive one out of habit, so
 * take-down carries the danger treatment and spells out its finality in the
 * confirmation step.
 */
const ACTIONS: Record<Action, {
  label: string;
  confirmLabel: string;
  placeholder: string;
  caution?: string;
  danger?: boolean;
  Icon: typeof EyeOff;
}> = {
  hide: {
    label: 'Hide',
    confirmLabel: 'Confirm hide',
    placeholder: 'What you saw, and what still needs checking',
    caution: 'Reversible. The post leaves public surfaces but its media is kept, '
      + 'so it can be restored. Any open report stays in the queue awaiting your verdict.',
    Icon: EyeOff,
  },
  take_down: {
    label: 'Take down',
    confirmLabel: 'Permanently take down',
    placeholder: 'Policy section, or the legal/DMCA reference',
    caution: 'IRREVERSIBLE. This deletes the stored media outright — the post can never '
      + 'be restored afterwards. Use Hide unless the content must be destroyed.',
    danger: true,
    Icon: ShieldOff,
  },
  restore: {
    label: 'Restore',
    confirmLabel: 'Confirm restore',
    placeholder: 'Why the post is being returned to public view',
    caution: 'Returns the post and the paid surfaces this console pulled down. '
      + 'A post whose media was destroyed by a take-down cannot be restored.',
    Icon: RotateCcw,
  },
};

/** Raw JSON buries the one line that matters when an operator is under time pressure. */
function describeOutcome(payload: Outcome): string {
  const parts: string[] = [];

  if (payload.status === 'already_applied') {
    parts.push('Already applied — this submission had already been recorded, so nothing changed.');
  } else {
    switch (payload.action) {
      case 'hide': parts.push('Post hidden from public surfaces.'); break;
      case 'take_down': parts.push('Post taken down.'); break;
      case 'restore':
        parts.push(
          payload.postReviewStatus === 'flagged'
            ? 'Post restored, and flagged because it still has an open report.'
            : 'Post restored to public view.',
        );
        break;
      default: parts.push('Action recorded.');
    }
  }

  const surfaces = (payload.affectedBundleCount ?? 0) + (payload.affectedAssetCount ?? 0);
  if (surfaces > 0) {
    parts.push(`${surfaces} paid surface${surfaces === 1 ? '' : 's'} moved with it.`);
  }
  if ((payload.resolvedReportCount ?? 0) > 0) {
    parts.push(`${payload.resolvedReportCount} open report${payload.resolvedReportCount === 1 ? '' : 's'} closed.`);
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
      + 'this tool cannot delete. Revoke it at the provider before closing the case.',
    );
  }

  return parts.join(' ');
}

export function PostModerationControls({
  postId,
  reviewStatus,
}: {
  postId: string;
  reviewStatus: string;
}) {
  const router = useRouter();
  const fieldId = useId();
  const [selected, setSelected] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  /**
   * Held across retries of an uncertain submit so a dropped connection cannot
   * apply the action twice, and regenerated only once an attempt is known to
   * have landed. Same reasoning as CreditAdjustmentForm.
   */
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());

  const isHidden = reviewStatus === 'hidden';
  const offered: Action[] = isHidden ? ['restore', 'take_down'] : ['hide', 'take_down'];
  const reasonValid = reason.trim().length >= 3;

  function choose(action: Action) {
    setSelected((current) => (current === action ? null : action));
    setError(null);
    setResult(null);
  }

  async function submit() {
    if (!selected || !reasonValid || submitting) return;

    setSubmitting(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch('/api/admin/moderation/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId, action: selected, reason, idempotencyKey: submissionId }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        // The server answered, so this attempt definitively did not apply.
        setSubmissionId(crypto.randomUUID());
        setError(typeof payload?.error === 'string' ? payload.error : 'Action failed.');
        return;
      }

      setResult(describeOutcome(payload));
      setSubmissionId(crypto.randomUUID());
      setSelected(null);
      setReason('');
      router.refresh();
    } catch {
      // Deliberately keeps the current submissionId: the request may have
      // reached the database before the connection dropped, so retrying with
      // the same id is what makes a second attempt safe.
      setError(
        'Action failed — it may or may not have applied. Retrying is safe: this '
        + 'submission can only be recorded once. Reload to confirm the post state.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  const config = selected ? ACTIONS[selected] : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {offered.map((action) => {
          const { label, Icon, danger } = ACTIONS[action];
          return (
            <button
              key={action}
              type="button"
              aria-pressed={selected === action}
              onClick={() => choose(action)}
              className={clsx(
                'ui-button ui-focus-ring inline-flex items-center gap-1 whitespace-nowrap',
                selected === action ? 'ui-button-primary' : 'ui-button-secondary',
                danger && selected !== action && 'text-[var(--ui-accent-danger)]',
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </button>
          );
        })}
      </div>

      {config ? (
        <div className="w-[320px] rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] p-3">
          <Text
            variant="caption"
            className={clsx('block', config.danger && 'font-semibold text-[var(--ui-accent-danger)]')}
          >
            {config.caution}
          </Text>

          <label htmlFor={`${fieldId}-reason`} className="mt-2 block">
            <Text as="span" variant="label">Reason (required)</Text>
          </label>
          <textarea
            id={`${fieldId}-reason`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            maxLength={1000}
            placeholder={config.placeholder}
            className="ui-focus-ring mt-1 w-full rounded-lg border border-[var(--ui-border-default)] bg-[var(--ui-surface-default)] px-2.5 py-1.5 text-sm text-[var(--ui-text-primary)] placeholder:text-[var(--ui-text-faint)]"
          />

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={!reasonValid || submitting}
              className={clsx(
                'ui-button ui-focus-ring disabled:opacity-50',
                config.danger ? 'ui-button-primary text-[var(--ui-accent-danger)]' : 'ui-button-primary',
              )}
            >
              {submitting ? 'Applying…' : config.confirmLabel}
            </button>
            <button
              type="button"
              onClick={() => { setSelected(null); setReason(''); }}
              className="ui-button ui-button-ghost ui-focus-ring"
            >
              Cancel
            </button>
            {!reasonValid && reason ? (
              <Text variant="caption">At least 3 characters</Text>
            ) : null}
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="w-[320px] text-xs font-semibold text-[var(--ui-accent-danger)]">{error}</p>
      ) : null}
      {result ? (
        <p role="status" className="w-[320px] text-xs font-semibold text-[#5ee9a4]">{result}</p>
      ) : null}
    </div>
  );
}
