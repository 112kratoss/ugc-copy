'use client';

import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Hands a page what one of its inputs holds as the page mounts, where something put it there
 * before the page's script ran: the visitor's typing, or the browser filling a saved login in.
 *
 * The server's HTML draws the field before any script runs, and no React hears what goes into
 * it then. The React that Next bundles (a 19.3 canary; vitest runs 19.2) hydrates an input
 * without reading its value back (`initInput` leaves the value alone while it hydrates), so the
 * field keeps that text while the page's state keeps what the server drew, and the field's next
 * render writes the state over it. On /login an Enter pressed once the script had run signed in
 * with an empty email and password, and the render that followed emptied both fields
 * (2026-11-01). React's own fix, a change event replayed once hydration commits
 * (`enableHydrationChangeEvent`), ships only in its experimental build
 * (`use-typed-before-hydration.test.tsx` fails once Next's own build carries it, and then this
 * hook can go too). A select loses its choice the same way: hydration leaves the option chosen
 * before the script alone, and the select's next commit chooses the state's (/contact's subject).
 *
 * So, once, as the page mounts: a value that is no longer what the server drew is handed to
 * `onValue`, the page's own change handler, as that change event would have been. A layout
 * effect, so the page holds the value in the same task as the commit, before the browser can
 * hand React the visitor's next key. Call it in the component that draws the field, with no
 * Suspense or Activity boundary between them: a field that hydrates in a later commit than the
 * caller is not there when the hook looks, and is never read.
 *
 * What the field shows counts, whatever put it there, so this suits a field the page only
 * sends, as a sign-in sends what the visitor sees. A field whose text the page keeps takes only
 * typing, through `useTypedBeforeHydration`: the creators save their prompt as a draft, and a
 * prompt a browser put back when it restored the form can be another account's or a stale
 * tab's. A textarea needs that hook anyway, as its hydration writes the server's text back.
 */
export function useFieldValueBeforeHydration(
  fieldRef: RefObject<HTMLInputElement | HTMLSelectElement | null>,
  {
    drawn,
    onValue,
  }: {
    /** What the server drew in the field: the page's state as it opens. */
    drawn: string;
    onValue: (value: string) => void;
  },
): void {
  // The first run acts, with the first render's values. Strict Mode runs a hydrated field's
  // layout effects again before the value handed over has drawn, the field still holding the
  // early text against the first render's `drawn`; later runs find the page's own state in it.
  const handledRef = useRef(false);
  useLayoutEffect(() => {
    if (handledRef.current) return;
    handledRef.current = true;
    const value = fieldRef.current?.value;
    if (value === undefined || value === drawn) return;
    onValue(value);
  });
}
