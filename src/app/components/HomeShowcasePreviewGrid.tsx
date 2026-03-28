'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Heart, Wand2 } from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import { HoverVideo } from '@/app/components/HoverVideo';
import MediaDetailsPreviewModal from '@/app/components/MediaDetailsPreviewModal';
import PublicShareButton from '@/app/components/PublicShareButton';
import type { ShowcaseFeedItem } from '@/lib/showcase';
import { buildShowcaseDetailPath } from '@/lib/share';

interface HomeShowcasePreviewGridProps {
  items: ShowcaseFeedItem[];
}

export default function HomeShowcasePreviewGrid({
  items,
}: HomeShowcasePreviewGridProps) {
  const router = useRouter();
  const { session, user } = useAuth();
  const [feedItems, setFeedItems] = useState(items);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [savedGenerationIds, setSavedGenerationIds] = useState<Set<string>>(
    new Set(items.filter((item) => item.isSaved).map((item) => item.id))
  );

  const selectedItem = useMemo(
    () => feedItems.find((item) => item.id === selectedItemId) ?? null,
    [feedItems, selectedItemId]
  );

  const handleSave = async (id: string) => {
    if (!user || !session?.access_token) {
      router.push('/login?returnUrl=/');
      return;
    }

    const currentlySaved = savedGenerationIds.has(id);

    setSavedGenerationIds((previous) => {
      const next = new Set(previous);
      if (currentlySaved) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

    setFeedItems((previous) =>
      previous.map((item) =>
        item.id === id
          ? {
              ...item,
              saveCount: Math.max(0, item.saveCount + (currentlySaved ? -1 : 1)),
            }
          : item
      )
    );

    try {
      const response = await fetch('/api/showcase/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ generationId: id }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to save showcase item');
      }
    } catch (error) {
      console.error('Failed to save homepage showcase item:', error);

      setSavedGenerationIds((previous) => {
        const next = new Set(previous);
        if (currentlySaved) {
          next.add(id);
        } else {
          next.delete(id);
        }
        return next;
      });

      setFeedItems((previous) =>
        previous.map((item) =>
          item.id === id
            ? {
                ...item,
                saveCount: Math.max(0, item.saveCount + (currentlySaved ? 1 : -1)),
              }
            : item
        )
      );
    }
  };

  const handleRemix = async (id: string) => {
    if (!user || !session?.access_token) {
      router.push('/login?returnUrl=/');
      return;
    }

    try {
      const response = await fetch('/api/showcase/remix', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ generationId: id }),
      });
      const data = await response.json();

      if (data.success && data.redirectTo) {
        router.push(data.redirectTo);
      }
    } catch (error) {
      console.error('Failed to remix homepage showcase item:', error);
    }
  };

  if (feedItems.length === 0) {
    return (
      <div className="rounded-[24px] border border-white/8 bg-white/[0.03] p-10 text-center text-zinc-400">
        No community inspiration is available yet.
      </div>
    );
  }

  return (
    <>
      <div className="columns-2 gap-4 space-y-4 md:columns-3 xl:columns-4 2xl:columns-5">
        {feedItems.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-label={`Preview ${item.title}`}
            onClick={() => setSelectedItemId(item.id)}
            className="group relative block w-full break-inside-avoid overflow-hidden rounded-[24px] border border-white/8 bg-[#111215] text-left"
          >
            {item.category === 'video' || item.category === 'motion' ? (
              <HoverVideo
                src={item.url}
                className="block h-auto w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.url}
                alt={item.title}
                className="block h-auto w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
              />
            )}
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/70 to-transparent p-4">
              <p className="line-clamp-2 text-sm font-medium text-white">{item.title}</p>
            </div>
          </button>
        ))}
      </div>

      <MediaDetailsPreviewModal
        isOpen={Boolean(selectedItem)}
        onClose={() => setSelectedItemId(null)}
        mediaType={selectedItem && (selectedItem.category === 'video' || selectedItem.category === 'motion') ? 'video' : 'image'}
        src={selectedItem?.url ?? null}
        alt={selectedItem?.title ?? 'Selected creation preview'}
        title={selectedItem?.title ?? 'Creation preview'}
        prompt={selectedItem?.prompt ?? ''}
        creator={selectedItem?.creator}
        actions={selectedItem ? (
          <>
            <button
              type="button"
              onClick={() => void handleSave(selectedItem.id)}
              aria-label={`${savedGenerationIds.has(selectedItem.id) ? 'Remove save from' : 'Save'} ${selectedItem.title}. ${selectedItem.saveCount} saves`}
              aria-pressed={savedGenerationIds.has(selectedItem.id)}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
            >
              <Heart
                aria-hidden="true"
                className={`h-4 w-4 ${savedGenerationIds.has(selectedItem.id) ? 'fill-pink-500 text-pink-500' : ''}`}
              />
              <span aria-hidden="true">{selectedItem.saveCount}</span>
            </button>
            <PublicShareButton
              generationId={selectedItem.id}
              title={selectedItem.title}
              description={selectedItem.prompt}
              sourceSurface="showcase"
              accessToken={session?.access_token ?? null}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
            />
            <button
              type="button"
              onClick={() => void handleRemix(selectedItem.id)}
              aria-label={`Remix ${selectedItem.title}. ${selectedItem.remixCount} remixes`}
              className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-purple-600 to-fuchsia-500 px-4 py-2 text-sm font-semibold text-white transition hover:from-purple-500 hover:to-fuchsia-400"
            >
              <Wand2 aria-hidden="true" className="h-4 w-4" />
              <span aria-hidden="true">Remix</span>
              <span
                aria-hidden="true"
                className="rounded-full bg-black/20 px-2 py-0.5 text-xs font-bold"
              >
                {selectedItem.remixCount}
              </span>
            </button>
            <Link
              href={buildShowcaseDetailPath(selectedItem.id)}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
            >
              Open public page
            </Link>
          </>
        ) : null}
      />
    </>
  );
}
