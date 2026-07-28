import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentPropsWithoutRef } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AppShellClient from '@/app/components/AppShellClient';

let mockedPathname = '/';

vi.mock('next/navigation', () => ({
  usePathname: () => mockedPathname,
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ prefetch, ...props }: ComponentPropsWithoutRef<'a'> & { prefetch?: boolean }) => (
    <a
      {...props}
      data-prefetch={prefetch === undefined ? undefined : String(prefetch)}
    />
  ),
}));

describe('AppShellClient', () => {
  beforeEach(() => {
    mockedPathname = '/';
    document.body.style.overflow = '';
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
