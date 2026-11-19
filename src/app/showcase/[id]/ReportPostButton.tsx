'use client';

import { useState } from 'react';
import { Ban, Flag, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { useAuth } from '@/components/AuthProvider';
import { APP_SHELL_AUTH_USER_ATTRIBUTE, canStyleRuleNameAuthUser } from '@/lib/app-shell-account-restore';
import type { ShowcaseCreator } from '@/lib/showcase';
import { getCurrentInternalPath } from '@/lib/share';
import { readSupabaseAuthCookieUserId } from '@/lib/supabase-auth-cookie';
import { useViewerSessionCheck } from '@/lib/viewer-session-check';

import { loadSafetyActions } from './safety-actions-loader';

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

/**
 * Starts the load of Report user and Block user's actions (`safety-actions-loader.ts`) as a pointer
 * or focus reaches either row, so a press seldom waits for it. A failure here says nothing: the
 * press asks again, and says what its own failure means.
 */
function warmSafetyActions() {
  void loadSafetyActions().catch(() => undefined);
}

interface ReportPostButtonProps {
  postId: string;
  bundleId?: string | null;
  /**
   * Whose post it is, for Report user and Block user. Those rows are drawn
   * for a signed-in viewer who is not the creator: the server takes both from
   * registered accounts only. A viewer whose session is still being checked
   * has them from the first paint, inert (`creatorRows`).
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
  /**
   * The viewer blocked the creator from here. The post page hides the post
   * itself, since it reads blocks in the browser: its server render is the one
   * cached for everyone and would show the post again. Without it, the page is
   * drawn again from the server.
   */
  onCreatorBlocked?: () => void;
}

export default function ReportPostButton({
  postId,
  bundleId = null,
  creator = null,
  deliveryId = null,
  onCreatorBlocked,
}: ReportPostButtonProps) {
  const router = useRouter();
  // The live session, as the engagement row reads it. The token the page was
  // rendered with expires (an hour at Supabase's default), and a report sent
  // with it after that failed as "Unauthorized".
  const { session, user } = useAuth();
  const viewerCheck = useViewerSessionCheck();
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
  // Report user and Block user's actions did not load at the last press (`loadSafetyActionsOrSay`).
  const [safetyActionsFailed, setSafetyActionsFailed] = useState(false);

  const reasons = bundleId
    ? REPORT_REASONS
    : REPORT_REASONS.filter((option) => !RECIPE_REPORT_REASONS.has(option.value));
  const creatorId = creator?.id ?? null;
  // Report user and Block user, for a signed-in viewer who is not the creator. The page checks the
  // session in the browser after it has drawn, and a client navigation starts that check again; the
  // row came in when it ended and pushed Comments down (owner's recording, 2026-11-16). So it is
  // drawn from the first paint for a viewer whose session cookie is being checked, inert until
  // then (`useViewerSessionCheck`): 'ready' once the viewer is known; 'checking' while the cookie,
  // which names someone other than the creator, is checked; 'unread' in the server's HTML and the
  // render that hydrates it, where no cookie can be read, shown by the root element's marks only to
  // a browser whose session cookie names someone other than the creator (`.app-shell-when-signed-in`,
  // as the composer's place is in `PostComments`, and the rule drawn with it below). A check that
  // outlasts its deadline draws none, as for a visitor, until it names the viewer.
  const creatorRows = !creatorId
    ? null
    : user
      ? creatorId !== user.id ? 'ready' : null
      : viewerCheck === 'unread'
        ? canStyleRuleNameAuthUser(creatorId) ? 'unread' : null
        : viewerCheck === 'checking' && readSupabaseAuthCookieUserId() !== creatorId
          ? 'checking'
          : null;
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
  // (`lib/feed-safety-actions.ts`), filed from this page. The row stays dimmed
  // while their actions load (`safety-actions-loader.ts`). Actions that did not
  // load ask and send nothing: the row says so, with a reload, which fetches the
  // chunk names of the deployment live now, the one way past a deploy that
  // renamed them while the page was open. A later press asks again, which can
  // answer a dropped connection.
  const loadSafetyActionsOrSay = async () => {
    try {
      const actions = await loadSafetyActions();
      setSafetyActionsFailed(false);
      return actions;
    } catch (loadError) {
      console.error('Failed to load Report user and Block user:', loadError);
      // Caught here, it never reaches Next's own reportError, which is what
      // Sentry hears: hand it on, as an uncaught one would be.
      window.reportError?.(loadError);
      setSafetyActionsFailed(true);
      return null;
    }
  };

  const handleReportUser = async () => {
    if (!creatorId) return;
    if (!accessToken) {
      router.push(loginHref());
      return;
    }
    setIsCreatorActionPending(true);
    const actions = await loadSafetyActionsOrSay();
    if (!actions) {
      setIsCreatorActionPending(false);
      return;
    }
    const outcome = await actions.reportCreatorAfterConfirmation({
      userId: creatorId,
      accessToken,
      surface: 'post-page',
    });
    setIsCreatorActionPending(false);
    actions.toastSafetyOutcome(outcome);
  };

  const handleBlockUser = async () => {
    if (!creator || !creatorId) return;
    if (!accessToken) {
      router.push(loginHref());
      return;
    }
    setIsCreatorActionPending(true);
    const actions = await loadSafetyActionsOrSay();
    if (!actions) {
      setIsCreatorActionPending(false);
      return;
    }
    const outcome = await actions.blockCreatorAfterConfirmation({
      userId: creatorId,
      creatorName: creator.name,
      accessToken,
    });
    setIsCreatorActionPending(false);
    actions.toastSafetyOutcome(outcome);
    if (outcome.status !== 'done') return;
    // The post goes, as the app's post page answers not-found across a block.
    if (onCreatorBlocked) {
      onCreatorBlocked();
      return;
    }
    router.refresh();
  };

  // Rows in the rail card, not a card of their own — the rail is one surface
  // divided by hairlines, the same way the document column reads.
  return (
    <>
      <div className="border-t border-white/8 px-5 py-3.5 sm:px-6">
        {/* A 24px target: 2px more above and below its 20px line, which the margin takes back out of the layout. */}
        <button
          type="button"
          onClick={() => setIsOpen((current) => !current)}
          className="-my-0.5 inline-flex items-center gap-2 py-0.5 text-sm font-medium text-zinc-400 transition hover:text-white"
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

      {creatorRows ? (
        <div
          data-post-creator-rows={creatorId ?? undefined}
          className={`flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/8 px-5 py-3.5 sm:px-6${
            creatorRows === 'unread' ? ' app-shell-when-signed-in' : ''
          }`}
        >
          {creatorRows === 'unread' ? (
            // Never the creator's: the root element names the account the session cookie holds
            // (`data-auth-user`, app-shell-account-restore.ts), and on their own post this hides
            // the row before the first paint, as it is never drawn for them after.
            <style>
              {`html[${APP_SHELL_AUTH_USER_ATTRIBUTE}="${creatorId}"] [data-post-creator-rows="${creatorId}"]{display:none}`}
            </style>
          ) : null}
          {/* Dimmed only while an action is on its way: one waiting for the session looks as it will. */}
          <button
            type="button"
            onClick={() => void handleReportUser()}
            onPointerEnter={warmSafetyActions}
            onFocus={warmSafetyActions}
            disabled={creatorRows !== 'ready' || isCreatorActionPending}
            className={`inline-flex items-center gap-2 text-sm font-medium text-zinc-400 transition hover:text-white${
              isCreatorActionPending ? ' opacity-60' : ''
            }`}
          >
            <ShieldAlert className="h-4 w-4" aria-hidden="true" />
            Report user
          </button>
          <button
            type="button"
            onClick={() => void handleBlockUser()}
            onPointerEnter={warmSafetyActions}
            onFocus={warmSafetyActions}
            disabled={creatorRows !== 'ready' || isCreatorActionPending}
            className={`inline-flex items-center gap-2 text-sm font-medium text-zinc-400 transition hover:text-white${
              isCreatorActionPending ? ' opacity-60' : ''
            }`}
          >
            <Ban className="h-4 w-4" aria-hidden="true" />
            Block user
          </button>
          {safetyActionsFailed ? (
            <div role="alert" className="flex w-full flex-wrap items-center gap-x-4 gap-y-1">
              <p className="text-sm text-rose-200">Report user and Block user did not load. Reload the page to try again.</p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex items-center gap-2 text-sm font-medium text-zinc-200 transition hover:text-white"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Reload page
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
