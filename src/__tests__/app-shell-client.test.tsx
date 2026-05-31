import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AppShellClient from '@/app/components/AppShellClient';

let mockedPathname = '/';

vi.mock('next/navigation', () => ({
  usePathname: () => mockedPathname,
}));

describe('AppShellClient', () => {
  beforeEach(() => {
    mockedPathname = '/';
  });

  it('uses the home shell title when the prerendered pathname is empty', () => {
    mockedPathname = '';

    render(
      <AppShellClient>
        <div>Page content</div>
      </AppShellClient>
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText('Page content')).toBeInTheDocument();
  });

  it('server-renders the stable home title before hydration', () => {
    mockedPathname = '/marketplace';

    const html = renderToString(
      <AppShellClient>
        <div>Marketplace content</div>
      </AppShellClient>
    );

    expect(html).toContain('>Home</h1>');
    expect(html).not.toContain('>Marketplace</h1>');
  });

  it('updates to the mounted pathname title after hydration', () => {
    mockedPathname = '/marketplace';

    render(
      <AppShellClient>
        <div>Marketplace content</div>
      </AppShellClient>
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Marketplace' })).toBeInTheDocument();
  });
});
