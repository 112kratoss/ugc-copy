import type { ReactNode } from 'react';

/**
 * The shared home layout: community feed in the center, a sticky context rail
 * on the right. Both `/` variants render through this shell — the signed-out
 * page (`AnonymousHome`) and the signed-in dashboard (`src/app/home/page.tsx`)
 * — so the two look and behave like one product rather than two designs.
 *
 * Below `xl` the rail is dropped entirely; `inlineStrip` is where a variant
 * puts the one piece of rail context that still earns its place on a narrow
 * screen (active renders for signed-in users; nothing for signed-out, whose
 * hero already carries the sign-in call to action).
 */
export default function HomeExperience({
  hero,
  inlineStrip,
  feed,
  rail,
  footer,
}: {
  hero?: ReactNode;
  inlineStrip?: ReactNode;
  feed: ReactNode;
  rail: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="ui-page relative flex flex-col">
      <div className="mx-auto w-full max-w-[1200px] flex-1 px-4 pb-24 pt-6 sm:px-6">
        {/*
          The two-column switch and the rail's sticky behaviour come from named
          classes in globals.css, not responsive utilities: authenticated routes
          load a second utility sheet after that one, and its re-emitted
          `.hidden` would override an `xl:flex` rail at every width.
        */}
        <div className="home-grid">
          <div className="home-column">
            {hero}
            {inlineStrip ? <div className="home-inline-strip">{inlineStrip}</div> : null}
            {feed}
          </div>

          <aside aria-label="Workspace sidebar" className="home-rail">
            {rail}
          </aside>
        </div>
      </div>

      {footer}
    </div>
  );
}
