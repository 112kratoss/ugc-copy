'use client';

import type { ComponentPropsWithoutRef } from 'react';
import { useInlineMediaPlayback } from './useInlineMediaPlayback';

/** User-controlled inline playback: leaving the view pauses, returning never resumes. */
export default function InlineMediaVideo(props: ComponentPropsWithoutRef<'video'>) {
  const attach = useInlineMediaPlayback<HTMLVideoElement>();
  return <video {...props} ref={attach} />;
}
