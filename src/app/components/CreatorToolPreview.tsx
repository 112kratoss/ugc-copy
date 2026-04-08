import type { ShowcaseFeedItem } from '@/lib/showcase';

import { HoverVideo } from '@/app/components/HoverVideo';

export function CreatorToolPreview({
  item,
  alt,
  className,
}: {
  item: ShowcaseFeedItem | null | undefined;
  alt: string;
  className: string;
}) {
  if (!item || !item.mediaUrl) {
    return (
      <div
        className={`h-full w-full bg-[linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] ${className}`}
      />
    );
  }

  if (item.mediaKind === 'video') {
    return <HoverVideo src={item.mediaUrl} className={className} autoPlay />;
  }

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={item.mediaUrl} alt={alt || item.title} className={className} />;
}
