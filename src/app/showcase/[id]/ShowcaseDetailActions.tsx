'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Archive, Globe2, Loader2, Lock, PencilLine, Sparkles, Trash2, Wand2 } from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import PublicShareButton from '@/app/components/PublicShareButton';
import { getCurrentInternalPath } from '@/lib/share';

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
}: ShowcaseDetailActionsProps) {
  const router = useRouter();
  const { session, user } = useAuth();
  const [isWorking, setIsWorking] = useState<string | null>(null);

  const handleRemix = async () => {
    if (!user || !session?.access_token) {
      router.push(`/login?returnUrl=${encodeURIComponent(getCurrentInternalPath(`/showcase/${postId}`))}`);
      return;
    }

    try {
      const response = await fetch('/api/showcase/remix', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ postId }),
      });

      const data = await response.json();
      if (data.success && data.redirectTo) {
        router.push(data.redirectTo);
      }
    } catch (error) {
      console.error('Failed to remix shared creation:', error);
    }
  };

  const updateOwnerVisibility = async (nextVisibility: 'public' | 'unlisted' | 'private') => {
    if (!session?.access_token) {
      router.push(`/login?returnUrl=${encodeURIComponent(getCurrentInternalPath(`/showcase/${postId}`))}`);
      return;
    }

    setIsWorking(`visibility:${nextVisibility}`);

    try {
      const response = generationId
        ? await fetch('/api/showcase/publish', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              generationId,
              visibility: nextVisibility,
            }),
          })
        : await fetch(`/api/posts/${postId}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              visibility: nextVisibility,
            }),
          });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to update visibility.');
      }

      if (nextVisibility === 'private') {
        router.push(data.ownerPath ?? `/post/${postId}/edit`);
        return;
      }

      router.refresh();
    } catch (error) {
      console.error('Failed to update owner post visibility:', error);
    } finally {
      setIsWorking(null);
    }
  };

  const handleArchive = async () => {
    if (!session?.access_token || isWorking) {
      return;
    }

    const confirmed = window.confirm('Archive this post? It will disappear from public surfaces until you restore it from your workspace.');
    if (!confirmed) {
      return;
    }

    setIsWorking('archive');

    try {
      const response = await fetch(`/api/posts/${postId}/archive`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to archive post.');
      }

      router.push('/creations?view=posts&visibility=archived');
    } catch (error) {
      console.error('Failed to archive owner post:', error);
    } finally {
      setIsWorking(null);
    }
  };

  const handleDelete = async () => {
    if (!session?.access_token || isWorking) {
      return;
    }

    const confirmed = window.confirm(
      'Delete this post permanently? If it has paid unlocks, you will get a second confirmation so you can still choose archive instead.'
    );
    if (!confirmed) {
      return;
    }

    setIsWorking('delete');

    try {
      let response = await fetch(`/api/posts/${postId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          force: false,
        }),
      });
      let data = await response.json();

      if (response.status === 409 && data?.requiresForceDelete) {
        const forceConfirmed = window.confirm(
          'This post already has paid unlocks. Archive is safer, but you can still force delete it. Do you want to force delete it anyway?'
        );

        if (!forceConfirmed) {
          setIsWorking(null);
          return;
        }

        response = await fetch(`/api/posts/${postId}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            force: true,
          }),
        });
        data = await response.json();
      }

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to delete post.');
      }

      router.push('/creations?view=posts');
    } catch (error) {
      console.error('Failed to delete owner post:', error);
    } finally {
      setIsWorking(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <PublicShareButton
          generationId={postId}
          title={title}
          description={description}
          sourceSurface="detail-page"
          accessToken={session?.access_token ?? null}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 text-sm font-semibold text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08]"
        />

        {canRemix ? (
          <button
            type="button"
            onClick={handleRemix}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-purple-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-purple-500"
          >
            <Wand2 className="h-4 w-4" />
            Remix
          </button>
        ) : null}

        {creatorUsername ? (
          <Link
            href={`/creators/${creatorUsername}`}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-sm font-semibold text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
          >
            View creator
          </Link>
        ) : null}

        <Link
          href="/create"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-100 transition hover:border-emerald-400/45 hover:bg-emerald-500/15"
        >
          <Sparkles className="h-4 w-4" />
          Create your own
        </Link>
      </div>

      {viewerIsOwner ? (
        <details className="group rounded-[22px] border border-white/8 bg-black/25">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.03] [&::-webkit-details-marker]:hidden">
            <span>Owner tools</span>
            <span className="text-xs font-medium text-zinc-500 group-open:hidden">Edit, visibility, archive</span>
            <span className="hidden text-xs font-medium text-zinc-500 group-open:inline">Hide tools</span>
          </summary>
          <div className="flex flex-wrap gap-2 border-t border-white/8 px-4 pb-4 pt-3">
            <Link
              href={`/post/${postId}/edit`}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
            >
              <PencilLine className="h-4 w-4" />
              Edit post
            </Link>

            {hasResourceBundle ? (
              <Link
                href={`/post/${postId}/edit#resources`}
                className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-3.5 py-2 text-sm font-medium text-emerald-50 transition hover:border-emerald-300/35 hover:bg-emerald-500/15"
              >
                Manage unlock
              </Link>
            ) : null}

            {visibility !== 'public' ? (
              <button
                type="button"
                disabled={Boolean(isWorking)}
                onClick={() => void updateOwnerVisibility('public')}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3.5 py-2 text-sm font-medium text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.04] disabled:opacity-60"
              >
                {isWorking === 'visibility:public' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe2 className="h-4 w-4" />}
                Make public
              </button>
            ) : null}

            {visibility !== 'unlisted' ? (
              <button
                type="button"
                disabled={Boolean(isWorking)}
                onClick={() => void updateOwnerVisibility('unlisted')}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3.5 py-2 text-sm font-medium text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.04] disabled:opacity-60"
              >
                {isWorking === 'visibility:unlisted' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
                Make unlisted
              </button>
            ) : null}

            <button
              type="button"
              disabled={Boolean(isWorking)}
              onClick={() => void updateOwnerVisibility('private')}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3.5 py-2 text-sm font-medium text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.04] disabled:opacity-60"
            >
              {isWorking === 'visibility:private' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
              Make private
            </button>

            <button
              type="button"
              disabled={Boolean(isWorking)}
              onClick={() => void handleArchive()}
              className="inline-flex items-center gap-2 rounded-full border border-amber-400/25 bg-amber-500/10 px-3.5 py-2 text-sm font-medium text-amber-50 transition hover:border-amber-300/35 hover:bg-amber-500/15 disabled:opacity-60"
            >
              {isWorking === 'archive' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
              Archive
            </button>

            <button
              type="button"
              disabled={Boolean(isWorking)}
              onClick={() => void handleDelete()}
              className="inline-flex items-center gap-2 rounded-full border border-rose-400/25 bg-rose-500/10 px-3.5 py-2 text-sm font-medium text-rose-50 transition hover:border-rose-300/35 hover:bg-rose-500/15 disabled:opacity-60"
            >
              {isWorking === 'delete' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete
            </button>
          </div>
        </details>
      ) : null}
    </div>
  );
}
