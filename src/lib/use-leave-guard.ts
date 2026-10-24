'use client';

/**
 * Asks before a page with unsaved work is left. This is the creator profile
 * editor's guard (`src/app/creations/CreatorProfileCard.tsx`, #533 and #536),
 * moved here whole so that the post composer asks the same way.
 *
 *   const { leave } = useLeaveGuard({
 *     isDirty,
 *     question: LEAVE_WITHOUT_SAVING,
 *     historyKey: 'profileLeaveGuard',
 *     guardBack: !isEmbedded,
 *     onLeave: dropStagedUploads,
 *   });
 *
 * Inputs:
 * - `isDirty`: whether leaving now would lose work. The guard is up only
 *   while it is true; a page that has just saved passes false.
 * - `question`: the dialog's words, as `useConfirmation` takes them
 *   (`title`, `message`, `confirmLabel` to leave, `cancelLabel` to stay,
 *   `tone`). Asked for a link, the shell's search and Back alike.
 * - `historyKey`: the name of the guard's marks in `history.state`. The guard
 *   entry carries it, and the page's entry under it carries it with `Page`
 *   added. Use one per kind of page, and never rename one that has shipped:
 *   a tab keeps its entries across a reload and a deploy.
 * - `guardBack` (default true): false keeps the guard out of history, for a
 *   page drawn inside another surface that answers Back itself (the profile
 *   editor in the creator page's modal). Links, the shell's search and the
 *   tab still ask.
 * - `onLeave` (optional): runs when the person answers the question with a
 *   leave, as the page starts to go, for anything the page drops on its way
 *   out. It does not run for `leave()`.
 *
 * Returns `leave(navigate)`, for the page's own ways out once its work is
 * safe or the person has already said to drop it (a save that moves on,
 * Skip for now). It steps off the guard entry, then runs `navigate`, and asks
 * nothing. Call it for every such way out: a guard entry left under the next
 * page is a Back that goes nowhere.
 *
 * While `isDirty`, the guard covers:
 * - Back, and a phone browser's back swipe: a guard entry for the same
 *   address sits on top of the page's own, Back takes it off without
 *   leaving, and the question is asked there. A leave finishes the Back.
 * - Every link in the document: an unmodified click on a same-origin link to
 *   another address is held before any handler of the link runs, and a leave
 *   follows it by the router (a new tab or a download is not held). The app
 *   shell's sidebar, bottom navigation, drawer, top bar and account menu are
 *   links, and so is a page's own Back link, which needs no handler of its
 *   own: one it has never runs.
 * - The shell's ways out that are not links, which call `holdForLeaveGuard`
 *   (the top bar's search).
 * - A reload, a closed tab or a typed address, which get the browser's own
 *   question (`beforeunload`).
 *
 * A page that uses it keeps no `beforeunload` or leave question of its own:
 * the guard quiets its `beforeunload` once a leave is chosen, and a second
 * listener would ask again after a Back that leaves the site.
 *
 * It does not cover a page's own buttons that navigate by the router (ask,
 * then call `leave`), the account menu's Sign out, or a tab the browser
 * discards in the background: the web keeps no drafts.
 */

import { useCallback, useEffect, useEffectEvent, useRef } from 'react';
import { useRouter } from 'next/navigation';

import type { ConfirmationRequest } from '@/components/feedback-state';
import { publishNavigationStartTo } from '@/components/navigation-progress-state';
import { useConfirmation } from '@/components/useConfirmation';

export interface LeaveGuardOptions {
  isDirty: boolean;
  question: ConfirmationRequest;
  historyKey: string;
  guardBack?: boolean;
  onLeave?: () => void;
}

export interface LeaveGuard {
  leave: (navigate: () => void) => void;
}

// The leave guard's two entries say what they are in `history.state`: the
// entry pushed on top while the page is dirty, and the page's own entry under
// it, both with the guard's id. Told apart by the address and a ref alone,
// Forward onto the guard entry after a Leave (a new page, the ref off) left
// the page twice in history, and a jump back to an earlier visit of the page
// (the same address) was taken for the guard's own Back.
const pageKeyFor = (historyKey: string) => `${historyKey}Page`;

/** The guard id an entry's state carries under `key`. */
function readLeaveGuardId(state: unknown, key: string): string | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : null;
}

