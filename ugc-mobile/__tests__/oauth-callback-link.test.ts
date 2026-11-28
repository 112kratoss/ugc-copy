import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  OAUTH_CALLBACK_COLD_START_ROUTE,
  OAUTH_CALLBACK_PATH,
  OAUTH_CALLBACK_SCHEME,
  isOAuthCallbackLink,
  routeForSystemLink,
} from '../lib/oauth-callback-link';

const root = join(__dirname, '..');

describe('isOAuthCallbackLink', () => {
  it('knows the sign-in redirect with its code, its error or nothing after it', () => {
    expect(isOAuthCallbackLink('magicbooklet://oauth/callback?code=4f2a')).toBe(true);
    expect(isOAuthCallbackLink('magicbooklet://oauth/callback?error=access_denied&error_description=No')).toBe(true);
    expect(isOAuthCallbackLink('magicbooklet://oauth/callback')).toBe(true);
    expect(isOAuthCallbackLink('magicbooklet://oauth/callback/')).toBe(true);
    expect(isOAuthCallbackLink('magicbooklet://oauth/callback#access_token=x')).toBe(true);
  });

  it('knows the triple-slash form, the dev client scheme, upper case and the bare path', () => {
    expect(isOAuthCallbackLink('magicbooklet:///oauth/callback?code=1')).toBe(true);
    expect(isOAuthCallbackLink('exp+magicbooklet-mobile://oauth/callback?code=1')).toBe(true);
    expect(isOAuthCallbackLink('MAGICBOOKLET://OAuth/Callback?code=1')).toBe(true);
    expect(isOAuthCallbackLink('/oauth/callback?code=1')).toBe(true);
    expect(isOAuthCallbackLink('oauth/callback')).toBe(true);
  });

  it('leaves every other link alone', () => {
    expect(isOAuthCallbackLink('magicbooklet://showcase/abc')).toBe(false);
    expect(isOAuthCallbackLink('magicbooklet://oauth/callbacks')).toBe(false);
    expect(isOAuthCallbackLink('magicbooklet://oauth/callback-later')).toBe(false);
    expect(isOAuthCallbackLink('magicbooklet://settings?from=oauth/callback')).toBe(false);
    expect(isOAuthCallbackLink('https://magicbooklet.com/oauth/callback?code=1')).toBe(false);
    expect(isOAuthCallbackLink('otherapp://oauth/callback?code=1')).toBe(false);
    expect(isOAuthCallbackLink('/showcase/abc')).toBe(false);
    expect(isOAuthCallbackLink('')).toBe(false);
  });
});

describe('routeForSystemLink', () => {
  it('keeps the router where it is while the app runs, so the sign-in page stays up', () => {
    expect(routeForSystemLink('magicbooklet://oauth/callback?code=4f2a', false)).toBeNull();
  });

  it('opens Home when the redirect itself started the app', () => {
    expect(routeForSystemLink('magicbooklet://oauth/callback?code=4f2a', true)).toBe(OAUTH_CALLBACK_COLD_START_ROUTE);
    expect(OAUTH_CALLBACK_COLD_START_ROUTE).toBe('/');
  });

  it('passes any other link through unchanged, at launch or while running', () => {
    for (const initial of [true, false]) {
      expect(routeForSystemLink('magicbooklet://showcase/abc', initial)).toBe('magicbooklet://showcase/abc');
      expect(routeForSystemLink('https://magicbooklet.com/r/AB12CD', initial)).toBe('https://magicbooklet.com/r/AB12CD');
    }
  });
});

describe('the sign-in redirect and the router agree', () => {
  it('builds the redirect from the same scheme and path the router recognises', () => {
    const googleAuth = readFileSync(join(root, 'lib/google-auth.ts'), 'utf8');
    expect(googleAuth).toMatch(/scheme:\s*OAUTH_CALLBACK_SCHEME/);
    expect(googleAuth).toMatch(/path:\s*OAUTH_CALLBACK_PATH/);
    expect(isOAuthCallbackLink(`${OAUTH_CALLBACK_SCHEME}://${OAUTH_CALLBACK_PATH}?code=1`)).toBe(true);
  });

  it('hands every system link to the rule through expo-router’s native intent file', () => {
    const nativeIntent = readFileSync(join(root, 'app/+native-intent.tsx'), 'utf8');
    expect(nativeIntent).toMatch(/export function redirectSystemPath/);
    expect(nativeIntent).toMatch(/routeForSystemLink\(path, initial\)/);
  });
});
