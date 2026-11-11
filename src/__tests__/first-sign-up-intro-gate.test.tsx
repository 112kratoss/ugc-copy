import { act, fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FirstSignUpIntroGate } from '@/components/onboarding/FirstSignUpIntroGate';
import {
  FIRST_SIGN_UP_INTRO_COVER_SCRIPT,
  FIRST_SIGN_UP_INTRO_STORAGE_KEY,
  liftFirstSignUpIntroCover,
} from '@/lib/first-sign-up-intro';
import {
  CALM_LETTER_AT,
  CALM_LETTER_READ_AT,
  INTRO_LETTER_SPOKEN,
  INTRO_WORDS_SPOKEN,
  LETTER_AT,
  LETTER_READ_AT,
} from '@/lib/first-sign-up-intro-timeline';

// The first sign-up intro over the creator-name step: when the gate plays it
// (the rule itself is first-sign-up-intro.test.ts's), what a screen reader
// and the keyboard meet, and the page beneath it. The drawing is a canvas,
// which jsdom does not have: the clock, the words and the dust are
// first-sign-up-intro-timeline.test.ts's, and the motion was checked on the
// page itself (archive/web-onboarding-parity-2026-11-09/pr4-intro/).

vi.mock('@/lib/display-font', () => ({
  displayFont: { className: 'display-face', variable: 'display-variable', style: { fontFamily: "'Display Face'" } },
}));

vi.mock('@/lib/handwriting-font', () => ({
  handwritingFont: { className: 'handwriting-face', variable: 'handwriting-variable', style: { fontFamily: "'Handwriting Face'" } },
}));

function renderGate() {
  return render(
    <FirstSignUpIntroGate>
      <form aria-label="Claim your creator name">
        <input aria-label="Display name" />
      </form>
    </FirstSignUpIntroGate>,
  );
}

/** The element of <body> that holds the page beneath the intro. */
function pageBeneath(container: HTMLElement) {
  return container;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * The intro's clock starts once the page beneath has settled (jsdom has no
 * requestIdleCallback: the 50 ms fallback), at the next animation frame: faked
 * frames fall every 16 ms, so the one at 64 ms.
 */
async function startClock() {
  await advance(64);
}

describe('FirstSignUpIntroGate', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/onboarding?next=%2F');
    window.localStorage.clear();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] });
    // jsdom draws no canvas: the stage is left out, and the timeline runs on.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    liftFirstSignUpIntroCover(document.documentElement);
    window.localStorage.clear();
    Reflect.deleteProperty(window, 'matchMedia');
    window.history.replaceState(null, '', '/');
  });

  it('plays over the name step on a browser\'s first sign-up, remembered as it begins', () => {
    const { container } = renderGate();

    const dialog = screen.getByRole('dialog', { name: 'Welcome to Magic Booklet' });
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(window.localStorage.getItem(FIRST_SIGN_UP_INTRO_STORAGE_KEY)).not.toBeNull();
    // The words, read as one item.
    expect(screen.getByText(INTRO_WORDS_SPOKEN)).toHaveClass('sr-only');
    // The page beneath takes no press, key or reader's attention, and does not scroll.
    expect(pageBeneath(container).inert).toBe(true);
    expect(pageBeneath(container)).toHaveAttribute('aria-hidden', 'true');
    expect(document.documentElement.style.overflow).toBe('hidden');
  });

  it('brings the note in as the words go, then moves the focus to Explore as it can be pressed', async () => {
    renderGate();
    const dialog = screen.getByRole('dialog');
    await startClock();

    await advance(LETTER_AT - 1);
    expect(screen.queryByRole('button', { name: 'Explore' })).toBeNull();

    await advance(1);
    // The note, read as one item: the dialog's name and description.
    expect(dialog).toHaveAccessibleName('A note from the team');
    expect(dialog).toHaveAccessibleDescription(INTRO_LETTER_SPOKEN);
    expect(screen.queryByText(INTRO_WORDS_SPOKEN)).toBeNull();
    const button = screen.getByRole('button', { name: 'Explore' });
    expect(button).toHaveAttribute('inert');
    expect(button).not.toHaveFocus();

    await advance(LETTER_READ_AT - LETTER_AT);
    expect(button).not.toHaveAttribute('inert');
    expect(button).toHaveFocus();
  });

  it('lifts off the page beneath on Explore, and gives the page back', async () => {
    const { container } = renderGate();
    await startClock();
    await advance(LETTER_READ_AT);

    fireEvent.click(screen.getByRole('button', { name: 'Explore' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    // Its own state from before (jsdom has no inert of its own: undefined).
    expect(pageBeneath(container).inert).toBeFalsy();
    expect(pageBeneath(container)).not.toHaveAttribute('aria-hidden');
    expect(document.documentElement.style.overflow).toBe('');
    expect(screen.getByRole('textbox', { name: 'Display name' })).toBeInTheDocument();
  });

  it('lifts off at once on Escape, before the note has come', async () => {
    renderGate();
    await advance(1200);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('A note from the team')).toBeNull();
    // Seen is seen: Escape does not bring it back next time.
    expect(window.localStorage.getItem(FIRST_SIGN_UP_INTRO_STORAGE_KEY)).not.toBeNull();
  });

  it('under reduced motion, cross-fades to the note sooner, with no dust to wait for', async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    renderGate();
    await startClock();

    await advance(CALM_LETTER_AT);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('A note from the team');
    await advance(CALM_LETTER_READ_AT - CALM_LETTER_AT);
    expect(screen.getByRole('button', { name: 'Explore' })).toHaveFocus();
  });

  it('plays once per browser', () => {
    window.localStorage.setItem(FIRST_SIGN_UP_INTRO_STORAGE_KEY, '2026-11-09T00:00:00.000Z');
    const { container } = renderGate();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(pageBeneath(container).inert).toBeFalsy();
  });

  it('does not play where storage refuses the write, and lifts the cover', () => {
    document.documentElement.dataset.firstSignUpIntro = 'cover';
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    renderGate();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.documentElement.dataset.firstSignUpIntro).toBeUndefined();
  });

  it('does not play away from /onboarding, the page of a test that renders it elsewhere included', () => {
    window.history.replaceState(null, '', '/');
    renderGate();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.localStorage.getItem(FIRST_SIGN_UP_INTRO_STORAGE_KEY)).toBeNull();
  });

  it('stays away when the cover lifted before the page could decide, and leaves the flag for a later visit', () => {
    document.documentElement.dataset.firstSignUpIntro = 'lifted';
    renderGate();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.documentElement.dataset.firstSignUpIntro).toBeUndefined();
    expect(window.localStorage.getItem(FIRST_SIGN_UP_INTRO_STORAGE_KEY)).toBeNull();
  });

  it('takes over from the server\'s cover with its own ground', () => {
    document.documentElement.dataset.firstSignUpIntro = 'cover';
    renderGate();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(document.documentElement.dataset.firstSignUpIntro).toBeUndefined();
  });

  it('draws the cover and its script in the server\'s HTML, ahead of the name step', () => {
    const html = renderToString(
      <FirstSignUpIntroGate>
        <p>Claim your creator name</p>
      </FirstSignUpIntroGate>,
    );

    const script = html.indexOf(`<script>${FIRST_SIGN_UP_INTRO_COVER_SCRIPT}</script>`);
    expect(script).toBeGreaterThan(-1);
    expect(html.indexOf('[html[data-first-sign-up-intro=cover]_&amp;]:block')).toBeLessThan(script);
    expect(script).toBeLessThan(html.indexOf('Claim your creator name'));
    expect(html).not.toContain('role="dialog"');
  });
});
