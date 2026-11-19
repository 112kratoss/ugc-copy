'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { Archive, Loader2, PencilLine, Trash2 } from 'lucide-react';

import { useAuth } from '@/components/AuthProvider';
import PostVisibilityMenu from '@/components/PostVisibilityMenu';
import {
  usePostLifecycle,
  type PostLifecycleEvent,
  type PostLifecyclePatch,
  type PostLifecycleTarget,
} from '@/components/usePostLifecycle';
import { rememberOwnerPostVisibility } from '@/lib/owner-page-edits';
import type { PostVisibility } from '@/lib/post-lifecycle-client';
import { getCurrentInternalPath } from '@/lib/share';

/**
 * What the creator's Owner tools open onto once the session check names them (`ownerTools`
 * 'ready' in `ShowcaseDetailActions`): the edit links, the visibility menu, Archive and Delete.
 * Loaded with import() then, and never for anyone else: the actions behind them are about 14 KB
 * that every other reader of the post loaded with the page (2026-11-19).
 */
export default function ShowcaseOwnerToolsMenu({
  postId,
  generationId,
  title,
  hasResourceBundle,
  bundle,
  ownerVisibility,
  onPatch,
}: {
  postId: string;
  generationId: string | null;
  title: string;
  hasResourceBundle: boolean;
  /** The owner's bundle as the page holds it now (its status moved by a change made here). */
  bundle: PostLifecycleTarget['bundle'];
  /** The visibility the menu shows: the page's mirror, which moves first and the refresh catches up. */
  ownerVisibility: PostVisibility;
  onPatch: (postId: string, patch: PostLifecyclePatch) => void;
}) {
  const router = useRouter();
  const { session } = useAuth();

  const handleLifecycleAuthRequired = useCallback(() => {
    router.push(`/login?returnUrl=${encodeURIComponent(getCurrentInternalPath(`/showcase/${postId}`))}`);
  }, [postId, router]);

  const handleLifecycleSettled = useCallback((event: PostLifecycleEvent) => {
    // A private post has no public page to stay on; the others stay here.
    if (event.type === 'visibility') {
      if (event.visibility === 'private') {
        router.push(event.ownerPath ?? `/post/${postId}/edit`);
      } else {
        // The page is cached for everyone and its tag is invalidated only
        // after the change's answer was sent, so a refresh now can still get
        // the old page: the owner's view takes the answer's visibility, and
        // the refresh drops whatever else the router kept.
        if (event.visibility) rememberOwnerPostVisibility(postId, event.visibility);
        router.refresh();
      }
      return;
    }
    if (event.type === 'archive') {
      router.push('/creations?view=posts&visibility=archived');
      return;
    }
    if (event.type === 'delete') {
      router.push('/creations?view=posts');
    }
  }, [postId, router]);

  const postLifecycle = usePostLifecycle({
    accessToken: session?.access_token ?? null,
    signedInUser: session?.user ?? null,
    onAuthRequired: handleLifecycleAuthRequired,
    onPatch,
    onSettled: handleLifecycleSettled,
  });

  const lifecycleTarget: PostLifecycleTarget = {
    id: postId,
    generationId,
    visibility: ownerVisibility,
    archivedAt: null,
    bundle,
  };
  const lifecyclePending = postLifecycle.pendingAction(postId);

  return (
    <div className="flex flex-wrap gap-2 border-t border-white/8 px-5 pb-4 pt-3 sm:px-6">
      <Link
        href={`/post/${postId}/edit`}
        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
      >
        <PencilLine className="h-4 w-4" />
        Edit post
      </Link>

      {hasResourceBundle ? (
        <Link
          href={`/post/${postId}/edit#recipe`}
          className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-3.5 py-2 text-sm font-medium text-emerald-50 transition hover:border-emerald-300/35 hover:bg-emerald-500/15"
        >
          Manage recipe
        </Link>
      ) : null}

      <PostVisibilityMenu
        value={ownerVisibility}
        onChange={(next) => void postLifecycle.setVisibility(lifecycleTarget, next)}
        pending={lifecyclePending === 'visibility'}
        disabled={Boolean(lifecyclePending)}
        label={`Visibility of ${title}`}
      />

      <button
        type="button"
        disabled={Boolean(lifecyclePending)}
        onClick={() => void postLifecycle.archive(lifecycleTarget)}
        className="ui-focus-ring inline-flex items-center gap-2 rounded-full border border-amber-400/25 bg-amber-500/10 px-3.5 py-2 text-sm font-medium text-amber-50 transition hover:border-amber-300/35 hover:bg-amber-500/15 disabled:opacity-60"
      >
        {lifecyclePending === 'archive' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
        Archive
      </button>

      <button
        type="button"
        disabled={Boolean(lifecyclePending)}
        onClick={() => void postLifecycle.remove(lifecycleTarget)}
        className="ui-focus-ring inline-flex items-center gap-2 rounded-full border border-rose-400/25 bg-rose-500/10 px-3.5 py-2 text-sm font-medium text-rose-50 transition hover:border-rose-300/35 hover:bg-rose-500/15 disabled:opacity-60"
      >
        {lifecyclePending === 'delete' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        Delete
      </button>
    </div>
  );
}
