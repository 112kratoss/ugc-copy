import type { Session } from '@supabase/supabase-js';

export const E2E_AUTH_COOKIE_NAME = 'e2e-auth';
export const E2E_AUTH_COOKIE_VALUE = 'workflow-user';
export const E2E_AUTH_CREDITS = 25;

export function createE2ESession(): Session {
  return {
    access_token: 'e2e-access-token',
    refresh_token: 'e2e-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 4_102_444_800,
    user: {
      id: E2E_AUTH_COOKIE_VALUE,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'workflow-user@example.com',
      phone: '',
      created_at: '2026-01-01T00:00:00.000Z',
      confirmed_at: '2026-01-01T00:00:00.000Z',
      email_confirmed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      app_metadata: {
        provider: 'email',
        providers: ['email'],
      },
      user_metadata: {
        name: 'Workflow User',
      },
      identities: [],
      is_anonymous: false,
    },
  } as Session;
}

export function isE2EAuthBypassEnabled() {
  return process.env.E2E_AUTH_BYPASS === '1' || process.env.NEXT_PUBLIC_E2E_AUTH_BYPASS === '1';
}

export function hasE2EAuthCookie(cookieValue: string | null | undefined) {
  return cookieValue === E2E_AUTH_COOKIE_VALUE;
}

export function getClientE2EAuthState() {
  if (typeof document === 'undefined' || !isE2EAuthBypassEnabled()) {
    return null;
  }

  const cookieValue = document.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith(`${E2E_AUTH_COOKIE_NAME}=`))
    ?.split('=')
    .slice(1)
    .join('=');

  if (!hasE2EAuthCookie(cookieValue)) {
    return null;
  }

  return {
    session: createE2ESession(),
    credits: E2E_AUTH_CREDITS,
  };
}
