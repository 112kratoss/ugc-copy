import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authSession = vi.hoisted(() => ({
  makeRedirectUri: vi.fn(),
}));

const webBrowser = vi.hoisted(() => ({
  maybeCompleteAuthSession: vi.fn(),
  openAuthSessionAsync: vi.fn(),
}));

vi.mock('expo-auth-session', () => authSession);
vi.mock('expo-web-browser', () => webBrowser);

import {
  getGoogleAuthRedirectUri,
  isGoogleAuthCanceled,
  signInWithGoogleOAuth,
} from '../lib/google-auth';

function client() {
  return {
    auth: {
      signInWithOAuth: vi.fn(),
      exchangeCodeForSession: vi.fn(),
    },
  };
}

// One flow for both phones (decision D1): the system auth session is
// ASWebAuthenticationSession on iOS and a Custom Tab on Android, both behind
// expo-web-browser's openAuthSessionAsync.
describe('Google OAuth on iOS and Android', () => {
  beforeEach(() => {
    authSession.makeRedirectUri.mockReset();
    authSession.makeRedirectUri.mockReturnValue('magicbooklet://oauth/callback');
    webBrowser.openAuthSessionAsync.mockReset();
  });

  it('uses the registered app callback and exchanges the PKCE code', async () => {
    const supabase = client();
    supabase.auth.signInWithOAuth.mockResolvedValue({
      data: { url: 'https://project.supabase.co/auth/v1/authorize?provider=google' },
      error: null,
    });
    webBrowser.openAuthSessionAsync.mockResolvedValue({
      type: 'success',
      url: 'magicbooklet://oauth/callback?code=google-code-1',
    });
    supabase.auth.exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });

    await signInWithGoogleOAuth(supabase as never);

    expect(getGoogleAuthRedirectUri()).toBe('magicbooklet://oauth/callback');
    expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: 'magicbooklet://oauth/callback',
        skipBrowserRedirect: true,
      },
    });
    expect(webBrowser.openAuthSessionAsync).toHaveBeenCalledWith(
      'https://project.supabase.co/auth/v1/authorize?provider=google',
      'magicbooklet://oauth/callback',
    );
    expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledWith('google-code-1');
  });

  it('reports browser cancellation without showing an auth failure', async () => {
    const supabase = client();
    supabase.auth.signInWithOAuth.mockResolvedValue({ data: { url: 'https://auth.test' }, error: null });
    webBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'cancel' });

    let captured: unknown;
    try {
      await signInWithGoogleOAuth(supabase as never);
    } catch (error) {
      captured = error;
    }

    expect(isGoogleAuthCanceled(captured)).toBe(true);
    expect(supabase.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('reads a session the system closed as a cancel too', async () => {
    // iOS answers `cancel` when the person declines the "wants to use … to sign
    // in" prompt or closes the sheet; `dismiss` is a session closed for them.
    const supabase = client();
    supabase.auth.signInWithOAuth.mockResolvedValue({ data: { url: 'https://auth.test' }, error: null });
    webBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'dismiss' });

    const captured = await signInWithGoogleOAuth(supabase as never).catch((error: unknown) => error);

    expect(isGoogleAuthCanceled(captured)).toBe(true);
    expect(supabase.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('asks no question of the platform it runs on', () => {
    // The sign-in screen and account deletion offer Google on both phones, so
    // the flow itself must not refuse either of them.
    expect(readFileSync('lib/google-auth.ts', 'utf8')).not.toMatch(/\bPlatform\b|react-native['"]/);
  });

  it('surfaces provider callback errors', async () => {
    const supabase = client();
    supabase.auth.signInWithOAuth.mockResolvedValue({ data: { url: 'https://auth.test' }, error: null });
    webBrowser.openAuthSessionAsync.mockResolvedValue({
      type: 'success',
      url: 'magicbooklet://oauth/callback?error=access_denied&error_description=Google%20access%20was%20denied',
    });

    await expect(signInWithGoogleOAuth(supabase as never)).rejects.toThrow('Google access was denied');
    expect(supabase.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });
});
