import { act, fireEvent, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminLoginForm } from '@/app/admin/login/AdminLoginForm';

const mocks = vi.hoisted(() => ({
  router: { replace: vi.fn(), refresh: vi.fn() },
  searchParams: new URLSearchParams('next=/admin/users'),
  fetch: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
  useSearchParams: () => mocks.searchParams,
}));

// The server's HTML draws the form before the page's script runs, and what goes into it then
// reaches no React: React hydrated the fields without reading them back, and the sign-in sent an
// empty username and password (2026-11-05; the record's probe in
// archive/forms-typed-before-hydration-2026-11-05 shows it on the page, which the E2E env cannot
// draw without admin access configured).
describe('an admin sign-in form filled before the page’s script ran', () => {
  const USERNAME = 'probe-operator';
  const PASSWORD = 'typed-before-the-script-5150';
  const recoverableErrors: unknown[] = [];

  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Invalid username or password.' }), { status: 401 }));
    vi.stubGlobal('fetch', mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // The form hydrated: React never drew it again on the client, which would drop the text.
    expect(recoverableErrors.splice(0)).toEqual([]);
  });

  /** Typing into the server's HTML: an input event no React hears. */
  function typeInto(field: HTMLInputElement, text: string) {
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** The page's server HTML (in page.tsx's Suspense), filled by `fill`, then hydrated. */
  function hydrateAfter(fill: (username: HTMLInputElement, password: HTMLInputElement) => void) {
    const page = <Suspense fallback={null}><AdminLoginForm /></Suspense>;
    const container = document.createElement('div');
    container.innerHTML = renderToString(page);
    document.body.appendChild(container);
    fill(container.querySelector('#admin-username')!, container.querySelector('#admin-password')!);
    render(page, { container, hydrate: true, onRecoverableError: (error) => recoverableErrors.push(error) });
    return {
      username: container.querySelector<HTMLInputElement>('#admin-username')!,
      password: container.querySelector<HTMLInputElement>('#admin-password')!,
      submit: () => act(async () => {
        fireEvent.submit(container.querySelector('form')!);
      }),
    };
  }

  const sentBody = () => JSON.parse(mocks.fetch.mock.calls[0][1].body as string);

  it('signs in with what was typed, and a refused sign-in still clears only the password', async () => {
    const form = hydrateAfter((username, password) => {
      typeInto(username, USERNAME);
      typeInto(password, PASSWORD);
    });

    await form.submit();

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][0]).toBe('/api/admin/session');
    expect(sentBody()).toEqual({ username: USERNAME, password: PASSWORD });
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid username or password.');
    expect(form.username.value).toBe(USERNAME);
    expect(form.password.value).toBe('');
  });

  it('signs in with a username put in with no input event before the script, and a password typed after it', async () => {
    const form = hydrateAfter((username) => {
      username.value = USERNAME;
    });
    fireEvent.change(form.password, { target: { value: PASSWORD } });

    await form.submit();

    expect(sentBody()).toEqual({ username: USERNAME, password: PASSWORD });
    expect(form.username.value).toBe(USERNAME);
  });
});
