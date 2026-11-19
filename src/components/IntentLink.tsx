'use client';

import Link from 'next/link';
import type { ComponentProps, FocusEvent, PointerEvent } from 'react';

import { useIntentPrefetch } from './useIntentPrefetch';

type IntentLinkProps = Omit<ComponentProps<typeof Link>, 'href' | 'prefetch'> & { href: string };

/**
 * A `<Link>` whose page is prefetched only when the reader shows they may follow it (a resting mouse
 * pointer or the keyboard's focus, `useIntentPrefetch`), never as it paints. For links most readers
 * pass by: a post page's creator and "Create your own" prefetched those pages on every view.
 */
export default function IntentLink({ href, onPointerEnter, onFocus, ...rest }: IntentLinkProps) {
  const intent = useIntentPrefetch(href);
  return (
    <Link
      {...rest}
      href={href}
      prefetch={false}
      onPointerEnter={(event: PointerEvent<HTMLAnchorElement>) => {
        intent.onPointerEnter(event);
        onPointerEnter?.(event);
      }}
      onFocus={(event: FocusEvent<HTMLAnchorElement>) => {
        intent.onFocus(event);
        onFocus?.(event);
      }}
    />
  );
}
