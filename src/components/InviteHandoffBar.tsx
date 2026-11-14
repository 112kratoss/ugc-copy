'use client';

import { QrCode, Smartphone, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { ModalSheet } from '@/components/ModalSheet';
import { getAppStoreLinks } from '@/lib/app-store-links';
import {
  androidOpenInChromeUrl,
  dismissInviteHandoff,
  inviteHandoffDevice,
  inviteHandoffDismissed,
  inviteHandoffOffer,
  inviteHandoffPreviewOnly,
  inviteJoinPath,
  isInAppBrowser,
  openStoreListing,
  type StoredInviteHandoff,
} from '@/lib/invite-handoff';

import {
  buildInviteHandoffLink,
  withInviteInstallReferrer,
} from '../../ugc-mobile/lib/invite-share-link/invite-install-handoff';

/**
 * What a visitor holding an invite is told of who gains by it, wherever the
 * offer is drawn (Terms §5). "Whoever invited you", not "who shared this": the
 * invite this browser keeps may be an earlier one than the link just opened.
 */
export const INVITE_HANDOFF_DISCLOSURE = 'Whoever invited you may earn bonus credits if you join.';

/** On a page opened with the preview switch: what it shows is not true of the app yet. */
export const INVITE_HANDOFF_PREVIEW_NOTE = 'Preview: the app in the stores can’t keep an invite yet.';

const PRIMARY_CLASS = 'ui-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 text-sm font-black text-[var(--ui-primary-on)] transition hover:brightness-105';
const LINK_CLASS = 'ui-focus-ring rounded-lg font-extrabold text-[var(--ui-primary)] underline underline-offset-2';

/** The link drawn as a QR code: dark on light with its quiet zone, whatever the page's theme. */
function InviteQrCode({ value }: { value: string }) {
  const [code, setCode] = useState<{ size: number; path: string } | null>(null);

  useEffect(() => {
    let live = true;
    void import('qrcode-generator').then(({ default: qrcode }) => {
      if (!live) return;
      const qr = qrcode(0, 'M');
      qr.addData(value);
      qr.make();
      const size = qr.getModuleCount();
      let path = '';
      for (let row = 0; row < size; row += 1) {
        for (let column = 0; column < size; column += 1) {
          if (qr.isDark(row, column)) path += `M${column + 4} ${row + 4}h1v1h-1z`;
        }
      }
      setCode({ size: size + 8, path });
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [value]);

  return (
    <div className="mx-auto mt-4 aspect-square w-56 max-w-full overflow-hidden rounded-2xl bg-white p-1">
      {code ? (
        <svg viewBox={`0 0 ${code.size} ${code.size}`} role="img" aria-label="QR code for this page, with your invite" className="h-full w-full" shapeRendering="crispEdges">
          <path d={code.path} fill="#000000" />
        </svg>
      ) : null}
    </div>
  );
}

function QrSheet({ link, onClose }: { link: string; onClose: () => void }) {
  const doneRef = useRef<HTMLButtonElement>(null);
  // A child of <body>, as the sheet's hold on the page beneath expects (`useInertPageBeneath`):
  // drawn inside the page it would be held inert with it.
  return createPortal(
    <ModalSheet
      title="Scan to open this on your phone"
      body="Point your phone’s camera at the code. It opens this page there, and your invite comes with it."
      initialFocusRef={doneRef}
      onClose={onClose}
    >
      <InviteQrCode value={link} />
      <div className="ui-confirm-actions">
        <button ref={doneRef} type="button" onClick={onClose} className={PRIMARY_CLASS}>Done</button>
      </div>
    </ModalSheet>,
    document.body,
  );
}

/**
 * The offer itself. Mounted only in the browser, after the page knows the
 * invite (never in the server's HTML), so it may ask the browser what it is.
 */
function InviteHandoffOfferBody({ handoff, variant }: { handoff: StoredInviteHandoff; variant: 'bar' | 'landing' }) {
  const [browser] = useState(() => ({
    device: inviteHandoffDevice(window.navigator.userAgent, window.navigator.maxTouchPoints),
    inAppBrowser: isInAppBrowser(window.navigator.userAgent),
    origin: window.location.origin,
  }));
  const [closed, setClosed] = useState(() => variant === 'bar' && inviteHandoffDismissed());
  const [qrOpen, setQrOpen] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const link = buildInviteHandoffLink(browser.origin, handoff);
  if (closed || !link) return null;

  const stores = getAppStoreLinks();
  const offer = inviteHandoffOffer({ device: browser.device, inAppBrowser: browser.inAppBrowser, preview: handoff.preview });
  const previewOnly = offer === 'app' && inviteHandoffPreviewOnly({ device: browser.device, preview: handoff.preview });
  const joinPath = inviteJoinPath(handoff);
  const phoneBrowser = browser.device === 'ios' ? 'Safari' : 'Chrome';
  const storeName = browser.device === 'ios' ? 'the App Store' : 'Google Play';
  const storeUrl = browser.device === 'ios' ? stores.appStore : stores.playStore;
  const chromeUrl = browser.device === 'android' ? androidOpenInChromeUrl(link) : null;

  // iPhone: Apple carries nothing through an install, so the invite's link goes
  // on the clipboard and the app's first launch offers to paste it.
  const copyThenOpenAppStore = async () => {
    try {
      await window.navigator.clipboard.writeText(link);
    } catch {
      setCopyFailed(true);
      return;
    }
    openStoreListing(stores.appStore);
  };

  const title = offer === 'app'
    ? 'Get the app and keep your invite'
    : offer === 'join'
      ? 'Join here to keep your invite'
      : offer === 'open-in-browser'
        ? `Open this page in ${phoneBrowser} to keep your invite`
        : 'On your phone? Take your invite with you';

  const openInBrowserNote = (
    <p className="text-xs leading-5 text-[var(--ui-text-muted)]">
      {offer === 'open-in-browser' ? 'Google sign-in doesn’t work inside this app. ' : 'Google sign-in doesn’t work inside this app. To join on the web instead, '}
      {chromeUrl ? (
        <><a href={chromeUrl} className={LINK_CLASS}>Open in Chrome</a>, or use this app’s menu and choose “Open in browser”.</>
      ) : (
        <>{offer === 'open-in-browser' ? 'Use' : 'use'} this app’s menu (··· or the compass) and choose “Open in {phoneBrowser}”.</>
      )}
    </p>
  );

  const offerBody = (
    <>
      <div className="flex items-start gap-3">
        {variant === 'bar' ? (
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--ui-primary-soft)] text-[var(--ui-primary)]">
            <Smartphone className="h-4 w-4" aria-hidden />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-extrabold text-[var(--ui-text-primary)]">
            {variant === 'landing' ? <Smartphone className="h-4 w-4 shrink-0" aria-hidden /> : null}
            {variant === 'landing' && offer === 'app' ? 'Prefer the mobile app? Your invite comes with you' : null}
            {variant === 'landing' && offer === 'join' ? 'Prefer the mobile app?' : null}
            {variant === 'landing' && (offer === 'open-in-browser' || offer === 'qr') ? title : null}
            {variant === 'bar' ? title : null}
          </p>
          {variant === 'bar' ? (
            <p className="mt-1 text-xs leading-5 text-[var(--ui-text-muted)]">{INVITE_HANDOFF_DISCLOSURE}</p>
          ) : null}
          {previewOnly ? (
            <p className="mt-1 text-xs font-extrabold leading-5 text-[var(--ui-accent-commerce)]">{INVITE_HANDOFF_PREVIEW_NOTE}</p>
          ) : null}

          {offer === 'app' ? (
            <div className="mt-3 grid gap-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {browser.device === 'android' ? (
                  <a href={withInviteInstallReferrer(stores.playStore, handoff)} className={PRIMARY_CLASS}>Get the app</a>
                ) : (
                  <button type="button" onClick={() => void copyThenOpenAppStore()} className={PRIMARY_CLASS}>Get the app</button>
                )}
                {variant === 'bar' && !browser.inAppBrowser ? <Link href={joinPath} className={`${LINK_CLASS} text-sm`}>or join here</Link> : null}
              </div>
              {browser.device === 'ios' ? (
                <p role="status" className="text-xs leading-5 text-[var(--ui-text-muted)]">
                  {copyFailed
                    ? `Your invite link could not be copied here. Join on this page to keep it${browser.inAppBrowser ? `, after opening it in ${phoneBrowser}` : ''}.`
                    : 'This copies your invite link. After installing, open the app and tap Paste to keep it.'}
                </p>
              ) : null}
              {browser.inAppBrowser ? openInBrowserNote : null}
            </div>
          ) : null}

          {offer === 'join' ? (
            <div className="mt-3 grid gap-2">
              {variant === 'bar' ? (
                <div><Link href={joinPath} className={PRIMARY_CLASS}>Join free</Link></div>
              ) : null}
              <p className="text-xs leading-5 text-[var(--ui-text-muted)]">
                {variant === 'bar' ? 'Prefer the app? Join here first, then get it from ' : 'Create your account here first, then get the app from '}
                <a href={storeUrl} className={LINK_CLASS}>{storeName}</a>
                . An account made in the app can’t keep this invite yet.
              </p>
            </div>
          ) : null}

          {offer === 'open-in-browser' ? <div className="mt-2 grid gap-2">{openInBrowserNote}</div> : null}

          {offer === 'qr' ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <button type="button" onClick={() => setQrOpen(true)} className={PRIMARY_CLASS}>
                <QrCode className="h-4 w-4" aria-hidden /> Get the app
              </button>
              {variant === 'bar' ? <Link href={joinPath} className={`${LINK_CLASS} text-sm`}>or join here</Link> : null}
            </div>
          ) : null}
        </div>
        {variant === 'bar' ? (
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={() => {
              dismissInviteHandoff();
              setClosed(true);
            }}
            className="ui-icon-button ui-focus-ring -mr-1 -mt-1 shrink-0"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>
      {qrOpen ? <QrSheet link={link} onClose={() => setQrOpen(false)} /> : null}
    </>
  );

  return variant === 'bar' ? (
    <aside aria-label="Your invite" className="mx-auto w-full max-w-3xl px-4 pt-4">
      <div className="rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] p-4">{offerBody}</div>
    </aside>
  ) : (
    <div className="rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] p-4">{offerBody}</div>
  );
}

/**
 * The offer to carry an invite on to the app, drawn at the top of the page a
 * shared link opened (the post page, the creator page) for a visitor with no
 * account: on a phone, the way that keeps the invite there (the app, once the
 * app in the stores keeps a handed-over invite; joining on the page until
 * then; the phone's own browser from inside another app's); on a laptop, a QR
 * code that opens the page on the phone. `handoff` is what
 * `useInviteVisitFromSharedLink` answers: null draws nothing.
 */
export function InviteHandoffBar({ handoff }: { handoff: StoredInviteHandoff | null }) {
  if (!handoff) return null;
  return <InviteHandoffOfferBody key={`${handoff.code}:${handoff.kind}`} handoff={handoff} variant="bar" />;
}

/** The same offer inside the invite landing's own card (`/r/<code>`), once its invite is saved. */
export function InviteHandoffLandingOffer({ handoff }: { handoff: StoredInviteHandoff }) {
  return <InviteHandoffOfferBody key={`${handoff.code}:${handoff.kind}`} handoff={handoff} variant="landing" />;
}
