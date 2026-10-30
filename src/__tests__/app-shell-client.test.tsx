import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { UNDERSCORE_NOT_FOUND_ROUTE } from 'next/dist/shared/lib/entry-constants';
import { NOT_FOUND_SEGMENT_KEY } from 'next/dist/shared/lib/segment';
import { useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AppShellClient from '@/components/AppShellClient';
import FeedbackViewport from '@/components/FeedbackViewport';
import type { ConfirmationRequest } from '@/components/feedback-state';
import { publishUnreadAlertsCount } from '@/components/useUnreadAlertsCount';
import { useLeaveGuard } from '@/lib/use-leave-guard';

let mockedPathname = '/';
/** The root layout's selected segment: the route's first segment. */
let mockedSegment: string | null = null;
let mockedScrollY = 0;
let mockedReducedMotion = false;
/** Hrefs the mocked Link and Form would have navigated to: their handlers left the click or the submit alone. */
const navigations: string[] = [];
/** How many times a shell link has been drawn. */
let linkRenders = 0;
const scrollToMock = vi.fn((options: ScrollToOptions | number) => {
  mockedScrollY = typeof options === 'number' ? options : options.top ?? 0;
});

const routerMocks = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => mockedPathname,
  useRouter: () => routerMocks,
  useSelectedLayoutSegment: () => mockedSegment,
}));

vi.mock('next/form', () => ({
  default: ({ onSubmit, ...props }: ComponentPropsWithoutRef<'form'>) => (
    <form
      {...props}
      onSubmit={(event) => {
        // Next's Form runs the handler first and, unless it prevented the
        // submit, navigates to the action with the fields as its query.
        onSubmit?.(event);
        if (!event.defaultPrevented) {
          const query = new URLSearchParams();
          new FormData(event.currentTarget).forEach((value, name) => query.append(name, String(value)));
          navigations.push(`${String(props.action)}?${query}`);
        }
        event.preventDefault();
      }}
    />
  ),
}));

vi.mock('next/link', () => ({
  default: ({
    prefetch,
    scroll,
    onClick,
    ...props
  }: ComponentPropsWithoutRef<'a'> & { prefetch?: boolean; scroll?: boolean }) => {
    linkRenders += 1;
    return (
      <a
        {...props}
        data-prefetch={prefetch === undefined ? undefined : String(prefetch)}
        data-scroll={scroll === undefined ? undefined : String(scroll)}
        onClick={(event) => {
          // Next's Link runs the handler first and navigates unless it prevented
          // the click; jsdom must not follow the href either way.
          onClick?.(event);
          if (!event.defaultPrevented) navigations.push(String(props.href));
          event.preventDefault();
        }}
      />
    );
  },
}));

/**
 * Draws the shell as the server did at `server` (renderToString), then
 * hydrates that HTML where the browser reads `browser`, as Next does. React
 * throws on a structure or text mismatch, which reaches onRecoverableError; an
 * attribute that differs is never patched and only warned about in
 * development, so those warnings are collected too. Testing Library's cleanup
 * unmounts the root and removes the container after each test.
 */
function hydrateShell({
  server,
  browser,
  segment = null,
  content = 'Page content',
}: {
  server: string;
  browser: string;
  segment?: string | null;
  content?: string;
}) {
  const shell = () => (
    <AppShellClient>
      <div>{content}</div>
    </AppShellClient>
  );
  mockedSegment = segment;
  mockedPathname = server;
  const container = document.createElement('div');
  container.innerHTML = renderToString(shell());
  document.body.appendChild(container);
  mockedPathname = browser;

  const onRecoverableError = vi.fn();
  const consoleError = vi.spyOn(console, 'error');
  try {
    render(shell(), { container, hydrate: true, onRecoverableError });
    const attributeWarnings = consoleError.mock.calls
      .map((args) => args.map(String).join(' '))
      .filter((message) => message.includes("didn't match the client properties"));
    return { container, onRecoverableError, attributeWarnings };
  } finally {
    consoleError.mockRestore();
  }
}

/**
 * The Create menu: a closed popover, which jsdom draws as display: none, so
 * its heading names it to no query (in a browser it does once open).
 */
function createMenu() {
  const menu = document.getElementById('app-shell-create-menu');
  if (!menu) throw new Error('No Create menu in the shell');
  return menu;
}

