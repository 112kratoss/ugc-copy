import { REEL_HOST_ATTRIBUTE } from '@/lib/reel-opening-restore';

/**
 * Drawn by a page that opens the reel its address names (Explore, the profile, a creator's
 * posts) and by that page's loading state: the reel's stage covers the page on a `?post=` load
 * only while one is on it (globals.css, `src/lib/reel-opening-restore.ts`). A page that ends with
 * no reel to open draws none, and shows at once.
 */
export default function ReelHostMark() {
  return <span hidden {...{ [REEL_HOST_ATTRIBUTE]: '' }} />;
}
