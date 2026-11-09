'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { FirstSignUpIntro, type FirstSignUpIntroEntrance } from '@/components/onboarding/FirstSignUpIntro';
import {
  decideFirstSignUpIntro,
  FIRST_SIGN_UP_INTRO_COVER_SCRIPT,
  firstSignUpIntroStorage,
  liftFirstSignUpIntroCover,
  markFirstSignUpIntroSeen,
  readFirstSignUpIntroCover,
  readFirstSignUpIntroStore,
} from '@/lib/first-sign-up-intro';

type Gate = { phase: 'deciding' | 'done' } | { phase: 'showing'; entrance: FirstSignUpIntroEntrance };

/**
 * Plays the first sign-up intro over `children` once per browser: mounted on
 * `/onboarding` around the creator-name step, which that page draws only for
 * an account that still needs its name (`src/lib/first-sign-up-intro.ts`).
 *
 * The server's HTML carries an inline script and the intro's ground: when
 * this browser has not seen the intro, the ground covers the step from the
 * first paint, so the step is never seen and then covered. The page's script
 * decides before its first paint too; the flag is set as the intro begins.
 */
export function FirstSignUpIntroGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>({ phase: 'deciding' });
  // Decided once, whatever runs the effect again (Strict Mode).
  const decided = useRef(false);

  useLayoutEffect(() => {
    if (decided.current) return;
    decided.current = true;
    const root = document.documentElement;
    const cover = readFirstSignUpIntroCover(root);
    const storage = firstSignUpIntroStorage();
    const decision = decideFirstSignUpIntro({
      // The address as the browser has it, read where the decision is made:
      // no router needed, and the same answer as the router's on this page.
      pathname: window.location.pathname,
      stored: readFirstSignUpIntroStore(storage),
      pageShown: cover === 'lifted',
    });
    const showing = decision === 'show' && markFirstSignUpIntroSeen(storage);
    if (!showing) liftFirstSignUpIntroCover(root);
    // Set from the effect, not the render: the answer is the browser's
    // (storage, the cover), which the server's render cannot know, and a layout
    // effect gives it before the first paint, so the step is never drawn
    // uncovered and then covered.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGate(showing ? { phase: 'showing', entrance: cover === 'cover' ? 'covered' : 'fade' } : { phase: 'done' });
  }, []);

  // The cover never outlives the page it was drawn for.
  useEffect(() => () => liftFirstSignUpIntroCover(document.documentElement), []);

  return (
    <>
      <div aria-hidden className="fixed inset-0 z-[80] hidden bg-[var(--ui-bg-page)] [html[data-first-sign-up-intro=cover]_&]:block" />
      <script dangerouslySetInnerHTML={{ __html: FIRST_SIGN_UP_INTRO_COVER_SCRIPT }} />
      {children}
      {gate.phase === 'showing'
        ? createPortal(<FirstSignUpIntro entrance={gate.entrance} onDone={() => setGate({ phase: 'done' })} />, document.body)
        : null}
    </>
  );
}
