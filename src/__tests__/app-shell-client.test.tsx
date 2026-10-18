import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AppShellClient from '@/components/AppShellClient';

let mockedPathname = '/';
let mockedScrollY = 0;
let mockedReducedMotion = false;
/** Hrefs the mocked Link would have navigated to: its handler left the click alone. */
const navigations: string[] = [];
const scrollToMock = vi.fn((options: ScrollToOptions | number) => {
  mockedScrollY = typeof options === 'number' ? options : options.top ?? 0;
});

vi.mock('next/navigation', () => ({
  usePathname: () => mockedPathname,
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({
    prefetch,
    scroll,
    onClick,
    ...props
  }: ComponentPropsWithoutRef<'a'> & { prefetch?: boolean; scroll?: boolean }) => (
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
  ),
}));

describe('AppShellClient', () => {
  beforeEach(() => {
    mockedPathname = '/';
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

  it('hydrates the root shell without recovering from a route markup mismatch', async () => {
    mockedPathname = '/_not-found';
    const serverHtml = renderToString(
      <AppShellClient>
        <div>Home content</div>
      </AppShellClient>
    );
    const container = document.createElement('div');
    container.innerHTML = serverHtml;
    document.body.appendChild(container);
    mockedPathname = '/';
    const onRecoverableError = vi.fn();

    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(
        container,
        <AppShellClient>
          <div>Home content</div>
        </AppShellClient>,
        { onRecoverableError }
      );
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(within(container).getByRole('banner')).toHaveTextContent('Home');
    expect(
      within(container)
        .getAllByRole('link', { name: 'Home' })
        .some((link) => link.getAttribute('aria-current') === 'page')
    ).toBe(true);

    await act(async () => root!.unmount());
    container.remove();
  });

  it('hydrates the rewritten dashboard (/home on the server, / in the browser) without mismatch', async () => {
    // Signed-in `/` is middleware-rewritten to `/home` (src/proxy.ts): the
    // server render sees the internal pathname while the hydrated client
    // sees the browser URL. Both must resolve to identical shell markup.
    mockedPathname = '/home';
    const serverHtml = renderToString(
      <AppShellClient>
        <div>Dashboard content</div>
      </AppShellClient>
    );
    const container = document.createElement('div');
    container.innerHTML = serverHtml;
    document.body.appendChild(container);
    mockedPathname = '/';
    const onRecoverableError = vi.fn();

    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(
        container,
        <AppShellClient>
          <div>Dashboard content</div>
        </AppShellClient>,
        { onRecoverableError }
      );
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(within(container).getByRole('banner')).toHaveTextContent('Home');
    expect(
      within(container)
        .getAllByRole('link', { name: 'Home' })
        .some((link) => link.getAttribute('aria-current') === 'page')
    ).toBe(true);

    await act(async () => root!.unmount());
    container.remove();
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