/**
 * Stands the menu open as a browser with popovers would. jsdom has none, and
 * the menu asks the prototype whether the browser does, so this goes after
 * the render: the menu's effects ran as in a browser without them.
 */
function standMenuOpen(menu: HTMLElement) {
  const hidePopover = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: vi.fn() });
  Object.assign(menu, { hidePopover, matches: (selector: string) => selector === ':popover-open' });
  return hidePopover;
}

describe('AppShellClient', () => {
  beforeEach(() => {
    mockedPathname = '/';
    mockedSegment = null;
    mockedScrollY = 0;
    mockedReducedMotion = false;
    navigations.length = 0;
    scrollToMock.mockClear();
    document.body.style.overflow = '';
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      get: () => mockedScrollY,
    });
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      value: scrollToMock,
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: mockedReducedMotion })),
    });
  });

  it('uses the home shell title after mounting when the pathname is empty', () => {
    mockedPathname = '';

    render(
      <AppShellClient>
        <div>Page content</div>
      </AppShellClient>
    );

    expect(within(screen.getByRole('banner')).getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Page content')).toBeInTheDocument();
  });

  it('hydrates the root shell without recovering from a route markup mismatch', () => {
    const view = hydrateShell({ server: '/_not-found', browser: '/', content: 'Home content' });

    // Only a mismatch React throws on is checked: from this internal pathname
    // the header's Sign in link keeps the server's return address.
    expect(view.onRecoverableError).not.toHaveBeenCalled();
    expect(within(view.container).getByRole('banner')).toHaveTextContent('Home');
    expect(within(view.container).getAllByRole('link', { name: 'Home', current: 'page' })).not.toEqual([]);
  });

  it('hydrates the rewritten dashboard (/home on the server, / in the browser) without mismatch', () => {
    // Signed-in `/` is middleware-rewritten to `/home` (src/proxy.ts): the
    // server render sees the internal pathname while the hydrated client
    // sees the browser URL. Both must resolve to identical shell markup.
    const view = hydrateShell({ server: '/home', browser: '/', content: 'Dashboard content' });

    expect(view.onRecoverableError).not.toHaveBeenCalled();
    // The header's Sign in link included: it returns Home on both sides.
    expect(view.attributeWarnings).toEqual([]);
    expect(within(view.container).getByRole('banner')).toHaveTextContent('Home');
    expect(within(view.container).getAllByRole('link', { name: 'Home', current: 'page' })).not.toEqual([]);
  });

  it('does not draw the shell again when only the router state around its pathname changes', () => {
    // The root segment comes from the router's whole state, which also changes
    // for a query-only address change (the Explore reel's replaceState): the
    // frame draws again only for a new pathname or not-found flag.
    mockedPathname = '/showcase';
    const content = <div>Explore content</div>;
    const view = render(<AppShellClient>{content}</AppShellClient>);
    const drawn = linkRenders;

    view.rerender(<AppShellClient>{content}</AppShellClient>);

    expect(linkRenders).toBe(drawn);
  });

  describe('the not-found page', () => {
    // In production every address with no page is answered with the one
    // build-time `/_not-found` prerender: its shell was drawn for that internal
    // pathname, while the browser reads the address it visited. The route tree
    // comes with the page, so the root's selected segment is Next's not-found
    // key on both sides (a Turbopack build's spelling).
    it.each([
      // Drawn without the shell when a page is there.
      '/auth/zz-no-such-step',
      '/r/zz/no-such-code',
      '/admin/zz-no-such-tool',
      // A section title or a tab of their own.
      '/login/zz-no-such-step',
      '/blog/zz/no-such-post',
      '/pricing/zz-no-such-plan',
      '/creations/zz/no-such-item',
      '/search/zz-no-such-query',
      '/showcase/zz/no-such-post',
    ])('hydrates at %s as it was drawn, and keeps that shell', (address) => {
      const view = hydrateShell({
        server: '/_not-found',
        browser: address,
        segment: NOT_FOUND_SEGMENT_KEY,
        content: 'Not-found content',
      });

      expect(view.onRecoverableError).not.toHaveBeenCalled();
      expect(view.attributeWarnings).toEqual([]);
      // Mounted, it still reads the same at every address: the neutral title,
      // no section claiming an address that has no page, and a Sign in that
      // returns Home rather than to that address.
      const shell = within(view.container);
      expect(shell.getByRole('banner')).toHaveTextContent('Workspace');
      expect(shell.getByRole('main')).toHaveTextContent('Not-found content');
      expect(shell.queryAllByRole('link', { current: 'page' })).toEqual([]);
      expect(shell.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?returnUrl=%2F');
    });

    it('reads the webpack spelling of the segment, and follows the address again after a link out', () => {
      // `next dev --webpack` names the segment after the route without its
      // slash (next-app-loader) and renders the page per request with the
      // visited address.
      mockedSegment = UNDERSCORE_NOT_FOUND_ROUTE.slice(1);
      mockedPathname = '/auth/zz-no-such-step';

      const view = render(
        <AppShellClient>
          <div>Not-found content</div>
        </AppShellClient>
      );

      expect(within(screen.getByRole('banner')).getByText('Workspace')).toBeInTheDocument();

      // A link out of the not-found page swaps the route tree under the shell.
      mockedSegment = 'blog';
      mockedPathname = '/blog';
      view.rerender(
        <AppShellClient>
          <div>Blog content</div>
        </AppShellClient>
      );

      expect(within(screen.getByRole('banner')).getByText('Blog')).toBeInTheDocument();
    });
  });

  it('server-renders the current route title instead of a stale home title', () => {
    mockedPathname = '/create-workflow';

    const html = renderToString(
      <AppShellClient>
        <div>Canvas content</div>
      </AppShellClient>
    );

    expect(html).toContain('Build reusable prompt and generation systems');
    expect(html).toContain('Canvas content');
  });

  it('shows the mounted pathname title and selected navigation state', () => {
    mockedPathname = '/create-workflow';

    render(
      <AppShellClient>
        <div>Canvas content</div>
      </AppShellClient>
    );

    expect(within(screen.getByRole('banner')).getByText('Workflow Canvas')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Workflow Canvas' }).some((link) => link.getAttribute('aria-current') === 'page')).toBe(true);
  });

  it('leaves the naming to a page with a heading of its own, and still marks its section', () => {
    mockedPathname = '/marketplace';

    render(
      <AppShellClient>
        <h1>Buy the reusable parts behind community posts</h1>
      </AppShellClient>
    );

    // The bar said "Marketplace" and its section line over the page's own heading.
    const banner = screen.getByRole('banner');
    expect(within(banner).queryByText('Marketplace')).not.toBeInTheDocument();
    expect(within(banner).queryByText('Reusable post recipes and creator assets')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('complementary', { name: 'Primary navigation' }))
        .getByRole('link', { name: 'Marketplace' })
    ).toHaveAttribute('aria-current', 'page');
  });

  it('presents a post as its own surface rather than part of Explore', () => {
    mockedPathname = '/showcase/post-1';

    render(
      <AppShellClient>
        <div>Post content</div>
      </AppShellClient>
    );

    const banner = screen.getByRole('banner');
    expect(within(banner).getByText('Post')).toBeInTheDocument();
    // The section subtitle would otherwise compete with the post's own <h1>.
    expect(within(banner).queryByText('Community inspiration and remixable posts')).not.toBeInTheDocument();
    // A post belongs to no section, so nothing in the shell claims it.
    expect(
      screen.getAllByRole('link').some((link) => link.getAttribute('aria-current') === 'page')
    ).toBe(false);
  });

  it("lists places in the side navigation, and leaves the top bar's controls to the top bar", () => {
    render(
      <AppShellClient>
        <div>Page content</div>
      </AppShellClient>
    );

    // Search is the bar's field, Alerts its bell, Create its menu, and
    // Invite & Earn the account menu's: each was named in both before.
    const sideNavigation = screen.getByRole('complementary', { name: 'Primary navigation' });
    expect(within(sideNavigation).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'magicbookletCreator studio',
      'Home',
      'Explore',
      'Marketplace',
      'Studio',
      'Workflow Canvas',
      'Profile',
      'Help & feedback',
    ]);
    expect(within(screen.getByRole('banner')).getByRole('searchbox', { name: 'Search creators, posts, and recipes' })).toBeInTheDocument();
    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Open alerts' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: 'Primary mobile navigation' }))
        .queryByRole('link', { name: /invite/i })
    ).not.toBeInTheDocument();
  });

  describe('the Create menu', () => {
    afterEach(() => {
      Reflect.deleteProperty(HTMLElement.prototype, 'showPopover');
    });

    it("opens from the top bar's Create and the phone layout's +, as the app's centre + does", () => {
      render(
        <AppShellClient>
          <div>Home content</div>
        </AppShellClient>
      );

      const menu = createMenu();
      const topBarCreate = within(screen.getByRole('banner')).getByRole('button', { name: 'Create' });
      const bottomCreate = within(screen.getByRole('navigation', { name: 'Primary mobile navigation' }))
        .getByRole('button', { name: 'Create' });

      expect(menu).toHaveAttribute('role', 'dialog');
      expect(document.getElementById(menu.getAttribute('aria-labelledby')!)).toHaveTextContent('Create or publish');
      expect(menu).toHaveAttribute('popover', 'auto');
      expect(topBarCreate).toHaveAttribute('popovertarget', menu.id);
      expect(bottomCreate).toHaveAttribute('popovertarget', menu.id);
      // Create and Post, in that order, the post started with a Back to Home.
      expect(within(menu).getAllByRole('link', { hidden: true }).map((link) => [
        link.getAttribute('aria-label'),
        link.getAttribute('href'),
      ])).toEqual([
        ['Create', '/create'],
        ['Post', '/post/new?from=home'],
      ]);
      const post = within(menu).getByRole('link', { name: 'Post', hidden: true });
      expect(document.getElementById(post.getAttribute('aria-describedby')!)).toHaveTextContent('Share finished media');
    });

    it('closes when one of its choices is clicked, before the page hears the click', () => {
      render(
        <AppShellClient>
          <div>Home content</div>
        </AppShellClient>
      );
      const menu = createMenu();
      const hidePopover = standMenuOpen(menu);
      const heardOpen: boolean[] = [];
      const listener = () => heardOpen.push(hidePopover.mock.calls.length === 0);
      document.addEventListener('click', listener, true);

      try {
        fireEvent.click(within(menu).getByRole('link', { name: 'Create', hidden: true }));
      } finally {
        document.removeEventListener('click', listener, true);
      }

      expect(hidePopover).toHaveBeenCalledTimes(1);
      // The document's capture phase, where a page with unsaved work asks, came after the close.
      expect(heardOpen).toEqual([false]);
      expect(navigations).toEqual(['/create']);
    });

    it('closes on the next page', () => {
      const view = render(
        <AppShellClient>
          <div>Home content</div>
        </AppShellClient>
      );
      const hidePopover = standMenuOpen(createMenu());

      mockedPathname = '/showcase';
      view.rerender(
        <AppShellClient>
          <div>Explore content</div>
        </AppShellClient>
      );

      expect(hidePopover).toHaveBeenCalledTimes(1);
    });

    it('offers no link to the composer on the composer itself: Post there only closes the menu', () => {
      mockedPathname = '/post/new';
      render(
        <AppShellClient>
          <div>Composer</div>
        </AppShellClient>
      );
      const menu = createMenu();
      const hidePopover = standMenuOpen(menu);

      expect(within(menu).getAllByRole('link', { hidden: true }).map((link) => link.getAttribute('href'))).toEqual(['/create']);
      const post = within(menu).getByRole('button', { name: 'Post', hidden: true });
      expect(post).toHaveAttribute('aria-current', 'page');
      fireEvent.click(post);

      expect(hidePopover).toHaveBeenCalledTimes(1);
      expect(navigations).toEqual([]);
    });

    it('in a browser without popovers, draws itself, takes the focus, keeps the keys from the page, and closes on Escape', () => {
      render(
        <AppShellClient>
          <div>Home content</div>
        </AppShellClient>
      );
      const menu = createMenu();
      const topBarCreate = within(screen.getByRole('banner')).getByRole('button', { name: 'Create' });
      // A page's own key handler on the window, as the workflow canvas has.
      const heardByPage: string[] = [];
      const pageKeys = (event: KeyboardEvent) => heardByPage.push(event.key);
      window.addEventListener('keydown', pageKeys);

      try {
        topBarCreate.focus();
        fireEvent.click(topBarCreate);
        expect(menu).toHaveAttribute('data-open');
        const create = within(menu).getByRole('link', { name: 'Create', hidden: true });
        expect(create).toHaveFocus();

        // A key on the page is the page's; one in the menu, and Escape, are the menu's.
        fireEvent.keyDown(document.body, { key: 'n' });
        fireEvent.keyDown(create, { key: 'Enter' });
        fireEvent.keyDown(create, { key: 'Escape' });
      } finally {
        window.removeEventListener('keydown', pageKeys);
      }

      expect(menu).not.toHaveAttribute('data-open');
      expect(topBarCreate).toHaveFocus();
      expect(heardByPage).toEqual(['n']);
    });
  });

  it('does not prefetch shell navigation during first paint', () => {
    render(
      <AppShellClient>
        <div>Page content</div>
      </AppShellClient>
    );

    const desktopNavigation = screen.getByRole('complementary', {
      name: 'Primary navigation',
    });
    const mobileNavigation = screen.getByRole('navigation', {
      name: 'Primary mobile navigation',
    });

    const menu = createMenu();

    for (const link of [
      ...within(desktopNavigation).getAllByRole('link'),
      ...within(mobileNavigation).getAllByRole('link'),
      ...within(menu).getAllByRole('link', { hidden: true }),
      screen.getByRole('link', { name: 'Open alerts' }),
    ]) {
      expect(link).toHaveAttribute('data-prefetch', 'false');
    }
  });

  it('leaves a tab opened from another page to Next and scrolls an active tab to the top', () => {
    const homeRender = render(
      <AppShellClient>
        <div>Home content</div>
      </AppShellClient>
    );
    const mobileNavigation = screen.getByRole('navigation', {
      name: 'Primary mobile navigation',
    });

    // No link in the shell opts out of Next's scroll to the top of the new
    // page: not the side or bottom navigation, the drawer, or the bar.
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(within(screen.getByRole('dialog', { name: 'Navigation' })).getAllByRole('link').length)
      .toBeGreaterThan(5);
    expect(document.querySelector('[data-scroll]')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });

    mockedScrollY = 640;
    fireEvent.click(within(mobileNavigation).getByRole('link', { name: 'Explore' }));
    homeRender.unmount();

    mockedPathname = '/showcase';
    const showcaseRender = render(
      <AppShellClient>
        <div>Showcase content</div>
      </AppShellClient>
    );

    mockedScrollY = 420;
    fireEvent.scroll(window);
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Primary mobile navigation' }))
        .getByRole('link', { name: 'Home' })
    );
    showcaseRender.unmount();

    mockedPathname = '/';
    render(
      <AppShellClient>
        <div>Home content</div>
      </AppShellClient>
    );

    // Home is not brought back to 640: the shell keeps no position per tab,
    // and both tab changes were left to Link to navigate.
    expect(scrollToMock).not.toHaveBeenCalled();
    expect(Object.keys(window.sessionStorage)).toEqual([]);
    expect(navigations).toEqual(['/showcase', '/']);

    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Primary mobile navigation' }))
        .getByRole('link', { name: 'Home' })
    );

    // The tab that is already open scrolls to the top instead of navigating.
    expect(scrollToMock).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' });
    expect(navigations).toEqual(['/showcase', '/']);
  });

  it('uses an instant active-tab return when reduced motion is enabled', () => {
    mockedReducedMotion = true;
    mockedScrollY = 320;

    render(
      <AppShellClient>
        <div>Home content</div>
      </AppShellClient>
    );

    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Primary mobile navigation' }))
        .getByRole('link', { name: 'Home' })
    );

    expect(scrollToMock).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' });
  });

  it('ignores a tab position an earlier shell left in session storage', () => {
    // A browser tab open across the deploy still holds what the old shell wrote.
    window.sessionStorage.setItem('magicbooklet:app-tab-scroll:home', '640');
    window.sessionStorage.setItem('magicbooklet:pending-app-tab-restore', 'home');

    render(
      <AppShellClient>
        <div>Home content</div>
      </AppShellClient>
    );

    expect(scrollToMock).not.toHaveBeenCalled();
  });

  describe('a page opened with its top under the sticky bar', () => {
    const BAR_HEIGHT = 65;
    let layout: { mockRestore: () => void };

    // jsdom has no layout: give the bar and the content their boxes on a page
    // scrolled to `mockedScrollY`, the bar stuck at the top.
    beforeEach(() => {
      layout = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const top = this.classList.contains('app-shell-header')
          ? 0
          : this.id === 'main-content' ? BAR_HEIGHT - mockedScrollY : 0;
        const height = this.classList.contains('app-shell-header') ? BAR_HEIGHT : 0;
        return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) };
      });
    });

    afterEach(() => {
      layout.mockRestore();
    });

    function renderAt(path: string) {
      mockedPathname = path;
      window.history.replaceState(null, '', path);
      return render(
        <AppShellClient>
          <div>{path} content</div>
        </AppShellClient>
      );
    }

    function navigate(
      view: ReturnType<typeof render>,
      path: string,
      url = path,
      content: ReactNode = <div>{path} content</div>,
    ) {
      window.history.pushState(null, '', url);
      mockedPathname = path;
      view.rerender(<AppShellClient>{content}</AppShellClient>);
    }

    function traverse(view: ReturnType<typeof render>, path: string) {
      window.history.pushState(null, '', path);
      fireEvent.popState(window);
      mockedPathname = path;
      view.rerender(
        <AppShellClient>
          <div>{path} content</div>
        </AppShellClient>
      );
    }

    it('scrolls it to the top when a navigation leaves it clamped under the bar', () => {
      const view = renderAt('/notifications');

      // The browser clamped a long page's scroll to the short page's most: one bar.
      mockedScrollY = BAR_HEIGHT;
      navigate(view, '/search');

      expect(scrollToMock).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' });
    });

    it('leaves Back and Forward, hash links, the top and pages scrolled past the bar where they are', () => {
      const view = renderAt('/notifications');
      mockedScrollY = 30;

      // Back or Forward: the browser restores the position it kept.
      traverse(view, '/search');
      // A link to a section of the next page lands on that section.
      navigate(view, '/creations', '/creations#recent', <section id="recent">Recent</section>);
      // Next has already scrolled anything further down to its top.
      mockedScrollY = 400;
      navigate(view, '/invite');
      // Already at the top: the page starts below the bar.
      mockedScrollY = 0;
      navigate(view, '/feed');

      expect(scrollToMock).not.toHaveBeenCalled();
    });

    it('checks a page reached forward again after a Back landed on it', () => {
      const view = renderAt('/notifications');
      mockedScrollY = 30;

      traverse(view, '/search');
      navigate(view, '/invite');
      expect(scrollToMock).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' });
      scrollToMock.mockClear();

      // Search again, by a link this time: no longer the traversal's landing.
      mockedScrollY = 30;
      navigate(view, '/search');
      expect(scrollToMock).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' });

      // A Back that changed no page leaves no mark on the next navigation.
      scrollToMock.mockClear();
      fireEvent.popState(window);
      mockedScrollY = 30;
      navigate(view, '/notifications');
      expect(scrollToMock).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' });
    });

    it('scrolls a page reached by a hash that names nothing to its top', () => {
      const view = renderAt('/notifications');

      // The creator page's tab hashes select a tab and name no element, so
      // Next drops its scroll and the page would keep the last one's offset.
      mockedScrollY = 400;
      navigate(view, '/creators/someone', '/creators/someone#creator-creations');

      expect(scrollToMock).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' });
    });

    it('does nothing on the first load, or on a page drawn without the bar', () => {
      // A reload the browser brought back 30px down is the browser's call.
      mockedScrollY = 30;
      const view = renderAt('/notifications');
      expect(scrollToMock).not.toHaveBeenCalled();

      navigate(view, '/login');
      expect(screen.queryByRole('banner')).not.toBeInTheDocument();
      expect(scrollToMock).not.toHaveBeenCalled();
    });
  });

  it('opens an accessible mobile drawer and closes it with Escape', () => {
    render(
      <AppShellClient>
        <div>Page content</div>
      </AppShellClient>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });

  // The owner's decision for the phone-width web (2026-10-28, "Hide it while creating"): the
  // creators hide the bottom navigation, their bar holds the bottom edge, and the top bar's menu
  // reaches every page. The stylesheet's half: app-shell-bottom-nav-while-creating.test.ts.
  describe('while creating', () => {
    const drawerLinks = () => within(screen.getByRole('dialog', { name: 'Navigation' })).getAllByRole('link')
      .map((link) => [link.textContent, link.getAttribute('href'), link.getAttribute('aria-current')]);

    // Which paths hide it is the rule's own test (app-shell-bottom-nav-while-creating.test.ts):
    // here, that the shell draws the rule's answer.
    it('marks the image, video and motion creators as holding the bottom edge, and no other page', () => {
      for (const [pathname, hidden] of [
        ['/create-image', true], ['/create-video', true], ['/create-motion', true], ['/showcase', false],
      ] as const) {
        mockedPathname = pathname;
        const { container, unmount } = render(
          <AppShellClient>
            <div>Page content</div>
          </AppShellClient>
        );
        const root = container.querySelector('.app-shell-root');
        expect(root?.getAttribute('data-bottom-nav') ?? null, pathname).toBe(hidden ? 'hidden' : null);
        unmount();
      }
    });

    it('draws the mark on the server, so a phone never sees the navigation come and go', () => {
      const { container, onRecoverableError, attributeWarnings } = hydrateShell({ server: '/create-video', browser: '/create-video' });
      expect(container.querySelector('.app-shell-root')).toHaveAttribute('data-bottom-nav', 'hidden');
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(attributeWarnings).toEqual([]);
    });

    it("names the navigation's places in the top bar's menu where it hides, the Create menu's two among them", () => {
      mockedPathname = '/create-video';
      render(
        <AppShellClient>
          <div>Creator</div>
        </AppShellClient>
      );
      // Search stays the top bar's own.
      expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Search creators, posts, and recipes' })).toHaveAttribute('href', '/search');
      fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

      expect(drawerLinks()).toEqual([
        ['magicbooklet', '/', null],
        ['Home', '/', null],
        ['Explore', '/showcase', null],
        ['Marketplace', '/marketplace', null],
        // A way in, as the bottom bar's + was: the launchpad, never the page open.
        ['Create', '/create', null],
        ['Post', '/post/new', null],
        ['Studio', '/creations', null],
        ['Workflow Canvas', '/create-workflow', null],
        ['Alerts', '/notifications', null],
        ['Profile', '/profile', null],
        ['Help & feedback', '/contact', null],
      ]);
    });

    it("shows the Alerts count on the top bar's menu button where the navigation hides, and only there", () => {
      publishUnreadAlertsCount(3);
      try {
        for (const [pathname, shown] of [['/create-video', true], ['/showcase', false]] as const) {
          mockedPathname = pathname;
          const { unmount } = render(
            <AppShellClient>
              <div>Page content</div>
            </AppShellClient>
          );
          const menuButton = screen.getByRole('button', { name: 'Open navigation' });
          expect(Boolean(within(menuButton).queryByLabelText('3 unread alerts')), pathname).toBe(shown);
          unmount();
        }
      } finally {
        publishUnreadAlertsCount(0);
      }
    });

    // The side navigation shows from 768px in px (globals.css). The menu button hid at md, 48rem,
    // which moves with the browser's text size: at a small one a creator between 48rem and 768px,
    // with no bottom navigation, had no way to the other pages at all.
    it("hides the menu button and its drawer from 768px in px, where the side navigation shows", () => {
      mockedPathname = '/create-video';
      render(
        <AppShellClient>
          <div>Creator</div>
        </AppShellClient>
      );
      const menuButton = screen.getByRole('button', { name: 'Open navigation' });
      expect(menuButton.className.split(' ')).toContain('min-[768px]:hidden');
      expect(menuButton.className.split(' ')).not.toContain('md:hidden');
      fireEvent.click(menuButton);
      const drawerLayer = screen.getByRole('dialog', { name: 'Navigation' }).parentElement!;
      expect(drawerLayer.className.split(' ')).toContain('min-[768px]:hidden');
    });

    it('leaves the menu as it was where the navigation shows', () => {
      mockedPathname = '/showcase';
      render(
        <AppShellClient>
          <div>Explore</div>
        </AppShellClient>
      );
      fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

      expect(drawerLinks().map(([label]) => label)).toEqual([
        'magicbooklet', 'Home', 'Explore', 'Marketplace', 'Studio', 'Workflow Canvas', 'Profile', 'Help & feedback',
      ]);
    });
  });

  it('keeps sign-in focused by omitting workspace navigation', () => {
    mockedPathname = '/login';

    render(
      <AppShellClient>
        <div>Sign-in content</div>
      </AppShellClient>
    );

    expect(screen.getByRole('main')).toHaveTextContent('Sign-in content');
    expect(screen.queryByRole('navigation', { name: 'Primary mobile navigation' })).not.toBeInTheDocument();
  });

  it('keeps public referral landings focused by omitting workspace navigation', () => {
    mockedPathname = '/r/friend123';

    render(
      <AppShellClient>
        <div>Referral content</div>
      </AppShellClient>
    );

    expect(screen.getByRole('main')).toHaveTextContent('Referral content');
    expect(screen.queryByRole('navigation', { name: 'Primary mobile navigation' })).not.toBeInTheDocument();
  });

  // The post composer asks before its work is lost (useLeaveGuard): one tap on
  // Home in the bottom navigation used to drop a typed post and its files.
  describe('over a page with unsaved work', () => {
    const LEAVE_POST: ConfirmationRequest = {
      title: 'Leave this post?',
      message: 'Your changes haven’t been saved and will be lost.',
      confirmLabel: 'Leave without saving',
      cancelLabel: 'Keep editing',
      tone: 'danger',
    };

    /** Unsaved while its field holds text, as the composer is. */
    function PostDraft() {
      const [text, setText] = useState('');
      useLeaveGuard({ isDirty: text !== '', question: LEAVE_POST, historyKey: 'shellTestLeaveGuard' });
      return <input aria-label="Post text" value={text} onChange={(event) => setText(event.target.value)} />;
    }

    const shellWith = (page: ReactNode) => (
      <>
        <AppShellClient>{page}</AppShellClient>
        <FeedbackViewport />
      </>
    );

    function renderPostDraft() {
      mockedPathname = '/post/new';
      // An entry of the page's own, for its guard to mark.
      window.history.pushState(null, '', '/post/new');
      return render(shellWith(<PostDraft />));
    }

    const writePost = () => fireEvent.change(screen.getByLabelText('Post text'), { target: { value: 'A sunset reel' } });
    const answer = async (label: 'Keep editing' | 'Leave without saving') => {
      const question = await screen.findByRole('alertdialog', { name: 'Leave this post?' });
      fireEvent.click(within(question).getByRole('button', { name: label }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    };

    beforeEach(() => {
      routerMocks.push.mockReset();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('asks before the side and bottom navigation and the top bar leave, and follows a link only on a leave', async () => {
      const back = vi.spyOn(window.history, 'back');
      renderPostDraft();
      writePost();
      const bottomNavigation = () => screen.getByRole('navigation', { name: 'Primary mobile navigation' });

      for (const link of [
        within(screen.getByRole('complementary', { name: 'Primary navigation' })).getByRole('link', { name: 'Explore' }),
        within(bottomNavigation()).getByRole('link', { name: 'Home' }),
        within(createMenu()).getByRole('link', { name: 'Create', hidden: true }),
        screen.getByRole('link', { name: 'Open alerts' }),
      ]) {
        fireEvent.click(link);
        await answer('Keep editing');
      }

      // Held before the links' own handlers ran: none of them navigated.
      expect(navigations).toEqual([]);
      expect(routerMocks.push).not.toHaveBeenCalled();
      expect(back).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Post text')).toHaveValue('A sunset reel');

      fireEvent.click(within(bottomNavigation()).getByRole('link', { name: 'Home' }));
      await answer('Leave without saving');

      // Off the page's guard entry, then the tab chosen.
      await waitFor(() => expect(routerMocks.push).toHaveBeenCalledWith('/'));
      expect(back.mock.invocationCallOrder[0]).toBeLessThan(routerMocks.push.mock.invocationCallOrder[0]);
      expect(navigations).toEqual([]);
    });

    it('asks before the top bar search leaves, and searches on a leave', async () => {
      renderPostDraft();
      const searchField = screen.getByRole('searchbox', { name: 'Search creators, posts, and recipes' });
      const searchForm = searchField.closest('form')!;
      fireEvent.change(searchField, { target: { value: 'neon city' } });

      // Nothing to lose yet: the search goes at once.
      fireEvent.submit(searchForm);
      expect(navigations).toEqual(['/search?q=neon+city']);

      writePost();
      fireEvent.submit(searchForm);
      await answer('Keep editing');
      expect(navigations).toEqual(['/search?q=neon+city']);

      fireEvent.submit(searchForm);
      await answer('Leave without saving');

      // Off the page's guard entry, then the search submitted again.
      await waitFor(() => expect(navigations).toEqual(['/search?q=neon+city', '/search?q=neon+city']));
    });

    // A link in the drawer closes it as it navigates, but the guard holds the
    // click before that handler runs, and the leave comes later by the router.
    it('closes the drawer when a link in it leaves', async () => {
      const view = renderPostDraft();
      writePost();
      fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

      fireEvent.click(within(screen.getByRole('dialog', { name: 'Navigation' })).getByRole('link', { name: 'Explore' }));
      await answer('Leave without saving');
      await waitFor(() => expect(routerMocks.push).toHaveBeenCalledWith('/showcase'));

      // The router draws Explore under the shell.
      mockedPathname = '/showcase';
      view.rerender(shellWith(<div>Explore content</div>));

      expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe('');
    });
  });
});
