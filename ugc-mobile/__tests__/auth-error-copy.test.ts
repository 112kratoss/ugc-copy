import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  GUEST_MERGE_PREPARE_ERROR_CODE,
  GUEST_MERGE_PREPARE_FAILED,
  MIN_PASSWORD_LENGTH,
  OFFLINE,
  PASSWORD_TOO_SHORT,
  SESSION_ENDED_ELSEWHERE,
  SIGN_IN_SUPPORT,
  SIGN_IN_SUPPORT_EMAIL,
  SIGN_IN_SUPPORT_MAIL_URL,
  describePasswordSignInError,
  describeProviderSignInError,
  signInProviderButtons,
  validateCredentials,
} from '../lib/auth-error-copy';
import { isNetworkRequestFailedError, normalizeSupabaseAuthError } from '../lib/supabase-auth-recovery';

const SUPABASE_URL = 'https://example.supabase.co';

/** What the provider throws onwards: never the raw failure (audit 01-3). */
function thrownBySignIn(error: unknown) {
  return normalizeSupabaseAuthError(error, SUPABASE_URL);
}

describe('offline sign-ins (audit 01-3)', () => {
  it('still reads as offline once the provider has rewritten the failure', () => {
    const thrown = thrownBySignIn(new TypeError('Network request failed'));
    expect(thrown.message).not.toContain('Network request failed');
    expect(isNetworkRequestFailedError(thrown)).toBe(true);
    expect(describePasswordSignInError(thrown)).toBe(OFFLINE);
    expect(describeProviderSignInError(thrown, 'Apple')).toBe(OFFLINE);
    expect(describeProviderSignInError(thrown, 'Google')).toBe(OFFLINE);
  });

  it('keeps what the failure was, for the logs', () => {
    const thrown = thrownBySignIn(new TypeError('Network request failed')) as Error & { code?: string; cause?: unknown };
    expect(thrown.code).toBe('network');
    expect(thrown.cause).toBe('Network request failed');
  });

  it('reads a sign-in aborted at its deadline as offline, and a gateway failure as not', () => {
    const aborted = Object.assign(new Error('Aborted'), { name: 'AuthRetryableFetchError', status: 0 });
    expect(describePasswordSignInError(thrownBySignIn(aborted))).toBe(OFFLINE);
    expect(describeProviderSignInError(thrownBySignIn(aborted), 'Google')).toBe(OFFLINE);

    const gateway = Object.assign(new Error('Bad Gateway'), { name: 'AuthRetryableFetchError', status: 502 });
    expect(isNetworkRequestFailedError(gateway)).toBe(false);
    expect(describePasswordSignInError(thrownBySignIn(gateway))).not.toBe(OFFLINE);
  });
});

describe('a guest sign-in that could not prepare its credits (audit 01-3)', () => {
  const failure = Object.assign(new Error('We could not prepare your guest credits for transfer.'), {
    code: GUEST_MERGE_PREPARE_ERROR_CODE,
  });

  it('gets its own notice on every way in', () => {
    expect(describePasswordSignInError(failure)).toBe(GUEST_MERGE_PREPARE_FAILED);
    expect(describeProviderSignInError(failure, 'Apple')).toBe(GUEST_MERGE_PREPARE_FAILED);
    expect(describeProviderSignInError(failure, 'Google')).toBe(GUEST_MERGE_PREPARE_FAILED);
  });

  it('tells the guest the credits are still here', () => {
    expect(GUEST_MERGE_PREPARE_FAILED.tone).toBe('info');
    expect(GUEST_MERGE_PREPARE_FAILED.body).toContain('Your credits are safe on this device');
  });
});

