// How long a post's Explore description may be. The create, edit and publish
// services refuse past it. Kept free of server-only imports, like
// post-limits.ts, so a client component can read it too.
export const DESCRIPTION_MAX_LENGTH = 1000;
