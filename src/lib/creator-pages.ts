/**
 * The image, video and motion creators' pages: the `href` of each media tool in
 * `creator-tools.tsx` (a test holds the two to one list). The shell hides its
 * bottom navigation on them (`hidesBottomNav`), and sign-up brings a visitor
 * back to them (`isCreatorPath` in `auth-onboarding.ts`).
 */
export const CREATOR_PAGE_PATHS = ['/create-image', '/create-video', '/create-motion'] as const;
