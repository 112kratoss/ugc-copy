import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLAIM_CONFETTI_MS } from '../../ugc-mobile/lib/claim-confetti-flight/claim-confetti-flight';
import { WELCOME_COUNT_UP_MS } from '../../ugc-mobile/lib/welcome-popup-policy/welcome-popup-policy';

const harness = vi.hoisted(() => ({
  claim: vi.fn(),
}));

vi.mock('@/lib/welcome-credits-requests', () => ({
  claimWelcomeCredits: harness.claim,
}));

import WelcomeCreditsPopup from '@/components/WelcomeCreditsPopup';

type FakeAnimation = {
  element: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  paused: boolean;
  played: boolean;
  cancelled: boolean;
};

const animations: FakeAnimation[] = [];
const credits: unknown[] = [];
const onCreditsUpdated = (event: Event) => credits.push((event as CustomEvent).detail ?? 're-read');
const claimed = { status: 'claimed', amount: 25, credits: 25, identityComplete: true };

function installAnimate() {
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const record: FakeAnimation = { element: this, keyframes, options, paused: false, played: false, cancelled: false };
      animations.push(record);
      return {
        pause: () => { record.paused = true; },
        play: () => { record.played = true; },
        cancel: () => { record.cancelled = true; },
        finished: Promise.resolve(),
      };
    },
  });
}

function setReducedMotion(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: reduce && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }),
  });
}

/** Lays the figure out where a browser would: jsdom lays nothing out. */
function layOut() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 135, y: 300, left: 135, top: 300, right: 255, bottom: 386, width: 120, height: 86, toJSON: () => ({}),
  } as DOMRect);
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderPopup() {
  const onClose = vi.fn();
  const onGone = vi.fn();
  const onAnswer = vi.fn();
  const view = render(
    <>
      <main data-testid="page">The page beneath</main>
      <WelcomeCreditsPopup amount={25} referral={null} onClose={onClose} onGone={onGone} onAnswer={onAnswer} />
    </>,
  );
  return { ...view, onClose, onGone, onAnswer };
}

const figure = () => document.querySelector('.ui-welcome-figure-number')?.textContent;
const confettiPieces = () => document.querySelectorAll('.ui-welcome-confetti-piece');
const pieceAnimations = () => animations.filter((animation) => (
  animation.element.closest('.ui-welcome-confetti') !== null
));

