/// <reference types="next/image-types/global" />

// Static image imports (`import tile from './wall/wall-01.jpg'`, the sign-in page's wall) are
// typed as Next types them. Next writes the same reference into next-env.d.ts, which is
// gitignored and only there once `next dev` or `next build` has run, so a fresh checkout's
// `npm run typecheck` (CI runs it before the build) needs it here too. Both name one file, which
// TypeScript reads once.
