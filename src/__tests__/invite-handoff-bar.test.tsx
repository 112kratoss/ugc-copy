import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

// Leaving for the store is a navigation, which the test page cannot make: watched instead.
const store = vi.hoisted(() => ({ open: vi.fn<(url: string) => void>() }));
// The switch is on for both platforms (INVITE_APP_HANDOFF_LIVE). `switchedOff` draws the
// page as it is with the switch off, which is the rollback, so that page stays tested.
const switchboard = vi.hoisted(() => ({ live: null as null | Record<'android' | 'ios', boolean> }));
vi.mock('@/lib/invite-handoff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/invite-handoff')>();
  return {
    ...actual,
    openStoreListing: store.open,
    inviteHandoffOffer: (args: Parameters<typeof actual.inviteHandoffOffer>[0]) =>
      actual.inviteHandoffOffer(switchboard.live ? { ...args, live: switchboard.live } : args),
    inviteHandoffPreviewOnly: (args: Parameters<typeof actual.inviteHandoffPreviewOnly>[0]) =>
      actual.inviteHandoffPreviewOnly(switchboard.live ? { ...args, live: switchboard.live } : args),
  };
});

function switchedOff() {
  beforeEach(() => {
    switchboard.live = { android: false, ios: false };
  });
  afterEach(() => {
    switchboard.live = null;
  });
}

import { INVITE_HANDOFF_DISCLOSURE, INVITE_HANDOFF_PREVIEW_NOTE, InviteHandoffBar, InviteHandoffLandingOffer } from '@/components/InviteHandoffBar';
import { inviteHandoffDismissed, type StoredInviteHandoff } from '@/lib/invite-handoff';

import { readInviteHandoffLink, readInviteInstallReferrer } from '../../ugc-mobile/lib/invite-share-link/invite-install-handoff';

