'use client';

/// <reference types="react/canary" />
import * as React from 'react';
import { useEffect, useLayoutEffect, useRef, type ReactElement } from 'react';

import {
  searchEntranceTransition,
  type SearchEntranceOrigin,
  type SearchEntrancePart as Part,
  type SearchEntranceSide,
} from './search-entrance';

/**
 * React's `<ViewTransition>`, where the React drawing the page has it: the
 * App Router's (Next ships React's canary build, which does) and not the
 * stable package the unit tests run on, where every part draws as itself.
 * Read once, as the module loads: the React a page is drawn with never changes.
 */
const ViewTransition = (React as { ViewTransition?: typeof React.ViewTransition }).ViewTransition;

/**
 * One travelling part of search's entrance (search-entrance.ts): its only
 * child, an element, is named for the control it belongs to, so a navigation
 * between that control and the search page's field morphs the one into the
 * other.
 *
 * With no origin (the page opened from the side navigation, or by address)
 * the field is drawn at rest and nothing is named, but the part is still a
 * boundary that animates nothing: its mounting is what has React start a
 * view transition for that navigation, so the screen cross-fades all the same
 * (`useSearchScreenCrossFade`). Never one boundary around the whole page: React
 * names a boundary inside another that arrives or leaves only when it pairs,
 * so the field's words would no longer fade in where a round button has none.
 *
 * A control with no origin is drawn as itself, with no boundary at all: it
 * never starts a transition of its own (Explore's bar while it is not named,
 * SearchEntryLink).
 */
export function SearchEntrancePart({
  origin,
  part,
  side,
  children,
}: {
  origin: SearchEntranceOrigin | null;
  part: Part;
  side: SearchEntranceSide;
  children: ReactElement;
}) {
  if (!ViewTransition) return children;
  if (!origin) return side === 'field' ? <ViewTransition default="none">{children}</ViewTransition> : children;
  return <ViewTransition {...searchEntranceTransition(origin, part, side)}>{children}</ViewTransition>;
}

/**
 * An unseen stand-in for a part a control has no use for (the round
 * magnifier's words, a clear button while the control holds no text), so the
 * field's part always has a pair to travel into and out of. It takes no room,
 * no pointer and no place in the accessibility tree; `className` places it.
 */
export function SearchEntranceStandIn({
  origin,
  part,
  className,
}: {
  origin: SearchEntranceOrigin | null;
  part: Part;
  className: string;
}) {
  return (
    <SearchEntrancePart origin={origin} part={part} side="control">
      <span aria-hidden="true" data-search-entrance-stand-in={part} className={`pointer-events-none absolute opacity-0 ${className}`} />
    </SearchEntrancePart>
  );
}

/**
 * The screen cross-fades as search opens and as it closes, as the app's
 * navigator fades (200 ms, globals.css). React leaves the document's root out
 * of a view transition when no boundary of its own covers it, by writing
 * `view-transition-name: none` on it, and only when nothing is written there
 * already. So the page writes `root` there while it is drawn: from its
 * mount's layout effect, which runs before React's check in the navigation
 * that opens it, until after the navigation that leaves it has been captured
 * (a passive cleanup runs after the transition's update; a layout cleanup
 * would run before React's check and lose the fade). It clears only a name it
 * wrote itself: one another page set first stays (review of #817).
 */
export function useSearchScreenCrossFade() {
  const wroteRoot = useRef(false);
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (root.style.viewTransitionName !== '') return;
    root.style.viewTransitionName = 'root';
    wroteRoot.current = true;
  }, []);
  useEffect(() => () => {
    if (!wroteRoot.current) return;
    wroteRoot.current = false;
    const root = document.documentElement;
    if (root.style.viewTransitionName === 'root') root.style.viewTransitionName = '';
  }, []);
}
