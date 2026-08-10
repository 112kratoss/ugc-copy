import type { ShowcaseFeedItem } from '@/lib/showcase';

import { HoverVideo } from '@/app/components/HoverVideo';
import { OptimizedPreviewImage } from '@/app/components/OptimizedPreviewImage';

function getCoverMedia(item: ShowcaseFeedItem) {
  return item.mediaItems?.reduce(
    (cover, media) => media.sortOrder < cover.sortOrder ? media : cover
  ) ?? null;
}

export function CreatorToolPreview({
  item,
  alt,
  className,
  priority = false,
}: {
  item: ShowcaseFeedItem | null | undefined;
  alt: string;
  className: string;
  priority?: boolean;
}) {
  if (!item || !item.mediaUrl) {
    return (
      <div
        className={`h-full w-full bg-[linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] ${className}`}
      />
    );
  }

  const coverMedia = getCoverMedia(item);
  const mediaUrl = coverMedia?.renditionUrl ?? coverMedia?.url ?? item.mediaUrl;
  const mediaKind = coverMedia?.mediaKind ?? item.mediaKind;
  const previewUrl = coverMedia?.previewUrl ?? null;
  const prioritizePreview = priority && Boolean(previewUrl);

  if (mediaKind === 'video') {
    return (
      <HoverVideo
        src={mediaUrl}
        poster={previewUrl}
        className={className}
      />
    );
  }

  return (
    <div className="relative h-full w-full">
      <OptimizedPreviewImage
        previewSrc={previewUrl ?? mediaUrl}
        fallbackSrc={mediaUrl}
        alt={alt || item.title}
        sizes="(min-width: 1280px) 25vw, (min-width: 768px) 50vw, 100vw"
        className={className}
        priority={prioritizePreview}
      />
    </div>
  );
}