const CODE = '30b5f916c7aa';
const SHARED: StoredInviteHandoff = { code: CODE, kind: 'shared_link', path: '/creators/mira', preview: false };

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.31.90',
  androidChrome: 'Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  androidInstagram: 'Mozilla/5.0 (Linux; Android 15; SM-S921B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 Instagram 350.0.0.0 Android',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

const writeText = vi.fn<(text: string) => Promise<void>>();

function onDevice(userAgent: string) {
  vi.stubGlobal('navigator', { userAgent, maxTouchPoints: /iPhone|Android/.test(userAgent) ? 5 : 0, clipboard: { writeText } });
}

const origin = () => window.location.origin;

describe('the offer to keep an invite, at the top of the page a shared link opened, with the switch off', () => {
  switchedOff();
  beforeEach(() => {
    window.sessionStorage.clear();
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    store.open.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws nothing without an invite', () => {
    onDevice(UA.iphoneSafari);
    const { container } = render(<InviteHandoffBar handoff={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  // Until a store build that reads a handed-over invite is live, the app loses it:
  // the page keeps it only by an account made here.
  it('tells an iPhone to join here first, says who may earn, and names the App Store second', () => {
    onDevice(UA.iphoneSafari);
    render(<InviteHandoffBar handoff={SHARED} />);

    expect(screen.getByText('Join here to keep your invite')).toBeInTheDocument();
    expect(screen.getByText(INVITE_HANDOFF_DISCLOSURE)).toBeInTheDocument();
    expect(screen.queryByText(INVITE_HANDOFF_PREVIEW_NOTE)).toBeNull();
    expect(screen.getByRole('link', { name: 'Join free' })).toHaveAttribute('href', '/login?mode=signup&next=%2Fcreators%2Fmira');
    expect(screen.getByRole('link', { name: 'the App Store' })).toHaveAttribute('href', 'https://apps.apple.com/app/id6773286115');
    expect(screen.getByText(/An account made in the app can’t keep this invite yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Get the app' })).toBeNull();
  });

  it('names Google Play on an Android phone', () => {
    onDevice(UA.androidChrome);
    render(<InviteHandoffBar handoff={SHARED} />);
    expect(screen.getByRole('link', { name: 'Join free' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Google Play' })).toHaveAttribute('href', 'https://play.google.com/store/apps/details?id=com.magicbooklet.mobile');
  });

  // Google refuses a sign-in there, and that browser's cookie is not the phone's.
  it('sends an iPhone inside Instagram to Safari, with no button that cannot work', () => {
    onDevice(UA.iphoneInstagram);
    render(<InviteHandoffBar handoff={SHARED} />);
    expect(screen.getByText('Open this page in Safari to keep your invite')).toBeInTheDocument();
    // Apple's sign-in works there, so "nobody can join" was not true (review of 2026-11-10).
    expect(screen.getByText(/Google sign-in doesn\u2019t work inside this app/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Join free' })).toBeNull();
  });

  it('gives an Android phone inside Instagram a link that opens the page, invite and all, in Chrome', () => {
    onDevice(UA.androidInstagram);
    render(<InviteHandoffBar handoff={SHARED} />);
    expect(screen.getByText('Open this page in Chrome to keep your invite')).toBeInTheDocument();
    // The link itself is `androidOpenInChromeUrl` (invite-handoff.test.ts), made only for
    // an https page; this page is whatever the test runner serves.
    const link = screen.queryByRole('link', { name: 'Open in Chrome' });
    if (origin().startsWith('https://')) {
      expect(link).toHaveAttribute('href', `intent://${origin().slice('https://'.length)}/creators/mira?r=${CODE}#Intent;scheme=https;package=com.android.chrome;end`);
    } else {
      expect(link).toBeNull();
      expect(screen.getByText(/choose \u201cOpen in Chrome\u201d/)).toBeInTheDocument();
    }
  });

  it('gives a laptop a QR code of the page with the invite on it, and joining here', async () => {
    onDevice(UA.macChrome);
    render(<InviteHandoffBar handoff={SHARED} />);
    expect(screen.getByText('On your phone? Take your invite with you')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'or join here' })).toHaveAttribute('href', '/login?mode=signup&next=%2Fcreators%2Fmira');

    fireEvent.click(screen.getByRole('button', { name: 'Get the app' }));
    expect(await screen.findByRole('dialog', { name: 'Scan to open this on your phone' })).toBeInTheDocument();
    const code = await screen.findByRole('img', { name: 'QR code for this page, with your invite' });
    expect(code.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(500);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('stays closed for the tab once closed', () => {
    onDevice(UA.iphoneSafari);
    const { unmount } = render(<InviteHandoffBar handoff={SHARED} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('Join here to keep your invite')).toBeNull();
    expect(inviteHandoffDismissed()).toBe(true);

    unmount();
    const again = render(<InviteHandoffBar handoff={SHARED} />);
    expect(again.container).toBeEmptyDOMElement();
  });
});

// The page as it is now that the app in both stores keeps a handed-over invite
// (0.1.9, switched on 2026-11-14).
describe('the offer now that the app keeps the invite', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    store.open.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('puts Get the app first on an iPhone, with joining here second and no preview note', async () => {
    onDevice(UA.iphoneSafari);
    render(<InviteHandoffBar handoff={SHARED} />);
    expect(screen.getByText('Get the app and keep your invite')).toBeInTheDocument();
    expect(screen.getByText(INVITE_HANDOFF_DISCLOSURE)).toBeInTheDocument();
    expect(screen.queryByText(INVITE_HANDOFF_PREVIEW_NOTE)).toBeNull();
    expect(screen.getByRole('link', { name: 'or join here' })).toHaveAttribute('href', '/login?mode=signup&next=%2Fcreators%2Fmira');
    expect(screen.queryByText(/can’t keep this invite yet/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Get the app' }));
    await waitFor(() => expect(store.open).toHaveBeenCalledWith('https://apps.apple.com/app/id6773286115'));
    expect(writeText).toHaveBeenCalledWith(`${origin()}/creators/mira?r=${CODE}`);
  });

  it('sends an Android phone to Play with the invite as the install referrer', () => {
    onDevice(UA.androidChrome);
    render(<InviteHandoffBar handoff={SHARED} />);
    expect(screen.getByText('Get the app and keep your invite')).toBeInTheDocument();
    expect(screen.queryByText(INVITE_HANDOFF_PREVIEW_NOTE)).toBeNull();
    const href = screen.getByRole('link', { name: 'Get the app' }).getAttribute('href')!;
    const carried = decodeURIComponent(href.slice(href.indexOf('referrer=') + 'referrer='.length));
    expect(readInviteInstallReferrer(carried)).toEqual({ code: CODE, kind: 'shared_link', path: '/creators/mira' });
  });

  it('offers Get the app inside another app’s browser too, with the way to join on the web', () => {
    onDevice(UA.androidInstagram);
    render(<InviteHandoffBar handoff={SHARED} />);
    expect(screen.getByRole('link', { name: 'Get the app' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'or join here' })).toBeNull();
    expect(screen.getByText(/Google sign-in doesn’t work inside this app\. To join on the web instead/)).toBeInTheDocument();
  });

  it('copies the invite’s link inside Instagram on an iPhone, and says where to join if it cannot', async () => {
    onDevice(UA.iphoneInstagram);
    const first = render(<InviteHandoffBar handoff={SHARED} />);
    expect(screen.getByText('Get the app and keep your invite')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'or join here' })).toBeNull();
    expect(screen.getByText(/Google sign-in doesn’t work inside this app\. To join on the web instead/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Get the app' }));
    await waitFor(() => expect(store.open).toHaveBeenCalledWith('https://apps.apple.com/app/id6773286115'));
    expect(writeText).toHaveBeenCalledWith(`${origin()}/creators/mira?r=${CODE}`);
    first.unmount();

    store.open.mockClear();
    writeText.mockRejectedValue(new Error('NotAllowedError'));
    render(<InviteHandoffBar handoff={SHARED} />);
    fireEvent.click(screen.getByRole('button', { name: 'Get the app' }));
    expect(await screen.findByText('Your invite link could not be copied here. Join on this page to keep it, after opening it in Safari.')).toBeInTheDocument();
    expect(store.open).not.toHaveBeenCalled();
  });

  it('draws no preview note for a link opened with the preview switch', () => {
    onDevice(UA.androidChrome);
    render(<InviteHandoffBar handoff={{ ...SHARED, preview: true }} />);
    expect(screen.getByText('Get the app and keep your invite')).toBeInTheDocument();
    expect(screen.queryByText(INVITE_HANDOFF_PREVIEW_NOTE)).toBeNull();
  });

  it('makes the same offer on the invite landing, with no Close and no second sign-up button', () => {
    onDevice(UA.androidChrome);
    render(<InviteHandoffLandingOffer handoff={{ code: CODE, kind: 'invite', path: '/create', preview: false }} />);
    expect(screen.getByText('Prefer the mobile app? Your invite comes with you')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Get the app' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Join free' })).toBeNull();
  });
});

// The app-first page shown with the preview switch on a platform that is not live yet:
// marked as a preview, since the app there cannot keep the invite.
describe('the preview of the app-first page while the switch is off', () => {
  const PREVIEW: StoredInviteHandoff = { ...SHARED, preview: true };
  switchedOff();

  beforeEach(() => {
    window.sessionStorage.clear();
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    store.open.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends an Android phone to Play with the invite as the install referrer', () => {
    onDevice(UA.androidChrome);
    render(<InviteHandoffBar handoff={PREVIEW} />);
    expect(screen.getByText('Get the app and keep your invite')).toBeInTheDocument();
    // What it shows is not true of the app yet, and it says so.
    expect(screen.getByText(INVITE_HANDOFF_PREVIEW_NOTE)).toBeInTheDocument();
    const href = screen.getByRole('link', { name: 'Get the app' }).getAttribute('href')!;
    expect(href.startsWith('https://play.google.com/store/apps/details?id=com.magicbooklet.mobile&referrer=')).toBe(true);
    // As Play hands it to the app.
    const carried = decodeURIComponent(href.slice(href.indexOf('referrer=') + 'referrer='.length));
    expect(readInviteInstallReferrer(carried)).toEqual({ code: CODE, kind: 'shared_link', path: '/creators/mira' });
    expect(screen.getByRole('link', { name: 'or join here' })).toBeInTheDocument();
  });

  it('copies the invite’s own link on an iPhone, and says so before it does', async () => {
    onDevice(UA.iphoneSafari);
    render(<InviteHandoffBar handoff={PREVIEW} />);
    expect(screen.getByText('This copies your invite link. After installing, open the app and tap Paste to keep it.')).toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Get the app' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0]![0];
    expect(copied).toBe(`${origin()}/creators/mira?r=${CODE}`);
    // Only after the link is on the clipboard.
    expect(store.open).toHaveBeenCalledWith('https://apps.apple.com/app/id6773286115');
    // The app reads the same link back (from the site's own host).
    expect(readInviteHandoffLink(copied.replace(origin(), 'https://magicbooklet.com'))).toEqual({ code: CODE, kind: 'shared_link', path: '/creators/mira' });
  });

  it('does not send an iPhone to the store with nothing copied', async () => {
    onDevice(UA.iphoneSafari);
    writeText.mockRejectedValue(new Error('NotAllowedError'));
    render(<InviteHandoffBar handoff={PREVIEW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Get the app' }));
    expect(await screen.findByText('Your invite link could not be copied here. Join on this page to keep it.')).toBeInTheDocument();
    expect(store.open).not.toHaveBeenCalled();
  });

  it('keeps Get the app inside another app’s browser, and points the web sign-up at the phone’s own', () => {
    onDevice(UA.iphoneInstagram);
    render(<InviteHandoffBar handoff={PREVIEW} />);
    expect(screen.getByRole('button', { name: 'Get the app' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'or join here' })).toBeNull();
    expect(screen.getByText(/To join on the web instead/)).toBeInTheDocument();
  });
});

describe('the same offer on the invite landing, with the switch off', () => {
  const INVITE: StoredInviteHandoff = { code: CODE, kind: 'invite', path: '/create', preview: false };
  switchedOff();

  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('has no Close and no second sign-up button: the landing has its own', () => {
    onDevice(UA.androidChrome);
    render(<InviteHandoffLandingOffer handoff={INVITE} />);
    expect(screen.getByText('Prefer the mobile app?')).toBeInTheDocument();
    expect(screen.getByText(/Create your account here first, then get the app from/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Join free' })).toBeNull();
  });

  it('is not hidden by a Close made on another page of the tab', () => {
    onDevice(UA.macChrome);
    window.sessionStorage.setItem('mb.invite-handoff-dismissed.v1', '1');
    render(<InviteHandoffLandingOffer handoff={INVITE} />);
    expect(screen.getByRole('button', { name: 'Get the app' })).toBeInTheDocument();
  });
});
