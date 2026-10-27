import {
  Bell,
  Gift,
  Home,
  Layers3,
  Search,
  Sparkles,
  Store,
  UserRound,
  Users,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface AppNavItem {
  id: 'home' | 'create' | 'studio' | 'showcase' | 'search' | 'marketplace' | 'workflow' | 'profile' | 'alerts' | 'invite';
  label: string;
  shortLabel: string;
  href: string;
  description: string;
  icon: LucideIcon;
  match: (pathname: string) => boolean;
}

const isExactOrChild = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

/**
 * A single-segment child of `href` — `/showcase/abc` but not `/showcase` and
 * not `/showcase/abc/def`. Query strings and hashes are ignored so a filtered
 * feed still reads as the section itself.
 */
const isDetailChildOf = (pathname: string, href: string) => {
  const path = pathname.split(/[?#]/)[0];
  if (!path.startsWith(`${href}/`)) return false;

  const segment = path.slice(href.length + 1);
  return segment.length > 0 && !segment.includes('/');
};

/**
 * A post and a creator profile are their own surfaces, not sub-pages of the
 * Explore feed they happen to sit under in the path. Either can be reached
 * from Home, Marketplace, Studio, a profile, or a shared link, so claiming the
 * Explore nav item would tell the viewer they are somewhere they are not.
 * Both get their own title below instead.
 */
const isPostDetailPath = (pathname: string) => isDetailChildOf(pathname, '/showcase');
const isCreatorProfilePath = (pathname: string) => isDetailChildOf(pathname, '/creators');

export const APP_NAV_ITEMS: AppNavItem[] = [
  {
    id: 'home',
    label: 'Home',
    shortLabel: 'Home',
    href: '/',
    description: 'Community feed and your creative workspace',
    icon: Home,
    // `/home` is the middleware rewrite target for signed-in `/` — match it
    // too in case a server-rendered pathname leaks through.
    match: (pathname) => pathname === '/' || pathname === '/home',
  },
  {
    id: 'create',
    label: 'Create',
    shortLabel: 'Create',
    href: '/create',
    description: 'Launch image, video, motion, template, and workflow tools',
    icon: Sparkles,
    match: (pathname) =>
      isExactOrChild(pathname, '/create') ||
      pathname.startsWith('/create-image') ||
      pathname.startsWith('/create-video') ||
      pathname.startsWith('/create-motion') ||
      isExactOrChild(pathname, '/templates') ||
      isExactOrChild(pathname, '/template-runs'),
  },
  {
    id: 'studio',
    label: 'Studio',
    shortLabel: 'Studio',
    href: '/creations',
    description: 'Your generations, posts, and media library',
    icon: Layers3,
    match: (pathname) => isExactOrChild(pathname, '/creations') || isExactOrChild(pathname, '/post'),
  },
  {
    id: 'showcase',
    label: 'Explore',
    shortLabel: 'Explore',
    href: '/showcase',
    description: 'Community inspiration and remixable posts',
    icon: Users,
    match: (pathname) =>
      !isPostDetailPath(pathname) &&
      !isCreatorProfilePath(pathname) &&
      (isExactOrChild(pathname, '/showcase') || isExactOrChild(pathname, '/creators')),
  },
  {
    id: 'search',
    label: 'Search',
    shortLabel: 'Search',
    href: '/search',
    description: 'Find creators, public posts, and reusable recipes',
    icon: Search,
    match: (pathname) => isExactOrChild(pathname, '/search'),
  },
  {
    id: 'marketplace',
    label: 'Marketplace',
    shortLabel: 'Market',
    href: '/marketplace',
    description: 'Reusable post recipes and creator assets',
    icon: Store,
    match: (pathname) => isExactOrChild(pathname, '/marketplace'),
  },
  {
    id: 'workflow',
    label: 'Workflow Canvas',
    shortLabel: 'Flow',
    href: '/create-workflow',
    description: 'Build reusable prompt and generation systems',
    icon: Workflow,
    match: (pathname) =>
      isExactOrChild(pathname, '/create-workflow') ||
      isExactOrChild(pathname, '/ai-workflow-builder') ||
      isExactOrChild(pathname, '/workflow-canvases'),
  },
  {
    id: 'alerts',
    label: 'Alerts',
    shortLabel: 'Alerts',
    href: '/notifications',
    description: 'Your generation results, updates, and community activity',
    icon: Bell,
    match: (pathname) => isExactOrChild(pathname, '/notifications'),
  },
  {
    id: 'invite',
    label: 'Invite & Earn',
    shortLabel: 'Invite',
    href: '/invite',
    description: 'Share your referral link and track bonus credits',
    icon: Gift,
    match: (pathname) => isExactOrChild(pathname, '/invite'),
  },
  {
    id: 'profile',
    label: 'Profile',
    shortLabel: 'You',
    href: '/profile',
    description: 'Account, creator identity, and settings',
    icon: UserRound,
    match: (pathname) => isExactOrChild(pathname, '/profile'),
  },
];

export function getActiveAppNavItem(pathname: string) {
  return APP_NAV_ITEMS.find((item) => item.match(pathname)) ?? null;
}

/**
 * Pages that open with a heading of their own: the top bar names none of
 * them, where it used to say the page's name and section line just above the
 * page saying it again ("Studio" over "Studio").
 */
const OWN_HEADING_PATHS = new Set([
  '/showcase',
  '/creations',
  '/create',
  '/search',
  '/marketplace',
  '/notifications',
  '/invite',
  '/credits',
  '/pricing',
  '/templates',
]);
const OWN_HEADING_SECTIONS = ['/profile', '/models', '/marketplace/sell', '/post'];

function pageHasOwnHeading(pathname: string) {
  return OWN_HEADING_PATHS.has(pathname)
    || OWN_HEADING_SECTIONS.some((section) => isExactOrChild(pathname, section));
}

/** The top bar's title, or null on a page whose own heading says what it is. */
export function getAppShellTitle(pathname: string): string | null {
  if (pageHasOwnHeading(pathname)) return null;
  if (pathname.startsWith('/alternatives')) return 'Compare';
  if (pathname.startsWith('/ai-image-generator')) return 'AI image generator';
  if (pathname.startsWith('/ai-video-generator')) return 'AI video generator';
  if (pathname.startsWith('/ai-motion-transfer')) return 'Motion transfer';
  if (pathname.startsWith('/blog')) return 'Blog';
  if (pathname.startsWith('/contact')) return 'Contact';
  if (pathname.startsWith('/login')) return 'Sign in';
  if (pathname.startsWith('/signup')) return 'Sign up';
  if (pathname.startsWith('/templates/new')) return 'Create Template';
  if (pathname.startsWith('/template-runs')) return 'Create From Template';
  if (pathname.startsWith('/templates')) return 'Templates';
  // Required, not decoration: no nav item claims these paths, so without an
  // override the fallback below would read "Workspace".
  if (isPostDetailPath(pathname)) return 'Post';
  if (isCreatorProfilePath(pathname)) return 'Creator';

  return getActiveAppNavItem(pathname)?.label ?? 'Workspace';
}

export function isMinimalAppChromePath(pathname: string) {
  return (
    pathname === '/child-safety' ||
    pathname === '/auth' ||
    pathname.startsWith('/auth/') ||
    pathname === '/login' ||
    pathname.startsWith('/login?') ||
    pathname.startsWith('/r/') ||
    // The admin console renders its own operator chrome and must not show the
    // consumer navigation, "Sign in" prompt, or mobile tab bar. An address
    // with no page under /admin is not the console: it is Next's not-found
    // page, which keeps the shell it was prerendered with (AppShellClient).
    pathname === '/admin' ||
    pathname.startsWith('/admin/')
  );
}

/**
 * Whether the root layout's selected segment is Next's not-found route, which
 * answers every address with no page. The bundler decides its spelling:
 * `/_not-found` under Turbopack (`next build`), `_not-found` under webpack
 * (`npm run dev`).
 */
export function isNotFoundRouteSegment(segment: string | null) {
  return segment === '/_not-found' || segment === '_not-found';
}

export interface CreateMenuItem {
  id: 'create' | 'post';
  label: string;
  body: string;
}

/**
 * The shell's Create menu, in the app's words: its centre + offers the same two
 * choices (`ugc-mobile/lib/create-menu-view-model.ts`) under the same heading
 * (`ugc-mobile/components/magic-create-menu.tsx`). `create-menu-parity.test.ts`
 * holds the two to one wording.
 */
export const CREATE_MENU_TITLE = 'Create or publish';
export const CREATE_MENU_SUBTITLE = 'Start with AI, or share work you already have.';
export const CREATE_MENU_ITEMS: readonly CreateMenuItem[] = [
  { id: 'create', label: 'Create', body: 'Image, Video, and Motion' },
  { id: 'post', label: 'Post', body: 'Share finished media' },
];

/**
 * The page a post was started on, for the composer: its `from` decides where
 * the composer's Back goes and what it says (`NewPostClient`), so the menu
 * names the page and no more. A page the composer has no Back for sends none,
 * and the composer goes back to Explore.
 */
const POST_COMPOSER_SOURCES: ReadonlyArray<{ matches: (pathname: string) => boolean; from: string }> = [
  { matches: (pathname) => pathname === '/' || pathname === '/home', from: 'home' },
  { matches: (pathname) => pathname === '/showcase', from: 'community' },
  { matches: (pathname) => isExactOrChild(pathname, '/profile'), from: 'profile' },
  { matches: (pathname) => isExactOrChild(pathname, '/marketplace/sell'), from: 'seller' },
  { matches: (pathname) => pathname === '/marketplace', from: 'marketplace' },
  { matches: (pathname) => pathname === '/creations', from: 'creations' },
];

export function getCreateMenuHref(id: CreateMenuItem['id'], pathname: string): string {
  if (id === 'create') return '/create';
  const source = POST_COMPOSER_SOURCES.find((entry) => entry.matches(pathname));
  return source ? `/post/new?${new URLSearchParams({ from: source.from })}` : '/post/new';
}