describe('copy names only the buttons on screen (audit 01-8)', () => {
  it('knows which providers each platform draws, Apple first on iOS (decision D1)', () => {
    expect(signInProviderButtons('ios')).toEqual(['Apple', 'Google']);
    expect(signInProviderButtons('android')).toEqual(['Google']);
    expect(signInProviderButtons('web')).toEqual([]);
  });

  it('points a wrong password at the drawn provider only', () => {
    const wrong = new Error('Invalid login credentials');
    expect(describePasswordSignInError(wrong, { providerButtons: ['Google'] }).body)
      .toBe('Check both and try again. If you created the account with Google, use that button instead.');
    expect(describePasswordSignInError(wrong, { providerButtons: ['Apple'] }).body).not.toContain('Google');
    expect(describePasswordSignInError(wrong).body).toBe('Check both and try again.');
  });

  it('names both providers on iOS and Google alone on Android, in the order they are drawn', () => {
    const wrong = new Error('Invalid login credentials');
    expect(describePasswordSignInError(wrong, { providerButtons: signInProviderButtons('ios') }).body)
      .toBe('Check both and try again. If you created the account with Apple or Google, use that button instead.');
    expect(describePasswordSignInError(wrong, { providerButtons: signInProviderButtons('android') }).body)
      .toBe('Check both and try again. If you created the account with Google, use that button instead.');
  });

  it('asks about the password alone where no email is typed', () => {
    const notice = describePasswordSignInError(new Error('Invalid login credentials'), { asksForEmail: false });
    expect(notice.title).toBe('That password does not match this account');
    expect(notice.body).toBe('Check it and try again.');
  });

  it('offers the password after a provider failure only for an account known to have one', () => {
    const failed = new Error('nonce mismatch');
    expect(describeProviderSignInError(failed, 'Apple').body).toBe('Try again.');
    expect(describeProviderSignInError(failed, 'Google', { passwordAvailable: true }).body)
      .toBe('Try again, or sign in with your email and password.');
    expect(describeProviderSignInError(failed, 'Google').title).toBe('Could not finish with Google');
  });
});

describe('the password hint (audit 01-8)', () => {
  it('names the policy a new password must meet, and still lets an older, shorter one in', () => {
    expect(PASSWORD_TOO_SHORT.body).toBe('Passwords are at least 8 characters with a number, a symbol, upper and lower case.');
    expect(MIN_PASSWORD_LENGTH).toBe(6);
    expect(validateCredentials('creator@example.com', 'abc123')).toBeNull();
    expect(validateCredentials('creator@example.com', 'abc12')).toBe(PASSWORD_TOO_SHORT);
  });
});

// Decision D2: Magicbooklet has no mail sender, so nothing on the sign-in
// screen may promise a mail; support is the way back in.
describe('sign-in help without a mail sender (decision D2)', () => {
  it('words the support line as the web does', () => {
    expect(SIGN_IN_SUPPORT).toEqual({ prompt: 'Trouble signing in?', action: 'Email info@magicbooklet.com' });
  });

  it('opens a mail to support whose subject says what it is about', () => {
    const url = new URL(SIGN_IN_SUPPORT_MAIL_URL);
    expect(`${url.protocol}${url.pathname}`).toBe('mailto:info@magicbooklet.com');
    expect(url.searchParams.get('subject')).toBe('Trouble signing in');
  });

  it('uses the address the help screen and the web give for support', () => {
    // Read as text: the web module imports Next, and the help screen is a route.
    const helpScreen = readFileSync('app/help.tsx', 'utf8');
    const webSiteConfig = readFileSync('../src/lib/seo.ts', 'utf8');
    expect(helpScreen.match(/const SUPPORT_EMAIL = ['"]([^'"]+)['"]/)?.[1]).toBe(SIGN_IN_SUPPORT_EMAIL);
    expect(webSiteConfig.match(/supportEmail:\s*['"]([^'"]+)['"]/)?.[1]).toBe(SIGN_IN_SUPPORT_EMAIL);
  });

  it('never asks for a confirmation link that cannot have been sent', () => {
    const notice = describePasswordSignInError(new Error('Email not confirmed'));
    expect(notice).toEqual({
      title: 'This email address is not confirmed',
      body: 'Email info@magicbooklet.com and we will help you sign in.',
    });
    expect(`${notice.title} ${notice.body}`).not.toMatch(/link|we sent/i);
  });
});

describe('the notice for a session the server refused (audit 04-1)', () => {
  it('promises nothing about the account', () => {
    expect(SESSION_ENDED_ELSEWHERE.body).toBe('Your session on this device ended. Sign in again to continue.');
    expect(SESSION_ENDED_ELSEWHERE.tone).toBe('info');
  });
});
