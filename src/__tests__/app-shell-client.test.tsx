import { fireEvent, render, screen, within } from '@testing-library/react';
import { UNDERSCORE_NOT_FOUND_ROUTE } from 'next/dist/shared/lib/entry-constants';
import { NOT_FOUND_SEGMENT_KEY } from 'next/dist/shared/lib/segment';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AppShellClient from '@/components/AppShellClient';

let mockedPathname = '/';
/** The root layout's selected segment: the route's first segment. */
let mockedSegment: string | null = null;
let mockedScrollY = 0;
let mockedReducedMotion = false;
/** Hrefs the mocked Link would have navigated to: its handler left the click alone. */
const navigations: string[] = [];
/** How many times a shell link has been drawn. */
let linkRenders = 0;
const scrollToMock = vi.fn((options: ScrollToOptions | number) => {
  mockedScrollY = typeof options === 'number' ? options : options.top ?? 0;
});

vi.mock('next/navigation', () => ({
  usePathname: () => mockedPathname,
  useRouter: () => ({ push: vi.fn() }),
  useSelectedLayoutSegment: () => mockedSegment,
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
      mockedSegment = 'pricing';
      mockedPathname = '/pricing';
      view.rerender(
        <AppShellClient>
          <div>Pricing content</div>
        </AppShellClient>
      );

      expect(within(screen.getByRole('banner')).getByText('Pricing')).toBeInTheDocument();
    });
  });

  it('server-renders the current route title instead of a stale home title', () => {
    mockedPathname = '/marketplace';

    const html = renderToString(
      <AppShellClient>
        <div>Marketplace content</div>
      </AppShellClient>
    );

    expect(html).toContain('Reusable post recipes and creator assets');
    expect(html).toContain('Marketplace content');
  });

  it('shows the mounted pathname title and selected navigation state', () => {
    mockedPathname = '/marketplace';

    render(
      <AppShellClient>
        <div>Marketplace content</div>
      </AppShellClient>
    );

    expect(within(screen.getByRole('banner')).getByText('Marketplace')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Marketplace' }).some((link) => link.getAttribute('aria-current') === 'page')).toBe(true);
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

  it('exposes Invite & Earn under Account without adding a mobile bottom tab', () => {
    mockedPathname = '/invite';

    render(
      <AppShellClient>
        <div>Invite content</div>
      </AppShellClient>
    );

    expect(within(screen.getByRole('banner')).getByText('Invite & Earn')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Invite & Earn' }).some((link) => link.getAttribute('aria-current') === 'page')).toBe(true);
    expect(
      within(screen.getByRole('navigation', { name: 'Primary mobile navigation' }))
        .queryByRole('link', { name: /invite/i })
    ).not.toBeInTheDocument();
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

    for (const link of [
      ...within(desktopNavigation).getAllByRole('link'),
      ...within(mobileNavigation).getAllByRole('link'),
      screen.getByRole('link', { name: 'New creation' }),
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
});
