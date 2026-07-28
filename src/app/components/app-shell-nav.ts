import {
  Bell,
  Gift,
  Home,
  Layers3,
  MessagesSquare,
  Sparkles,
  Store,
  UserRound,
  Users,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface AppNavItem {
  id: 'home' | 'feed' | 'create' | 'studio' | 'showcase' | 'marketplace' | 'workflow' | 'profile' | 'alerts' | 'invite';
  label: string;
  shortLabel: string;
  href: string;
  description: string;
  icon: LucideIcon;
  match: (pathname: string) => boolean;
}

const isExactOrChild = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

export const APP_NAV_ITEMS: AppNavItem[] = [
  {
    id: 'home',
    label: 'Home',
    shortLabel: 'Home',
    href: '/',
    description: 'Dashboard and recent creative context',
    icon: Home,
    match: (pathname) => pathname === '/',
  },
  {
    id: 'feed',
    label: 'Feed',
    shortLabel: 'Feed',
    href: '/feed',
    description: 'Community notes, prompts, and creations in one column',
    icon: MessagesSquare,
    match: (pathname) => isExactOrChild(pathname, '/feed'),
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
    label: 'Showcase',
    shortLabel: 'Showcase',
    href: '/showcase',
    description: 'Community inspiration and remixable posts',
    icon: Users,
    match: (pathname) =>
      isExactOrChild(pathname, '/showcase') ||
      isExactOrChild(pathname, '/creators'),
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

export function getAppShellTitle(pathname: string) {
  if (pathname.startsWith('/pricing')) return 'Pricing';
  if (pathname.startsWith('/blog')) return 'Blog';
  if (pathname.startsWith('/contact')) return 'Contact';
  if (pathname.startsWith('/login')) return 'Sign in';
  if (pathname.startsWith('/signup')) return 'Sign up';
  if (pathname.startsWith('/post/new')) return 'Share Post';
  if (pathname.startsWith('/marketplace/sell')) return 'Seller';
  if (pathname.startsWith('/notifications')) return 'Alerts';
  if (pathname.startsWith('/templates/new')) return 'Create Template';
  if (pathname.startsWith('/template-runs')) return 'Create From Template';
  if (pathname.startsWith('/templates')) return 'Templates';

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
    // consumer navigation, "Sign in" prompt, or mobile tab bar.
    pathname === '/admin' ||
    pathname.startsWith('/admin/')
  );
}