describe('the welcome-credits popup (the app’s card on the web, owner 11-09)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] });
    animations.length = 0;
    credits.length = 0;
    harness.claim.mockReset();
    installAnimate();
    setReducedMotion(false);
    window.addEventListener('credits_updated', onCreditsUpdated);
  });

  afterEach(() => {
    window.removeEventListener('credits_updated', onCreditsUpdated);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('offers the credits in the app’s card: the badge in its ring, the figure, the title, the note, Claim and Close', async () => {
    renderPopup();
    await advance(16);

    const dialog = screen.getByRole('dialog', { name: 'Claim your welcome credits' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(figure()).toBe('25');
    expect(screen.getByText('creation credits')).toBeInTheDocument();
    expect(screen.getByText(/It can only be used for creating media, not to buy recipes or resources/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claim' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
    // The page beneath takes no press and is hidden from assistive technology meanwhile.
    expect(screen.getByTestId('page').parentElement).toHaveAttribute('aria-hidden', 'true');
    expect((screen.getByTestId('page').parentElement as HTMLElement & { inert: boolean }).inert).toBe(true);
    // The card springs in, as the app's does.
    expect(animations.some((animation) => animation.element.classList.contains('ui-welcome-card'))).toBe(true);
  });

  it('counts the credits up from 0 on the shared curve, and moves the header only as the count lands', async () => {
    harness.claim.mockResolvedValue(claimed);
    const { onAnswer } = renderPopup();
    await advance(16);

    fireEvent.click(screen.getByRole('button', { name: 'Claim' }));
    await advance(0);
    expect(onAnswer).toHaveBeenCalledWith(claimed);
    expect(screen.getByRole('heading', { name: 'Adding your credits' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('25 credits added to your balance.');

    await advance(WELCOME_COUNT_UP_MS / 2);
    const midway = Number(figure()?.replace('+', ''));
    expect(midway).toBeGreaterThan(5);
    expect(midway).toBeLessThan(25);
    expect(credits).toEqual([]);

    await advance(WELCOME_COUNT_UP_MS);
    expect(figure()).toBe('+25');
    expect(screen.getByRole('heading', { name: 'Credits added!' })).toBeInTheDocument();
    expect(screen.getByText('Added to your balance')).toBeInTheDocument();
    // Held back until the landing, then told once, with the balance the claim answered.
    expect(credits).toEqual([{ credits: 25, marketplaceSpendableCredits: undefined }]);
  });

  // Next's dev server renders in StrictMode, which runs every effect's cleanup once at mount:
  // the card took its own claim's answer for a card that had gone, told the header to read
  // the balance again and stayed on "Claiming…" (seen on a local stack, 2026-11-09).
  it('takes its claim’s answer when its effects have been run twice, as in development', async () => {
    harness.claim.mockResolvedValue(claimed);
    render(
      <StrictMode>
        <WelcomeCreditsPopup amount={25} referral={null} onClose={vi.fn()} onGone={vi.fn()} onAnswer={vi.fn()} />
      </StrictMode>,
    );
    await advance(16);

    fireEvent.click(screen.getByRole('button', { name: 'Claim' }));
    await advance(0);
    expect(screen.getByRole('heading', { name: 'Adding your credits' })).toBeInTheDocument();
    await advance(WELCOME_COUNT_UP_MS + 32);
    expect(figure()).toBe('+25');
    expect(credits).toEqual([{ credits: 25, marketplaceSpendableCredits: undefined }]);
  });

  it('throws the confetti as the count lands, sinks the card 260 ms after, and leaves once the last piece has fallen', async () => {
    layOut();
    harness.claim.mockResolvedValue(claimed);
    const { onClose, onGone } = renderPopup();
    await advance(16);

    fireEvent.click(screen.getByRole('button', { name: 'Claim' }));
    await advance(0);
    // Mounted while the count runs, invisible and still: every flight built and paused.
    expect(confettiPieces()).toHaveLength(48);
    expect(pieceAnimations()).toHaveLength(48 * 3);
    expect(pieceAnimations().every((animation) => animation.paused && !animation.played)).toBe(true);
    for (const animation of pieceAnimations()) {
      for (const frame of animation.keyframes) {
        expect(Object.keys(frame).filter((key) => key !== 'offset').every((key) => key === 'transform' || key === 'opacity')).toBe(true);
      }
    }

    await advance(WELCOME_COUNT_UP_MS + 32);
    expect(figure()).toBe('+25');
    expect(pieceAnimations().every((animation) => animation.played)).toBe(true);
    // The figure and the badge pop as it lands.
    expect(animations.some((animation) => animation.element.classList.contains('ui-welcome-figure-number'))).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    await advance(260);
    expect(onClose).toHaveBeenCalledTimes(1);
    const stack = document.querySelector('.ui-welcome-stack')!;
    const exit = animations.find((animation) => animation.element === stack);
    expect(exit?.options).toMatchObject({ duration: 420, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' });
    expect(exit?.keyframes.at(-1)).toMatchObject({ opacity: 0, transform: 'translateY(24px) scale(0.92)' });
    // The page is given back at once, while the confetti still falls over it.
    expect(document.querySelector('.ui-welcome-popup')).toHaveAttribute('data-leaving');
    expect(screen.getByTestId('page').parentElement).not.toHaveAttribute('aria-hidden');
    expect(onGone).not.toHaveBeenCalled();

    await advance(CLAIM_CONFETTI_MS);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('lets neither Close nor Escape take the card away until the count has landed', async () => {
    let answer!: (value: unknown) => void;
    harness.claim.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const { onClose } = renderPopup();
    await advance(16);

    fireEvent.click(screen.getByRole('button', { name: 'Claim' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    await act(async () => answer(claimed));
    fireEvent.keyDown(window, { key: 'Escape' });
    await advance(WELCOME_COUNT_UP_MS / 2);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape or Close while it is only offered, remembered for the session', async () => {
    const first = renderPopup();
    await advance(16);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(first.onClose).toHaveBeenCalledTimes(1);
    await advance(420);
    expect(first.onGone).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = renderPopup();
    await advance(16);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(second.onClose).toHaveBeenCalledTimes(1);
    expect(harness.claim).not.toHaveBeenCalled();
  });

  it('keeps the focus in the card and its Close', async () => {
    renderPopup();
    await advance(16);
    const claim = screen.getByRole('button', { name: 'Claim' });
    const close = screen.getByRole('button', { name: 'Close' });

    close.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(claim).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(close).toHaveFocus();
  });

  it('offers Try again after a failed claim, and leaves only Close after the server’s final no', async () => {
    harness.claim
      .mockRejectedValueOnce(new Error('Could not claim welcome credits.'))
      .mockResolvedValueOnce({ status: 'identity_already_claimed', amount: 25, credits: 0, identityComplete: true });
    renderPopup();
    await advance(16);

    fireEvent.click(screen.getByRole('button', { name: 'Claim' }));
    await advance(0);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not claim welcome credits.');
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await advance(0);
    expect(screen.getByRole('alert')).toHaveTextContent('These credits can’t be claimed on this account.');
    expect(screen.queryByRole('button', { name: /Claim|Try again/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    expect(credits).toEqual([]);
  });

  it('has the balance read again, rather than drawn, for credits claimed before in another tab', async () => {
    harness.claim.mockResolvedValue({ status: 'already_claimed', amount: 25, credits: 3, identityComplete: true });
    renderPopup();
    await advance(16);

    fireEvent.click(screen.getByRole('button', { name: 'Claim' }));
    await advance(WELCOME_COUNT_UP_MS + 32);
    expect(figure()).toBe('+25');
    expect(credits).toEqual(['re-read']);
  });

  it('says the invite’s outcome a sign-up brought, under the note', async () => {
    render(<WelcomeCreditsPopup amount={25} referral="applied" onClose={vi.fn()} onGone={vi.fn()} onAnswer={vi.fn()} />);
    await advance(16);
    expect(screen.getByText(/Invite applied/)).toBeInTheDocument();
  });

  it('under reduced motion: no fill, no confetti and no movement; the card holds to be read, then goes', async () => {
    setReducedMotion(true);
    layOut();
    harness.claim.mockResolvedValue(claimed);
    const { onClose, onGone } = renderPopup();
    await advance(16);
    expect(animations).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Claim' }));
    await advance(0);
    expect(figure()).toBe('+25');
    expect(screen.getByRole('heading', { name: 'Credits added!' })).toBeInTheDocument();
    expect(credits).toEqual([{ credits: 25, marketplaceSpendableCredits: undefined }]);
    expect(confettiPieces()).toHaveLength(0);

    await advance(1399);
    expect(onClose).not.toHaveBeenCalled();
    await advance(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(animations).toEqual([]);
  });
});
