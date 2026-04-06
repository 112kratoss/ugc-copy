'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Sparkles, Wand2 } from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import PublicShareButton from '@/app/components/PublicShareButton';

interface ShowcaseDetailActionsProps {
  postId: string;
  title: string;
  description: string;
  creatorUsername: string | null;
  canRemix: boolean;
}

export default function ShowcaseDetailActions({
  postId,
  title,
  description,
  creatorUsername,
  canRemix,
}: ShowcaseDetailActionsProps) {
  const router = useRouter();
  const { session, user } = useAuth();

  const handleRemix = async () => {
    if (!user || !session?.access_token) {
      router.push(`/login?returnUrl=/showcase/${postId}`);
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

  return (
    <div className="flex flex-wrap gap-3">
      <PublicShareButton
        generationId={postId}
        title={title}
        description={description}
        sourceSurface="detail-page"
        accessToken={session?.access_token ?? null}
        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
      />

      {canRemix ? (
        <button
          type="button"
          onClick={handleRemix}
          className="inline-flex items-center gap-2 rounded-full bg-purple-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-purple-500"
        >
          <Wand2 className="h-4 w-4" />
          Remix
        </button>
      ) : null}

      {creatorUsername ? (
        <Link
          href={`/creators/${creatorUsername}`}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2.5 text-sm font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
        >
          View creator
        </Link>
      ) : null}

      <Link
        href="/create"
        className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-4 py-2.5 text-sm font-medium text-emerald-200 transition hover:border-emerald-400/40 hover:bg-emerald-500/15"
      >
        <Sparkles className="h-4 w-4" />
        Create your own
      </Link>
    </div>
  );
}
