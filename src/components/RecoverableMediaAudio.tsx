'use client';

import type { ReactNode } from 'react';
import ResourceMediaPreview from './ResourceMediaPreview';
import { getDisplayMediaUrl } from '@/lib/media-urls';

/** Stored audio retries through the existing authenticated media route. */
export default function RecoverableMediaAudio({ src, label = 'Audio preview', autoPlay, className, errorAction }: {
  src: string;
  label?: string;
  autoPlay?: boolean;
  className?: string;
  errorAction?: ReactNode;
}) {
  return <ResourceMediaPreview mediaType="audio" url={src} label={label} autoPlay={autoPlay}
    className={className} errorAction={errorAction} resolveUrl={async () => getDisplayMediaUrl(src)} />;
}
