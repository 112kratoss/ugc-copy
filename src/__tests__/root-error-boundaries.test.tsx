// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const APP_ROOT = path.join(process.cwd(), 'src/app');

afterEach(cleanup);

/**
 * A failure on a route with no error file of its own (Home, Pricing, the creators, the profile…)
 * showed Next's bare "Application error" page, with no navigation and no retry; and a broken post
 * page drew the showcase folder's "Could not load Explore". The root error file draws inside the
 * app shell with a Retry and a way home, and the post page has wording of its own.
 */
describe('root and post error boundaries', () => {
  it('has a root error.tsx: a client component with Retry (Next 16 `retry`) and a link home', async () => {
    const file = path.join(APP_ROOT, 'error.tsx');
    expect(existsSync(file), 'src/app/error.tsx').toBe(true);
    expect(readFileSync(file, 'utf8')).toMatch(/^'use client';/);

    const { default: RootError } = await import('@/app/error');
    const retry = vi.fn();
    render(<RootError error={new Error('boom')} retry={retry} />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Something went wrong');
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: /home/i }).getAttribute('href')).toBe('/');
  });

  it('has a post page error.tsx that speaks of the post, not of Explore', async () => {
    const file = path.join(APP_ROOT, 'showcase/[id]/error.tsx');
    expect(existsSync(file), 'src/app/showcase/[id]/error.tsx').toBe(true);

    const { default: PostError } = await import('@/app/showcase/[id]/error');
    const retry = vi.fn();
    render(<PostError error={new Error('boom')} retry={retry} />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Could not load this post');
    expect(document.body.textContent).not.toMatch(/Explore is temporarily unavailable/);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: /explore/i }).getAttribute('href')).toBe('/showcase');
  });

  it('keeps the root error file on globals.css alone', () => {
    const globalsCss = readFileSync(path.join(APP_ROOT, 'globals.css'), 'utf8');
    expect(globalsCss).toContain('@source "./error.tsx";');
    expect(readFileSync(path.join(APP_ROOT, 'error.tsx'), 'utf8')).not.toContain('non-public-utilities.css');
  });
});
