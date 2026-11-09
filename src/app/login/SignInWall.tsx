import Image from 'next/image';
import type { CSSProperties } from 'react';

import { signInWallColumnOrder } from '@/lib/sign-in-page';

import wall01 from './wall/wall-01.jpg';
import wall02 from './wall/wall-02.jpg';
import wall03 from './wall/wall-03.jpg';
import wall04 from './wall/wall-04.jpg';
import wall05 from './wall/wall-05.jpg';
import wall06 from './wall/wall-06.jpg';
import wall07 from './wall/wall-07.jpg';
import wall08 from './wall/wall-08.jpg';
import wall09 from './wall/wall-09.jpg';
import wall10 from './wall/wall-10.jpg';
import wall11 from './wall/wall-11.jpg';
import wall12 from './wall/wall-12.jpg';

/** The app's twelve pictures (`ugc-mobile/assets/images/sign-in-wall/`), the same files. */
const TILES = [wall01, wall02, wall03, wall04, wall05, wall06, wall07, wall08, wall09, wall10, wall11, wall12] as const;

/**
 * The most columns any screen shows. Phones show five, as the app does; wider screens more, so a
 * tile stays about the size it is on a phone instead of growing with the screen (the
 * `.sign-in-wall-column` rules in `globals.css` show the first 5, 7, 9 or 11).
 */
const COLUMNS = 11;

/**
 * The wall of creations behind the sign-in page (owner, 2026-11-08, for the app: "medias in the
 * background in a loop"), the app's `MediaWall` drawn by the browser: columns tilted -10° that
 * drift past each other, neighbours in opposite directions and at their own pace, looping
 * without a seam, from a point picked for each visit.
 *
 * All of the motion is CSS (`.sign-in-wall*` in `globals.css`), so it starts with the server's
 * HTML, before any script, and only transforms move, which the compositor draws. Each column is
 * its six pictures twice over, a tile's gap under each, and slides by exactly half its own height
 * (one set) before it starts again. Reduce Motion holds it still.
 *
 * Drawn on the server and handed to the page (`page.tsx`), so the 132 tiles are no part of the
 * page's script. The pictures are 360×640 JPEGs of 16 to 56 KB, the size a phone's tile wants at
 * 3×, so they are served as they are: through the optimizer every tile would carry a srcset of a
 * dozen widths, about 100 KB more HTML on a page drawn for every request.
 */
export default function SignInWall({ start }: {
  /** Where along its loop every column starts, 0 to 1, picked by the server for each visit. */
  start: number;
}) {
  return (
    <div
      aria-hidden
      className="sign-in-wall"
      style={{ '--sign-in-wall-start': start.toFixed(4) } as CSSProperties}
    >
      <div className="sign-in-wall-frame">
        <div className="sign-in-wall-columns">
          {Array.from({ length: COLUMNS }, (_, column) => {
            const tiles = signInWallColumnOrder(column).map((index) => TILES[index]);
            return (
              <div key={column} className="sign-in-wall-column">
                {[...tiles, ...tiles].map((tile, index) => (
                  <div key={index} className="sign-in-wall-tile">
                    <Image src={tile} alt="" unoptimized loading="eager" fetchPriority="low" draggable={false} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
