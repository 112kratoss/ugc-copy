'use client';

import type { ComponentPropsWithoutRef } from 'react';
import { useInlineMediaPlayback } from './useInlineMediaPlayback';

/** Preview audio shares playback ownership with inline video. */
export default function InlineMediaAudio(props: ComponentPropsWithoutRef<'audio'>) {
  const attach = useInlineMediaPlayback<HTMLAudioElement>();
  return <audio preload="none" {...props} ref={attach} />;
}
