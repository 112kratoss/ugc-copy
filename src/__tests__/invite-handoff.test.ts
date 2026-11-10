import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_APP_STORE_URL, DEFAULT_PLAY_STORE_URL, getAppStoreLinks } from '@/lib/app-store-links';
import {
  INVITE_APP_HANDOFF_LIVE,
  INVITE_HANDOFF_STORAGE_KEY,
  androidOpenInChromeUrl,
  clearStoredInviteHandoff,
  dismissInviteHandoff,
  inviteHandoffDevice,
  inviteHandoffDismissed,
  inviteHandoffOffer,
  inviteJoinPath,
  isInAppBrowser,
  readInviteHandoffPreview,
  readStoredInviteHandoff,
  storeInviteHandoff,
} from '@/lib/invite-handoff';

const CODE = '30b5f916c7aa';

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.31.90 (iPhone15,2; iOS 18_0; en_US)',
  iphoneFacebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.0;FBBV/1]',
  ipadDesktopSite: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  androidWebView: 'Mozilla/5.0 (Linux; Android 15; SM-S921B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  androidInstagram: 'Mozilla/5.0 (Linux; Android 15; SM-S921B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 Instagram 350.0.0.0 Android',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
};

describe('which device and browser an invite was opened on', () => {
  it('tells a phone from a laptop, and an iPad that calls itself a Mac', () => {
    expect(inviteHandoffDevice(UA.iphoneSafari)).toBe('ios');
    expect(inviteHandoffDevice(UA.androidChrome)).toBe('android');
    expect(inviteHandoffDevice(UA.macChrome, 0)).toBe('desktop');
    expect(inviteHandoffDevice(UA.windowsEdge, 10)).toBe('desktop');
    expect(inviteHandoffDevice(UA.ipadDesktopSite, 5)).toBe('ios');
    expect(inviteHandoffDevice(UA.ipadDesktopSite, 0)).toBe('desktop');
  });

  it('knows another app’s own browser, where nobody can join', () => {
    for (const inApp of [UA.iphoneInstagram, UA.iphoneFacebook, UA.androidWebView, UA.androidInstagram]) {
      expect(isInAppBrowser(inApp)).toBe(true);
    }
    for (const own of [UA.iphoneSafari, UA.androidChrome, UA.macChrome, UA.windowsEdge, UA.ipadDesktopSite]) {
      expect(isInAppBrowser(own)).toBe(false);
    }
  });
});

describe('what the page offers a visitor who holds an invite', () => {
  const offer = (device: 'android' | 'ios' | 'desktop', inAppBrowser = false, extra: Partial<Parameters<typeof inviteHandoffOffer>[0]> = {}) =>
    inviteHandoffOffer({ device, inAppBrowser, ...extra });

  // The app reads a handed-over invite at its first launch, which runs the code built
  // into the binary: until a store build with it is live, the app loses the invite and
  // the page must not send anyone there to keep it.
  it('puts joining here first on a phone until the app in the stores keeps an invite', () => {
    expect(INVITE_APP_HANDOFF_LIVE).toEqual({ android: false, ios: false });
    expect(offer('android')).toBe('join');
    expect(offer('ios')).toBe('join');
  });

  it('sends a visitor inside another app’s browser to the phone’s own, where they can join', () => {
    expect(offer('android', true)).toBe('open-in-browser');
    expect(offer('ios', true)).toBe('open-in-browser');
  });

  it('puts the app first once it keeps the invite, platform by platform, in-app browsers included', () => {
    const live = { android: true, ios: false };
    expect(offer('android', false, { live })).toBe('app');
    expect(offer('android', true, { live })).toBe('app');
    expect(offer('ios', false, { live })).toBe('join');
    expect(offer('ios', true, { live: { android: true, ios: true } })).toBe('app');
  });

  it('shows the app-first page to a link opened with the preview switch', () => {
    expect(offer('ios', false, { preview: true })).toBe('app');
    expect(offer('android', true, { preview: true })).toBe('app');
    expect(readInviteHandoffPreview(`?s=feed&r=${CODE}&handoff=preview`)).toBe(true);
    expect(readInviteHandoffPreview('handoff=preview')).toBe(true);
    for (const search of ['', null, undefined, '?handoff=1', '?xhandoff=preview', '?handoff=previews']) {
      expect(readInviteHandoffPreview(search)).toBe(false);
    }
  });

  it('gives a laptop the QR code whatever the app does', () => {
    expect(offer('desktop')).toBe('qr');
    expect(offer('desktop', false, { preview: true })).toBe('qr');
  });

  it('sends joining to the sign-up page, back to the page the invite led to', () => {
    expect(inviteJoinPath('/creators/mira')).toBe('/login?mode=signup&next=%2Fcreators%2Fmira');
    expect(inviteJoinPath('https://evil.example')).toBe('/login?mode=signup&next=%2F');
  });

  it('builds the Android link that opens a page in Chrome', () => {
    expect(androidOpenInChromeUrl(`https://magicbooklet.com/creators/mira?r=${CODE}#top`))
      .toBe(`intent://magicbooklet.com/creators/mira?r=${CODE}#Intent;scheme=https;package=com.android.chrome;end`);
    expect(androidOpenInChromeUrl('http://localhost:3000/x')).toBeNull();
  });
});

