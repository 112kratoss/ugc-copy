'use client';

import { useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';

import { thumbhashDataUrl } from '@/lib/thumbhash-data-url';

import type { SearchThumbnail } from '../../../ugc-mobile/lib/public-search-policy/public-search-policy';

/**
 * The picture of a search row that is not a post (a model or tool, a search
 * to try): the cover of a post the row opens, at the frame's size, cropped to
 * fill it (`thumbnail`, 2026-11-15). Decorative: the row's own name says what
 * it is, so the picture says nothing to a screen reader.
 *
 * Under the picture while it loads, its thumbhash's blur where the answer
 * gives one, then the picture fades in. A row with no picture, and a picture
 * that fails to load, keep the row's glyph in the same frame, so a list of
 * rows with and without pictures lines up and nothing is ever a broken image.
 */
export function SearchRowPicture({
  thumbnail,
  icon: Icon,
  className,
  iconClassName = 'h-4 w-4 text-[var(--ui-primary)]',
}: {
  thumbnail: SearchThumbnail | null | undefined;
  /** What the frame holds without a picture: the row's kind (a model, a tool, a search). */
  icon: LucideIcon;
  /** The frame's size and shape, `h-12 w-12 rounded-lg`. */
  className: string;
  iconClassName?: string;
}) {
  // By URL, so a row whose picture changes tries the new one.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const url = thumbnail?.url && thumbnail.url !== failedUrl ? thumbnail.url : null;
  const hash = thumbnail?.thumbhash ?? null;
  const blur = useMemo(() => (url ? thumbhashDataUrl(hash) : null), [hash, url]);
  return (
    <span
      aria-hidden="true"
      data-search-picture={url ? 'picture' : 'placeholder'}
      className={`relative flex shrink-0 items-center justify-center overflow-hidden border border-white/10 bg-white/[0.06] bg-cover bg-center ${className}`}
      style={blur ? { backgroundImage: `url(${blur})` } : undefined}
    >
      {url ? (
        // A preview the server already sized (a 720 px WebP), as a post card's own cover is drawn.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoadedUrl(url)}
          onError={() => setFailedUrl(url)}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ease-out motion-reduce:transition-none ${loadedUrl === url ? 'opacity-100' : 'opacity-0'}`}
        />
      ) : (
        <Icon className={iconClassName} aria-hidden="true" />
      )}
    </span>
  );
}
