'use client';

import { useLayoutEffect, useRef, type RefObject } from 'react';

import { typedText } from '@/lib/typed-before-hydration';

/**
 * Hands a page the text a visitor typed into one of its fields before the page's script ran.
 *
 * The server's HTML draws the field before any script runs, so on a slow connection a
 * visitor can start typing first, and no React hears it. This React build then hydrates a
 * controlled textarea without reading that text back: an empty field keeps it while the
 * page's state stays empty, and the field's next render writes the state over it; a field
 * the server drew text in is set back to that text by the hydration itself. Either way the
 * creators' prompt lost what had been typed a moment after the page came alive
 * (2026-10-31). React's own fix, a change event replayed once hydration commits
 * (`enableHydrationChangeEvent`), ships only in its experimental build;
 * `use-typed-before-hydration.test.tsx` fails once Next's own build carries it.
 *
 * So, once, as the page mounts: text the root layout's capture heard typed into the field
 * (`typed-before-hydration.ts`), where it is no longer what the server drew, is handed to
 * `onTyped`, the page's own change handler, as that input event would have been. A layout
 * effect, so the page holds the text before anything its mount effects wait on (a saved
 * draft's read) comes back, and they take it as the visitor's edit.
 */
export function useTypedBeforeHydration(
  fieldRef: RefObject<HTMLTextAreaElement | null>,
  {
    drawn,
    enabled,
    onTyped,
  }: {
    /** What the server drew in the field: the page's state as it opens. */
    drawn: string;
    /** Off when the page opens on text of its own (a link's prompt, a remix), which wins. */
    enabled: boolean;
    onTyped: (value: string) => void;
  },
): void {
  // The first run acts, with the first render's values. Effects that run again over the
  // same field (Strict Mode, Fast Refresh) find it done: the capture keeps recording
  // after hydration, and by then the field draws the page's own state.
  const handledRef = useRef(false);
  useLayoutEffect(() => {
    if (handledRef.current) return;
    handledRef.current = true;
    const field = fieldRef.current;
    if (!enabled || !field) return;
    const typed = typedText(field);
    if (typed === undefined || typed === drawn) return;
    onTyped(typed);
  });
}
