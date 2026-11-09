import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The shared welcome reader (welcome-credits-requests.ts) takes the token from the browser's
// session: a signed-in one here, so its request reaches the stubbed fetch below.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'token', user: { id: 'session-user' } } } }),
    },
  },
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    session: { access_token: 'token-1', user: { id: 'user-1' } },
    user: { id: 'user-1', email: 'kiran@example.com', user_metadata: { full_name: 'Kiran Das' } },
  }),
}));

import CreatorNameStep from '@/app/onboarding/CreatorNameStep';
import { startCreatorNameStep } from '@/lib/creator-name-step';
import { TYPED_BEFORE_HYDRATION_CAPTURE } from '@/lib/typed-before-hydration';

const KIRAN = { email: 'kiran@example.com', user_metadata: { full_name: 'Kiran Das' } };
const PLACEHOLDER_PROFILE = { id: 'user-1', username: 'creator-a1b2c3d4', displayName: null };
const TAKEN = { error: 'That username is already taken.', fieldErrors: { username: 'That username is already taken.' } };

type Answer = { status: number; body: unknown };

/**
 * The server as the step meets it: the live check (`/api/profile/validate`),
 * the claim (`GET` then `PATCH /api/profile`) and the welcome credits.
 */
function installServer({
  check = () => ({ status: 200, body: { ok: true } }),
  save = (body) => ({ status: 200, body: { ...PLACEHOLDER_PROFILE, ...body } }),
}: {
  check?: (handle: string) => Answer;
  save?: (body: { username: string; displayName: string }) => Answer;
} = {}) {
  const calls: Array<{ url: string; method: string; body: Record<string, string> | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, string> : null;
    calls.push({ url, method, body });
    const json = ({ status, body: answer }: Answer) => new Response(JSON.stringify(answer), { status });
    if (url === '/api/credits/welcome') return json({ status: 200, body: { status: 'not_eligible', amount: 25 } });
    if (url === '/api/profile/validate') return json(check(body?.username ?? ''));
    if (url === '/api/profile' && method === 'PATCH') return json(save(body as { username: string; displayName: string }));
    if (url === '/api/profile') return json({ status: 200, body: PLACEHOLDER_PROFILE });
    return json({ status: 500, body: { error: 'unexpected' } });
  }));
  return calls;
}

function renderStep(nextPath = '/create') {
  return render(
    <StrictMode>
      <CreatorNameStep
        nextPath={nextPath}
        userId="user-1"
        savedUsername="creator-a1b2c3d4"
        start={startCreatorNameStep({ username: 'creator-a1b2c3d4', displayName: null }, KIRAN)}
      />
    </StrictMode>
  );
}

const handleField = () => screen.getByLabelText('Unique handle') as HTMLInputElement;
const nameField = () => screen.getByLabelText('Display name') as HTMLInputElement;

