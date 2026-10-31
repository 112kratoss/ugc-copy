'use client';

import clsx from 'clsx';
import { useState } from 'react';
import { ImageIcon, NotebookText, Play, ShoppingBag } from 'lucide-react';

import { getAccentClasses } from '@/components/DesignSystem';
import { OptimizedPreviewImage } from '@/components/OptimizedPreviewImage';

interface SellerRecipeCoverPost {
  postFormat?: string;
  mediaKind?: string | null;
  mediaUrl?: string | null;
  mediaPreviewUrl?: string | null;
}

const COVER_SIZES = { md: 'w-12', sm: 'w-10' } as const;

/**
 * A post's cover at a row's size, in the 4:5 frame its tile has elsewhere: the
 * picture, a clip's poster (never the clip, which a list of covers would
 * download in full), or a mark for a note, a post with nothing to draw, or a
 * picture that would not load. Decorative: the title beside it names the post.
 */
export default function SellerRecipeCover({
  post,
  size = 'md',
}: {
  post: SellerRecipeCoverPost | null;
  size?: keyof typeof COVER_SIZES;
}) {
  const [failed, setFailed] = useState(false);
  const poster = post?.mediaKind === 'video' ? post.mediaPreviewUrl : post?.mediaPreviewUrl ?? post?.mediaUrl;
  const frame = clsx(
    'relative aspect-[4/5] shrink-0 overflow-hidden rounded-ui-md border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)]',
    COVER_SIZES[size],
  );

  if (poster && !failed && (post?.mediaKind === 'image' || post?.mediaKind === 'video')) {
    return (
      <span className={frame} aria-hidden="true">
        <OptimizedPreviewImage
          previewSrc={poster}
          fallbackSrc={post.mediaKind === 'image' ? post.mediaUrl : null}
          alt=""
          sizes="48px"
          className="object-cover"
          onError={() => setFailed(true)}
        />
        {post.mediaKind === 'video' ? (
          <Play className="absolute bottom-1 left-1 h-3 w-3 fill-current text-[var(--ui-text-primary)]" aria-hidden="true" />
        ) : null}
      </span>
    );
  }

  const mark = post?.mediaKind === 'video'
    ? { icon: Play, accent: getAccentClasses('video').mark }
    : post?.mediaKind === 'image'
      ? { icon: ImageIcon, accent: getAccentClasses('image').mark }
      : post?.postFormat === 'text'
        ? { icon: NotebookText, accent: getAccentClasses('neutral').mark }
        : { icon: ShoppingBag, accent: getAccentClasses('neutral').mark };
  const Icon = mark.icon;

  return (
    <span className={clsx(frame, 'flex items-center justify-center')} aria-hidden="true">
      <Icon className={clsx('h-4 w-4', mark.accent)} aria-hidden="true" />
    </span>
  );
}
