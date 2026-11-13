'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { ChevronDown } from 'lucide-react';

import PostComments from '@/components/PostComments';
import { formatCompactCount } from '@/lib/post-feed-presentation';

type CommentCountState = {
  count: number;
  setCount: (count: number) => void;
  /** Whether the thread's panel beside the post is open. */
  open: boolean;
  setOpen: (open: boolean) => void;
};

const CommentCountContext = createContext<CommentCountState | null>(null);

/**
 * The post page's comment count, held for the engagement row and the thread
 * under it. The page is rendered on the server, so the row printed the count
 * the post had then while the thread's own heading moved with every comment
 * posted or deleted: two numbers on one screen. The thread now reports each
 * change here and the row reads it, as the app's action bar follows its sheet.
 */
export function ShowcaseDetailCommentCountProvider({
  initialCount,
  children,
}: {
  initialCount: number;
  children: ReactNode;
}) {
  const [count, setCount] = useState(initialCount);
  const [open, setOpen] = useState(true);
  const value = useMemo(() => ({ count, setCount, open, setOpen }), [count, open]);

  return <CommentCountContext.Provider value={value}>{children}</CommentCountContext.Provider>;
}

/** The live count inside the provider; the count the page was rendered with outside it. */
export function useShowcaseDetailCommentCount(renderedCount: number): number {
  return useContext(CommentCountContext)?.count ?? renderedCount;
}

/** What the Comment link's press moves focus to: the first of these the thread holds. */
const COMMENTS_FOCUS_TARGETS = ['textarea[aria-label^="Write a"]', 'a[href^="/login"]', 'button'];

/**
 * The engagement row's Comment link. It opens the thread's panel, so it never
 * lands on a panel its reader closed, and then goes to the thread.
 *
 * In one column the thread is under the post and the link's own jump to
 * `#comments` is the way there. Beside the post the thread is already in
 * view, in a rail that follows the window: the same jump scrolled the page
 * by the rail's offset, took the post out of view and moved the thread
 * nowhere. There the press keeps the page where it is and puts focus in the
 * thread: on the composer, or on the sign-in link in its place.
 */
export function useOpenShowcaseDetailComments(): (event: MouseEvent<HTMLAnchorElement>) => void {
  const setOpen = useContext(CommentCountContext)?.setOpen;
  return useCallback((event) => {
    setOpen?.(true);
    const panel = document.getElementById('comments');
    const rail = panel?.closest('.canonical-post-actions');
    if (!panel || !rail || window.getComputedStyle(rail).position !== 'sticky') return;
    event.preventDefault();
    // After the panel has opened: a folded one holds nothing to focus.
    window.requestAnimationFrame(() => {
      for (const selector of COMMENTS_FOCUS_TARGETS) {
        const target = panel.querySelector<HTMLElement>(selector);
        if (target) {
          target.focus({ preventScroll: true });
          return;
        }
      }
    });
  }, [setOpen]);
}

/** The post's thread, reporting its count to the provider around it. */
export function ShowcaseDetailComments({
  postId,
  postCreatorId,
  commentCount,
  deliveryId = null,
}: {
  postId: string;
  postCreatorId: string | null;
  commentCount: number;
  /** The delivery of the ranked card that opened the page, sent with each new comment. */
  deliveryId?: string | null;
}) {
  const setCount = useContext(CommentCountContext)?.setCount;

  return (
    <PostComments
      postId={postId}
      postCreatorId={postCreatorId}
      commentCount={commentCount}
      onCommentCountChange={setCount}
      deliveryId={deliveryId}
    />
  );
}

/**
 * The thread as a panel in the rail beside the post (owner, 2026-11-13: the
 * conversation sat under the post and its recipe, a screen or more down). Its
 * header's close button folds it to one row, which opens it again; the thread
 * stays mounted while folded, so a draft and the pages already read survive.
 */
export function ShowcaseDetailCommentsPanel({
  postId,
  postCreatorId,
  commentCount,
  deliveryId = null,
}: {
  postId: string;
  postCreatorId: string | null;
  commentCount: number;
  deliveryId?: string | null;
}) {
  const context = useContext(CommentCountContext);
  const open = context?.open ?? true;
  const count = context?.count ?? commentCount;
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const unfoldRef = useRef<HTMLButtonElement | null>(null);
  // Close hides the button it was pressed on, and the one row that opens the
  // panel again leaves the page when pressed: focus follows to the control
  // that undoes the press. Only after a press here, never on the first draw
  // or when the post's Comment link opens the panel (it places focus itself).
  const pressedHereRef = useRef(false);
  useEffect(() => {
    if (!pressedHereRef.current) return;
    pressedHereRef.current = false;
    if (open) {
      bodyRef.current?.querySelector<HTMLElement>('button[aria-label="Close comments"]')?.focus();
    } else {
      unfoldRef.current?.focus();
    }
  }, [open]);
  const setOpenHere = (next: boolean) => {
    pressedHereRef.current = true;
    context?.setOpen(next);
  };

  return (
    <div
      id="comments"
      data-testid="canonical-post-comments"
      data-open={open}
      className="canonical-post-comments min-w-0 scroll-mt-24 overflow-hidden rounded-3xl border border-white/10 bg-[linear-gradient(180deg,rgba(24,24,27,0.86),rgba(10,10,12,0.9))] backdrop-blur-xl"
    >
      {open ? null : (
        <button
          ref={unfoldRef}
          type="button"
          onClick={() => setOpenHere(true)}
          aria-expanded={false}
          aria-controls={bodyId}
          className="ui-focus-ring flex min-h-13 w-full items-center justify-between gap-3 rounded-3xl px-4 text-left transition hover:bg-white/[0.04]"
        >
          <span className="flex items-baseline gap-2 text-base font-bold text-[var(--ui-text-primary)]">
            Comments
            {count > 0 ? (
              <span className="text-sm font-medium text-[var(--ui-text-muted)]">{formatCompactCount(count)}</span>
            ) : null}
          </span>
          <ChevronDown className="h-4 w-4 text-zinc-400" aria-hidden="true" />
        </button>
      )}
      <div ref={bodyRef} id={bodyId} hidden={!open} className="canonical-post-comments-body">
        <PostComments
          postId={postId}
          postCreatorId={postCreatorId}
          commentCount={commentCount}
          onCommentCountChange={context?.setCount}
          deliveryId={deliveryId}
          layout="panel"
          onClose={context ? () => setOpenHere(false) : undefined}
        />
      </div>
    </div>
  );
}
