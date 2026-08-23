'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { Archive, Loader2, PencilLine, Sparkles, Trash2, Wand2 } from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import PostVisibilityMenu from '@/app/components/PostVisibilityMenu';
import PublicShareButton from '@/app/components/PublicShareButton';
import {
  usePostLifecycle,
  type PostLifecycleEvent,
  type PostLifecyclePatch,
  type PostLifecycleTarget,
} from '@/app/components/usePostLifecycle';
import type { PostVisibility } from '@/lib/post-lifecycle-client';
import { getCurrentInternalPath } from '@/lib/share';
import { requestShowcaseRemix } from '@/lib/showcase-remix-client';

interface ShowcaseDetailActionsProps {
  postId: string;
  generationId: string | null;
  title: string;
  description: string;
  creatorUsername: string | null;
  canRemix: boolean;
  visibility: 'public' | 'unlisted';
  viewerIsOwner: boolean;
  hasResourceBundle: boolean;
  /** The owner's bundle, so lifecycle policy can see what a change affects. */
  bundle?: PostLifecycleTarget['bundle'];
  /** The document's engagement row renders Share instead. */
  showShare?: boolean;
  /** The document's engagement row renders Remix instead. */
  showRemix?: boolean;
}

export default function ShowcaseDetailActions({
  postId,
  generationId,
  title,
  description,
  creatorUsername,
  canRemix,
  visibility,
  viewerIsOwner,
  hasResourceBundle,
  bundle = null,
  showShare = true,
  showRemix = true,
}: ShowcaseDetailActionsProps) {
  const router = useRouter();
  const { session, user } = useAuth();
  const [isWorking, setIsWorking] = useState<string | null>(null);
  const [remixError, setRemixError] = useState<string | null>(null);
  // The page is server-rendered for the visibility it was opened at; this
  // mirror lets the menu move first and the refresh catch up.
  const [ownerVisibility, setOwnerVisibility] = useState<PostVisibility>(visibility);
  const [ownerBundleStatus, setOwnerBundleStatus] = useState(bundle?.status ?? null);

  const handleLifecycleAuthRequired = useCallback(() => {
    router.push(`/login?returnUrl=${encodeURIComponent(getCurrentInternalPath(`/showcase/${postId}`))}`);
  }, [postId, router]);

  const handleLifecyclePatch = useCallback((_patchedPostId: string, patch: PostLifecyclePatch) => {
    if (patch.visibility !== undefined) {
      setOwnerVisibility(patch.visibility);
    }
    if (patch.bundleStatus !== undefined) {
      setOwnerBundleStatus(patch.bundleStatus);
    }
  }, []);

  const handleLifecycleSettled = useCallback((event: PostLifecycleEvent) => {
    // A private post has no public page to stay on; the others re-render
    // here with the server's view of the new state.
    if (event.type === 'visibility') {
      if (event.visibility === 'private') {
        router.push(event.ownerPath ?? `/post/${postId}/edit`);
      } else {
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
    onAuthRequired: handleLifecycleAuthRequired,
    onPatch: handleLifecyclePatch,
    onSettled: handleLifecycleSettled,
  });

  const lifecycleTarget: PostLifecycleTarget = {
    id: postId,
    generationId,
    visibility: ownerVisibility,
    archivedAt: null,
    bundle: bundle && ownerBundleStatus ? { ...bundle, status: ownerBundleStatus } : bundle,
  };
  const lifecyclePending = postLifecycle.pendingAction(postId);

  const handleRemix = async () => {
    if (!user || !session?.access_token) {
      router.push(`/login?returnUrl=${encodeURIComponent(getCurrentInternalPath(`/showcase/${postId}`))}`);
      return;
    }

    setRemixError(null);
    setIsWorking('remix');

    try {
      const { redirectTo } = await requestShowcaseRemix({
        accessToken: session.access_token,
        postId,
      });
      router.push(redirectTo);
    } catch (error) {
      console.error('Failed to remix shared creation:', error);
      setRemixError(
        error instanceof Error && error.message
          ? error.message
          : 'Could not start the remix. Please try again.',
      );
    } finally {
      setIsWorking(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        {showShare ? (
          <PublicShareButton
            generationId={postId}
            title={title}
            description={description}
            sourceSurface="detail-page"
            accessToken={session?.access_token ?? null}
            className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 text-sm font-semibold text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08]"
          />
        ) : null}

        {canRemix && showRemix ? (
          <button
            type="button"
            onClick={handleRemix}
            disabled={isWorking === 'remix'}
            className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-4 py-2 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isWorking === 'remix' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            {isWorking === 'remix' ? 'Starting…' : 'Remix'}
          </button>
        ) : null}

        {creatorUsername ? (
          <Link
            href={`/creators/${creatorUsername}`}
            className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-sm font-semibold text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
          >
            View creator
          </Link>
        ) : null}

        <Link
          href="/create"
          className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-100 transition hover:border-emerald-400/45 hover:bg-emerald-500/15"
        >
          <Sparkles className="h-4 w-4" />
          Create your own
        </Link>
      </div>

      {remixError ? (
        <div role="alert" className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          {remixError}
        </div>
      ) : null}

      {viewerIsOwner ? (
        // Chrome-less: the rail card already draws the border, so a nested
        // card here would inset this row from every other one.
        <details className="group -mx-5 -mb-5 border-t border-white/8 sm:-mx-6 sm:-mb-6">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3.5 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.03] sm:px-6 [&::-webkit-details-marker]:hidden">
            <span>Owner tools</span>
            <span className="text-xs font-medium text-zinc-500 group-open:hidden">Edit, visibility, archive</span>
            <span className="hidden text-xs font-medium text-zinc-500 group-open:inline">Hide tools</span>
          </summary>
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
        </details>
      ) : null}
    </div>
  );
}
