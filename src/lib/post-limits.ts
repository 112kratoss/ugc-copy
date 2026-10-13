// The single source of truth for how long a post title may be. The create,
// edit and publish services reject past it (they read it through
// posts-server.ts); the quick-publish dialog and both composers cap their
// inputs at it. It lives apart from posts-server.ts because that module is
// server-only, and a client component cannot import it.
export const TITLE_MAX_LENGTH = 100;