function createLeaveGuardId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Marks the page's entry with the guard's id and adds the guard's entry (the same address) over it. */
function pushLeaveGuardEntry(historyKey: string, id: string): void {
  const pageKey = pageKeyFor(historyKey);
  const current: Record<string, unknown> = { ...window.history.state };
  delete current[historyKey];
  delete current[pageKey];
  // The page's entry keeps its fields, Next's included, and carries Next's
  // `__NA` also when it had no state (a plain `#fragment` link's): Next's
  // popstate reloads the page on a state without `__NA`, and restores one with
  // it as staying on the page. Next's patched replaceState hands an object with
  // `__NA` straight on.
  window.history.replaceState({ ...current, __NA: true, [pageKey]: id }, '', window.location.href);
  // The guard's entry leaves Next's fields to Next's patched pushState, which
  // copies them in from the page's entry and has the router write the page's
  // tree in when that entry has none: a guard entry without a tree would draw
  // whatever page Back or Forward came from. The reels' entries are written the
  // same way (`src/lib/reel-history-entry.ts`). Next's own writes for a
  // navigation or a refresh drop the marks from the entry they replace: the
  // page on it still knows its guard by its refs, and a later visit takes
  // the entry for a plain one.
  const guardState: Record<string, unknown> = { ...current, [historyKey]: id };
  delete guardState.__NA;
  delete guardState.__PRIVATE_NEXTJS_INTERNALS_TREE;
  window.history.pushState(guardState, '', window.location.href);
}

/** Takes the guard's mark off its entry, which the page is about to step off to leave. */
function unmarkLeaveGuardEntry(historyKey: string): void {
  // A replace keeps the entries after the one it replaces (a save's, Skip for
  // now's): still marked, the entry left ahead would bring a later page
  // (Forward) onto a guard over a page that is no longer its own.
  const current: Record<string, unknown> = { ...window.history.state };
  delete current[historyKey];
  window.history.replaceState(current, '', window.location.href);
}

type HoldWayOut = (navigate: () => void) => boolean;

// The guard of the page on screen while it has unsaved work. One at a time:
// the latest page to come up holds the shell's ways out.
let holdingGuard: HoldWayOut | null = null;

function holdWayOutsWith(guard: HoldWayOut): () => void {
  holdingGuard = guard;
  return () => {
    if (holdingGuard === guard) holdingGuard = null;
  };
}

/**
 * For the app shell's ways out that are not links: hands `navigate` to the
 * guard of a page with unsaved work, which asks its question and runs
 * `navigate` only on a leave, once off its guard entry. False when nothing
 * holds this way out, so the caller goes on as usual; also false for the way
 * out a leave runs (a form submitted again from `navigate`). Links need no
 * call: the guard holds every link click itself.
 */
export function holdForLeaveGuard(navigate: () => void): boolean {
  return holdingGuard?.(navigate) ?? false;
}

