import { fireEvent, render, screen, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AppShellClient from '@/app/components/AppShellClient';

let mockedPathname = '/';

vi.mock('next/navigation', () => ({
  usePathname: () => mockedPathname,
  useRouter: () => ({ push: vi.fn() }),
}));

describe('AppShellClient', () => {
  beforeEach(() => {
    mockedPathname = '/';
    document.body.style.overflow = '';
  });

  it('uses the home shell title when the pathname is empty', () => {
    mockedPathname = '';

    render(
      <AppShellClient>
        <div>Page content</div>
      </AppShellClient>
    );

    expect(within(screen.getByRole('banner')).getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Page content')).toBeInTheDocument();
  });

  it('server-renders the current route title instead of a stale home title', () => {
    mockedPathname = '/marketplace';

    const html = renderToString(
      <AppShellClient>
        <div>Marketplace content</div>
      </AppShellClient>
    );

    expect(html).toContain('Unlock prompts, resources, and creator assets');
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
