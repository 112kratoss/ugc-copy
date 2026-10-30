'use client';

import { useState } from 'react';
import { Ban, Flag, Loader2, ShieldAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { useAuth } from '@/components/AuthProvider';
import {
  blockCreatorAfterConfirmation,
  reportCreatorAfterConfirmation,
  toastSafetyOutcome,
} from '@/lib/feed-safety-actions';
import type { ShowcaseCreator } from '@/lib/showcase';
import { getCurrentInternalPath } from '@/lib/share';

/** The reasons a post can be reported for. The Terms (section 8) name "Stolen content". */
export const REPORT_REASONS = [
  { value: 'spam', label: 'Spam' },
  { value: 'stolen_content', label: 'Stolen content' },
  { value: 'misleading_unlock', label: 'Misleading recipe' },
  { value: 'unsafe_content', label: 'Unsafe content' },
  { value: 'payment_issue', label: 'Payment issue' },
  { value: 'other', label: 'Other' },
];

/** About a recipe and its purchase: offered only on a post that carries one. */
const RECIPE_REPORT_REASONS = new Set(['misleading_unlock', 'payment_issue']);

interface ReportPostButtonProps {
  postId: string;
  bundleId?: string | null;
  /**
   * Whose post it is, for Report user and Block user. Those rows are drawn
   * for a signed-in viewer who is not the creator: the server takes both from
   * registered accounts only.
   */
  creator?: Pick<ShowcaseCreator, 'id' | 'name'> | null;
  /**
   * The delivery of the ranked card that opened the page
   * (`recommendation.deliveryId`). Sent with the report, as the feed's own
   * menus send theirs: the server files the report as that delivery's `report`
   * event, and one without a delivery reaches neither the post's stats nor the
   * reporter's interests.
   */
  deliveryId?: string | null;
}

export default function ReportPostButton({
  postId,
  bundleId = null,
  creator = null,
  deliveryId = null,
}: ReportPostButtonProps) {
  const router = useRouter();
  // The live session, as the engagement row reads it. The token the page was
  // rendered with expires (an hour at Supabase's default), and a report sent
  // with it after that failed as "Unauthorized".
  const { session, user } = useAuth();
  const accessToken = session?.access_token ?? null;
  const [isOpen, setIsOpen] = useState(false);
  // No reason until the viewer picks one: a preselected "Misleading recipe"
  // filed every report left on the default under it, recipe or not.
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreatorActionPending, setIsCreatorActionPending] = useState(false);

  const reasons = bundleId
    ? REPORT_REASONS
    : REPORT_REASONS.filter((option) => !RECIPE_REPORT_REASONS.has(option.value));
  const creatorId = creator?.id ?? null;
  const showCreatorRows = Boolean(user && creatorId && creatorId !== user.id);
  const loginHref = () => `/login?returnUrl=${encodeURIComponent(getCurrentInternalPath(`/showcase/${postId}`))}`;

  const submitReport = async () => {
    if (!reason) {
      return;
    }

    if (!accessToken) {
      router.push(loginHref());
      return;
    }

    try {
      setIsSubmitting(true);
      setFeedback(null);
      setError(null);

      const response = await fetch(`/api/posts/${postId}/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          reason,
          details,
          bundleId,
          ...(deliveryId ? { deliveryId } : {}),
        }),
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to submit report.');
      }

      setFeedback('Report submitted for review.');
      setIsOpen(false);
      setReason('');
      setDetails('');
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : 'Failed to submit report.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Report user and Block user, asked for and sent as the feed card's are
  // (`lib/feed-safety-actions.ts`), filed from this page.
  const handleReportUser = async () => {
    if (!creatorId) return;
    if (!accessToken) {
      router.push(loginHref());
      return;
    }
    setIsCreatorActionPending(true);
    const outcome = await reportCreatorAfterConfirmation({
      userId: creatorId,
      accessToken,
      surface: 'post-page',
    });
    setIsCreatorActionPending(false);
    toastSafetyOutcome(outcome);
  };

  const handleBlockUser = async () => {
    if (!creator || !creatorId) return;
    if (!accessToken) {
      router.push(loginHref());
      return;
    }
    setIsCreatorActionPending(true);
    const outcome = await blockCreatorAfterConfirmation({
      userId: creatorId,
      creatorName: creator.name,
      accessToken,
    });
    setIsCreatorActionPending(false);
    toastSafetyOutcome(outcome);
    // The page checks blocks on the server, so drawing it again answers
    // not-found, as the app's post page does across a block.
    if (outcome.status === 'done') router.refresh();
  };

  // Rows in the rail card, not a card of their own — the rail is one surface
  // divided by hairlines, the same way the document column reads.
  return (
    <>
      <div className="border-t border-white/8 px-5 py-3.5 sm:px-6">
        <button
          type="button"
          onClick={() => setIsOpen((current) => !current)}
          className="inline-flex items-center gap-2 text-sm font-medium text-zinc-400 transition hover:text-white"
        >
          <Flag className="h-4 w-4" />
          Report post or recipe
        </button>

        {isOpen ? (
          <div className="mt-4 space-y-3">
            <select
              aria-label="Report reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="w-full rounded-2xl border border-white/10 bg-zinc-950 px-4 py-3 text-sm text-white outline-none"
            >
              <option value="" disabled>Choose a reason</option>
              {reasons.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <textarea
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              rows={3}
              placeholder="Optional context for the review team."
              className="w-full rounded-2xl border border-white/10 bg-zinc-950 px-4 py-3 text-sm text-white outline-none"
            />
            <button
              type="button"
              onClick={() => void submitReport()}
              disabled={isSubmitting || !reason}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08] disabled:opacity-60"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Submit report
            </button>
          </div>
        ) : null}

        {feedback ? <p className="mt-3 text-sm text-emerald-200">{feedback}</p> : null}
        {error ? <p className="mt-3 text-sm text-rose-200">{error}</p> : null}
      </div>

      {showCreatorRows ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/8 px-5 py-3.5 sm:px-6">
          <button
            type="button"
            onClick={() => void handleReportUser()}
            disabled={isCreatorActionPending}
            className="inline-flex items-center gap-2 text-sm font-medium text-zinc-400 transition hover:text-white disabled:opacity-60"
          >
            <ShieldAlert className="h-4 w-4" aria-hidden="true" />
            Report user
          </button>
          <button
            type="button"
            onClick={() => void handleBlockUser()}
            disabled={isCreatorActionPending}
            className="inline-flex items-center gap-2 text-sm font-medium text-zinc-400 transition hover:text-white disabled:opacity-60"
          >
            <Ban className="h-4 w-4" aria-hidden="true" />
            Block user
          </button>
        </div>
      ) : null}
    </>
  );
}