describe('the invite a tab holds for the offer', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('keeps it for the tab, and forgets it', () => {
    expect(readStoredInviteHandoff()).toBeNull();
    storeInviteHandoff({ code: CODE, kind: 'invite', path: '/create', preview: true });
    expect(readStoredInviteHandoff()).toEqual({ code: CODE, kind: 'invite', path: '/create', preview: true });
    clearStoredInviteHandoff();
    expect(readStoredInviteHandoff()).toBeNull();
  });

  it('reads nothing it would not have written', () => {
    for (const stored of ['', 'null', '{', '[]', '{"code":"nope"}', '"x"']) {
      window.sessionStorage.setItem(INVITE_HANDOFF_STORAGE_KEY, stored);
      expect(readStoredInviteHandoff()).toBeNull();
    }
    window.sessionStorage.setItem(INVITE_HANDOFF_STORAGE_KEY, JSON.stringify({ code: CODE, kind: 'other', path: '//evil.example', preview: 'yes' }));
    expect(readStoredInviteHandoff()).toEqual({ code: CODE, kind: 'shared_link', path: '/', preview: false });
  });

  it('remembers that the visitor closed the offer', () => {
    expect(inviteHandoffDismissed()).toBe(false);
    dismissInviteHandoff();
    expect(inviteHandoffDismissed()).toBe(true);
  });

  it('works with no storage at all', () => {
    expect(readStoredInviteHandoff(null)).toBeNull();
    expect(() => storeInviteHandoff({ code: CODE, kind: 'invite', path: '/', preview: false }, null)).not.toThrow();
    expect(inviteHandoffDismissed(null)).toBe(false);
  });
});

describe('where the app is listed', () => {
  // Production never set the two variables, so no page of the site led to a store.
  it('has both listings without any variable, the ones the app itself carries', () => {
    expect(getAppStoreLinks()).toEqual({ appStore: DEFAULT_APP_STORE_URL, playStore: DEFAULT_PLAY_STORE_URL });
    expect(DEFAULT_APP_STORE_URL).toBe('https://apps.apple.com/app/id6773286115');
    expect(DEFAULT_PLAY_STORE_URL).toBe('https://play.google.com/store/apps/details?id=com.magicbooklet.mobile');
  });

  it('names the same two listings as the app', () => {
    const appEnv = readFileSync(resolve(process.cwd(), 'ugc-mobile/lib/env.ts'), 'utf8');
    expect(appEnv).toContain(`'${DEFAULT_APP_STORE_URL}'`);
    expect(appEnv).toContain(`'${DEFAULT_PLAY_STORE_URL}'`);
  });
});