describe('the creator-name step (/onboarding)', () => {
  const replace = vi.fn();

  beforeEach(() => {
    replace.mockReset();
    vi.stubGlobal('location', { ...window.location, protocol: 'https:', replace });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    document.cookie = 'mb_name_step_shown=; Max-Age=0; Path=/';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks for the creator name in the app’s words, with a handle suggested and checked', async () => {
    installServer();
    renderStep();

    expect(screen.getByText('Creator identity')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Claim your creator name' })).toBeInTheDocument();
    expect(screen.getByText('This is the name people will see on your posts, profile, and recipes.')).toBeInTheDocument();
    expect(nameField().value).toBe('Kiran Das');
    expect(handleField().value).toBe('kiran-das');
    // No "@" drawn in front of the handle (owner, 2026-11-08).
    expect(screen.queryByText('@')).not.toBeInTheDocument();
    expect(screen.getByText('Checking availability…')).toBeInTheDocument();
    expect(await screen.findByText('This creator name is available.')).toBeInTheDocument();
    expect(await screen.findByText('Your 25 free credits are added once you choose a name.')).toBeInTheDocument();
    // "Save creator name" is the only way on: no skip, no "later".
    expect(screen.getByRole('button', { name: 'Save creator name' })).toBeEnabled();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('marks itself shown for this account and browser session as it opens', () => {
    installServer();
    renderStep();

    expect(document.cookie).toContain('mb_name_step_shown=user-1');
  });

  it('swaps a suggestion the check finds taken for <handle>-NNN and checks that one', async () => {
    const calls = installServer({ check: (handle) => (handle === 'kiran-das' ? { status: 409, body: TAKEN } : { status: 200, body: { ok: true } }) });
    renderStep();

    await waitFor(() => expect(handleField().value).toBe('kiran-das-550'));
    expect(await screen.findByText('This creator name is available.')).toBeInTheDocument();
    expect(screen.getByText('kiran-das is taken. Suggested handle: kiran-das-550.')).toBeInTheDocument();
    expect(calls.filter((call) => call.url === '/api/profile/validate').map((call) => call.body?.username))
      .toEqual(['kiran-das', 'kiran-das-550']);
  });

  it('follows the display name while the handle is still the suggestion', async () => {
    installServer();
    renderStep();

    fireEvent.change(nameField(), { target: { value: 'Kiran Das Kumar' } });
    expect(handleField().value).toBe('kiran-das-kumar');
  });

  it('changes nothing in the handle once its field has the cursor, and swaps once it is left', async () => {
    installServer({ check: (handle) => (handle === 'kiran-das' ? { status: 409, body: TAKEN } : { status: 200, body: { ok: true } }) });
    renderStep();

    fireEvent.focus(handleField());
    expect(await screen.findByText('That username is already taken.')).toBeInTheDocument();
    expect(handleField().value).toBe('kiran-das');
    expect(screen.getByRole('button', { name: 'Save creator name' })).toBeDisabled();
    fireEvent.change(nameField(), { target: { value: 'Kiran Das Kumar' } });
    expect(handleField().value).toBe('kiran-das');

    fireEvent.blur(handleField());
    expect(handleField().value).toBe('kiran-das-550');
  });

  it('keeps a handle typed in its field as the creator’s own', async () => {
    installServer();
    renderStep();

    fireEvent.change(handleField(), { target: { value: '@Kiran_Studio' } });
    expect(handleField().value).toBe('kiranstudio');
    fireEvent.change(nameField(), { target: { value: 'Someone Else' } });
    expect(handleField().value).toBe('kiranstudio');
  });

  it('refuses a reserved handle at once, with no round trip', async () => {
    const calls = installServer();
    renderStep();

    fireEvent.change(handleField(), { target: { value: 'admin' } });
    expect(screen.getByText('That handle is reserved.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save creator name' })).toBeDisabled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(calls.some((call) => call.url === '/api/profile/validate' && call.body?.username === 'admin')).toBe(false);
  });

  it('moves Enter in the display name on to the handle', () => {
    installServer();
    renderStep();

    nameField().focus();
    fireEvent.keyDown(nameField(), { key: 'Enter' });
    expect(handleField()).toHaveFocus();
  });

  it('saves the name and handle, then opens next with welcome=1, hand-over nonce kept', async () => {
    const calls = installServer();
    renderStep('/create-video?handover=nonce-1234');

    await screen.findByText('This creator name is available.');
    fireEvent.click(screen.getByRole('button', { name: 'Save creator name' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/create-video?handover=nonce-1234&welcome=1'));
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ username: 'kiran-das', displayName: 'Kiran Das' });
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(nameField()).toBeDisabled();
  });

  it('says a handle was just claimed when the save refuses one the check had seen free', async () => {
    installServer({ save: () => ({ status: 409, body: TAKEN }) });
    renderStep();

    await screen.findByText('This creator name is available.');
    fireEvent.click(screen.getByRole('button', { name: 'Save creator name' }));

    expect(await screen.findByText('That handle was just claimed. Try another one.')).toBeInTheDocument();
    // A refusal of the handle is answered by another handle, not a way out.
    expect(screen.queryByRole('button', { name: 'Try again later' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save creator name' })).toBeDisabled();
    expect(replace).not.toHaveBeenCalled();

    fireEvent.change(handleField(), { target: { value: 'kiran-das-studio' } });
    expect(screen.queryByText('That handle was just claimed. Try another one.')).not.toBeInTheDocument();
  });

  it('offers "Try again later" only after a save fails for another reason, and leaves without welcome or a deferral', async () => {
    const calls = installServer({ save: () => ({ status: 500, body: { error: 'Failed to update profile.' } }) });
    renderStep('/create');

    await screen.findByText('This creator name is available.');
    expect(screen.queryByRole('button', { name: 'Try again later' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save creator name' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to update profile.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again later' }));

    expect(replace).toHaveBeenCalledWith('/create');
    // Nothing records "later" (no metadata write, nothing but the step's own
    // reads and the failed save): Home opens the step again next session.
    expect(new Set(calls.map((call) => call.url))).toEqual(new Set(['/api/credits/welcome', '/api/profile/validate', '/api/profile']));
  });

  it('asks for a display name before saving', async () => {
    installServer();
    renderStep();

    fireEvent.change(nameField(), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save creator name' })).toBeDisabled();
    fireEvent.submit(nameField().closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Add the name you want people to see.');
  });
});

// The server draws both fields filled, so a name or handle can be typed before
// the page's script runs; no React hears it, and the next render would write
// the suggestion back (src/lib/use-typed-before-hydration.ts).
describe('the creator-name step typed in before its script ran', () => {
  const recoverableErrors: unknown[] = [];

  beforeAll(() => {
    // The root layout's capture, as the server's HTML runs it ahead of every field.
    new Function(TYPED_BEFORE_HYDRATION_CAPTURE)();
  });

  beforeEach(() => {
    installServer();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    expect(recoverableErrors.splice(0)).toEqual([]);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function step() {
    return (
      <CreatorNameStep
        nextPath="/create"
        userId="user-1"
        savedUsername="creator-a1b2c3d4"
        start={startCreatorNameStep({ username: 'creator-a1b2c3d4', displayName: null }, KIRAN)}
      />
    );
  }

  function hydrateAfter(fill: (name: HTMLInputElement, handle: HTMLInputElement) => void) {
    const container = document.createElement('div');
    container.innerHTML = renderToString(step());
    document.body.appendChild(container);
    const name = container.querySelector<HTMLInputElement>('#creator-name-display-name')!;
    const handle = container.querySelector<HTMLInputElement>('#creator-name-handle')!;
    fill(name, handle);
    render(step(), { container, hydrate: true, onRecoverableError: (error) => recoverableErrors.push(error) });
    return { name, handle };
  }

  function typeIn(field: HTMLInputElement, value: string) {
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('keeps a name typed early, and the suggested handle follows it', async () => {
    const { name, handle } = hydrateAfter((nameField) => typeIn(nameField, 'Early Name'));
    await act(async () => {});
    expect(name.value).toBe('Early Name');
    expect(handle.value).toBe('early-name');
  });

  it('keeps a handle typed early as the creator’s own', async () => {
    const { name, handle } = hydrateAfter((nameField, handleField) => {
      typeIn(handleField, 'Early-Handle');
      typeIn(nameField, 'Someone Else');
    });
    await act(async () => {});
    expect(handle.value).toBe('early-handle');
    expect(name.value).toBe('Someone Else');
  });
});