export function useLeaveGuard({
  isDirty,
  question,
  historyKey,
  guardBack = true,
  onLeave,
}: LeaveGuardOptions): LeaveGuard {
  const router = useRouter();
  const askToConfirm = useConfirmation();
  const allowDirtyNavigationRef = useRef(false);
  const isDirtyRef = useRef(false);
  // Whether the leave guard's entry is on top of history now, and its id.
  const leaveGuardEntryRef = useRef(false);
  const leaveGuardIdRef = useRef<string | null>(null);
  // Where the page itself is going once Back has taken the guard entry off.
  const afterLeaveGuardPopRef = useRef<(() => void) | null>(null);
  const askToLeave = useEffectEvent(() => askToConfirm(question));
  const reportLeaving = useEffectEvent(() => onLeave?.());

  // Every way out (a save, Skip for now, a confirmed link, a confirmed Back)
  // steps off the guard entry before it moves on: left under the next page,
  // it would be a Back that goes nowhere. All but Back take the guard's mark
  // off that entry first, as they replace the page's entry or push over it: a
  // replace keeps the guard entry ahead, and Forward would bring a later
  // page onto a guard over a page that is no longer its own. A Back
  // leaves the page's entry as it is, so the guard entry ahead stays its own.
  const leave = useCallback((navigate: () => void, { byBack = false } = {}) => {
    if (!leaveGuardEntryRef.current) {
      navigate();
      return;
    }
    if (!byBack) unmarkLeaveGuardEntry(historyKey);
    afterLeaveGuardPopRef.current = navigate;
    window.history.back();
  }, [historyKey]);

  useEffect(() => {
    if (!isDirty) {
      allowDirtyNavigationRef.current = false;
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (allowDirtyNavigationRef.current) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    };

    // A leave goes off the guard entry first, with the page's own
    // `beforeunload` quiet while the way out chosen starts.
    const askThenLeave = (navigate: () => void) => {
      void askToLeave().then((confirmed) => {
        if (!confirmed) return;

        leave(() => {
          allowDirtyNavigationRef.current = true;
          window.setTimeout(() => {
            allowDirtyNavigationRef.current = false;
          }, 0);
          navigate();
        });
        reportLeaving();
      });
    };

    const handleDocumentClick = (event: MouseEvent) => {
      // A click that opens a new tab or window leaves nothing behind.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest<HTMLAnchorElement>('a[href]');
      if (
        !anchor
        || anchor.target === '_blank'
        || anchor.hasAttribute('download')
        || anchor.origin !== window.location.origin
      ) {
        return;
      }

      const destination = new URL(anchor.href);
      const current = new URL(window.location.href);
      // A link to a place on this page (the layout's "Skip to content", a
      // section anchor) leaves nothing behind, whatever its fragment.
      if (destination.pathname === current.pathname && destination.search === current.search) {
        return;
      }

      // The answer comes after this click has been handled, so the click is
      // held either way and a "leave" goes by the router.
      event.preventDefault();
      event.stopPropagation();
      const href = `${destination.pathname}${destination.search}${destination.hash}`;
      askThenLeave(() => {
        publishNavigationStartTo(href);
        router.push(href);
      });
    };

    const releaseWayOuts = holdWayOutsWith((navigate) => {
      // The way out a leave was chosen for, coming through again.
      if (allowDirtyNavigationRef.current) return false;
      askThenLeave(navigate);
      return true;
    });
    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('click', handleDocumentClick, true);
    return () => {
      releaseWayOuts();
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('click', handleDocumentClick, true);
    };
  }, [isDirty, leave, router]);

  // Back, and a phone browser's back swipe, leave through history, which
  // neither the click guard nor `beforeunload` sees. While the page is dirty,
  // one entry for the same address sits on top of the page's own: Back takes
  // it off without leaving, and the question is asked there.
  useEffect(() => {
    isDirtyRef.current = isDirty;
    if (isDirty && guardBack && !leaveGuardEntryRef.current) {
      leaveGuardIdRef.current = createLeaveGuardId();
      pushLeaveGuardEntry(historyKey, leaveGuardIdRef.current);
      leaveGuardEntryRef.current = true;
    }
  }, [guardBack, historyKey, isDirty]);

  useEffect(() => {
    if (!guardBack) return;

    // This page's address: an entry with it is an entry of this page.
    const pageAddress = `${window.location.pathname}${window.location.search}`;
    // A guard entry is this page's, whichever visit pushed it: the page
    // mounts on one (Back from a page a link reached from it, a reload) or
    // comes to it with Forward after a Leave, or with a jump.
    const holdGuardEntry = (id: string) => {
      leaveGuardIdRef.current = id;
      leaveGuardEntryRef.current = true;
    };
    const mountedOnGuardId = readLeaveGuardId(window.history.state, historyKey);
    if (mountedOnGuardId) holdGuardEntry(mountedOnGuardId);

    const handlePopState = (event: PopStateEvent) => {
      const afterPop = afterLeaveGuardPopRef.current;
      if (afterPop) {
        afterLeaveGuardPopRef.current = null;
        leaveGuardEntryRef.current = false;
        afterPop();
        return;
      }
      const guardId = readLeaveGuardId(event.state, historyKey);
      if (guardId) {
        holdGuardEntry(guardId);
        return;
      }
      if (!leaveGuardEntryRef.current) return;
      leaveGuardEntryRef.current = false;
      // Only Back onto the page's entry under the guard's is the guard's own.
      // Any other entry is a jump further, with nothing to ask or undo: away
      // from this page it has left the page; onto an earlier visit of it the
      // edits are still here, so the guard goes up again over that entry
      // (which drops the entries after it, as any new entry does).
      const pageGuardId = readLeaveGuardId(event.state, pageKeyFor(historyKey));
      if (!pageGuardId || pageGuardId !== leaveGuardIdRef.current) {
        if (isDirtyRef.current && `${window.location.pathname}${window.location.search}` === pageAddress) {
          leaveGuardIdRef.current = createLeaveGuardId();
          pushLeaveGuardEntry(historyKey, leaveGuardIdRef.current);
          leaveGuardEntryRef.current = true;
        }
        return;
      }
      if (!isDirtyRef.current) {
        // Finish the Back that was asked for.
        window.history.back();
        return;
      }
      // Forward onto the guard entry, still the one after this, while the
      // question is up, so another Back asks again (answering this one "stay")
      // rather than leaving. Forward, not the entry pushed again: Chrome takes
      // an entry added in a popstate (no user activation since the Back) for
      // history manipulation, and its own Back button then skipped every entry
      // of the page, out of the site (archive/web-history-follow-ups-2026-10-23).
      window.history.forward();
      leaveGuardEntryRef.current = true;
      void askToLeave().then((confirmed) => {
        if (!confirmed || !leaveGuardEntryRef.current) return;
        // Asked and answered: the page this Back reaches may be another site.
        allowDirtyNavigationRef.current = true;
        // Off the guard entry, then the Back that was asked for.
        leave(() => window.history.back(), { byBack: true });
        reportLeaving();
      });
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [guardBack, historyKey, leave]);

  return { leave };
}
