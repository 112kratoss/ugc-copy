import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PostReportActions, SubjectReportActions } from '@/app/admin/(console)/moderation/ModerationActions';
import { PayoutActions } from '@/app/admin/(console)/payouts/PayoutActions';
import { ContactTriageControls } from '@/app/admin/(console)/system/ContactTriageControls';
import { CreditAdjustmentForm } from '@/app/admin/(console)/users/[userId]/CreditAdjustmentForm';
import { UserSanctionForm } from '@/app/admin/(console)/users/[userId]/UserSanctionForm';
import { TYPED_BEFORE_HYDRATION_CAPTURE } from '@/lib/typed-before-hydration';

const mocks = vi.hoisted(() => ({
  router: { replace: vi.fn(), refresh: vi.fn() },
  fetch: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
}));

// The admin console's pages are drawn on the server, and what an operator types into a field before
// the page's script runs reaches no React: React hydrated the fields without reading them back, so
// the moderation and sanction actions stayed disabled with a note on screen, "Mark paid" sent no
// reference, "Mark handled" sent an empty note, and a duration chosen early was sent as 24 hours
// (2026-11-06; the probe in archive/forms-sweep-2026-11-06 shows each on the page, which the E2E env
// cannot draw without admin access configured).
describe('admin console fields filled in before the page’s script ran', () => {
  const EARLY = 'Filled in before the script ran';
  const recoverableErrors: unknown[] = [];

  beforeAll(() => {
    // The root layout's capture, as the server's HTML runs it ahead of every field.
    new Function(TYPED_BEFORE_HYDRATION_CAPTURE)();
  });

  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Paused for the test.' }), { status: 503 }));
    vi.stubGlobal('fetch', mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    // The page hydrated: React never drew it again on the client, which would drop the text.
    expect(recoverableErrors.splice(0)).toEqual([]);
  });

  /** Filling in the server's HTML: events no React hears. */
  function fillIn(field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
    field.value = value;
    field.dispatchEvent(new Event(field.localName === 'select' ? 'change' : 'input', { bubbles: true }));
  }

  /** `page`'s server HTML, filled by `fill`, then hydrated. */
  function hydrateAfter(page: ReactElement, fill: (container: HTMLElement) => void) {
    const container = document.createElement('div');
    container.innerHTML = renderToString(page);
    document.body.appendChild(container);
    fill(container);
    render(page, { container, hydrate: true, onRecoverableError: (error) => recoverableErrors.push(error) });
    return container;
  }

  const field = <T extends Element>(container: HTMLElement, selector: string) => container.querySelector<T>(selector)!;
  const press = (name: string | RegExp) => act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
  const sentBody = (call = 0) => JSON.parse(mocks.fetch.mock.calls[call][1].body as string);

  it('a post report decides with the note typed early', async () => {
    const container = hydrateAfter(<PostReportActions reportId="r1" />, (page) => {
      fillIn(field(page, '#note-r1'), EARLY);
    });

    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
    await press('Dismiss');

    expect(mocks.fetch.mock.calls[0][0]).toBe('/api/admin/moderation/post-reports');
    expect(sentBody()).toEqual({ reportId: 'r1', action: 'dismiss', note: EARLY });
    expect(field<HTMLTextAreaElement>(container, '#note-r1').value).toBe(EARLY);
  });

  it('a subject report decides with the note typed early', async () => {
    hydrateAfter(<SubjectReportActions reportId="r2" targetType="user" />, (page) => {
      fillIn(field(page, '#subject-note-r2'), EARLY);
    });

    await press('Resolve');

    expect(sentBody()).toEqual({ reportId: 'r2', action: 'resolve', note: EARLY });
  });

  it('a report note takes only typing: text no input event brought is not taken', () => {
    hydrateAfter(<PostReportActions reportId="r3" />, (page) => {
      field<HTMLTextAreaElement>(page, '#note-r3').value = 'Put back by the browser';
    });

    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled();
  });

  it('a payout is marked paid with the reference and note filled in early', async () => {
    const container = hydrateAfter(<PayoutActions requestId="p1" amountUsd="$12.35" />, (page) => {
      fillIn(field(page, 'input[aria-label="Payout reference"]'), 'UTR-EARLY-123');
      fillIn(field(page, 'input[aria-label="Payout note"]'), EARLY);
    });

    await press('Mark $12.35 paid');

    expect(sentBody()).toEqual({ requestId: 'p1', action: 'mark_paid', note: EARLY, externalReference: 'UTR-EARLY-123' });
    expect(field<HTMLInputElement>(container, 'input[aria-label="Payout reference"]').value).toBe('UTR-EARLY-123');
  });

  it('a contact message is marked handled with the note filled in early', async () => {
    hydrateAfter(<ContactTriageControls messageId="m1" isHandled={false} />, (page) => {
      fillIn(field(page, 'input[type="text"]'), EARLY);
    });

    await press('Mark handled');

    expect(sentBody()).toEqual({ messageId: 'm1', handled: true, note: EARLY });
  });

  it('a credit adjustment reviews and sends the amount and reason filled in early', async () => {
    hydrateAfter(<CreditAdjustmentForm userId="u1" credits={100} promotionalCredits={25} />, (page) => {
      fillIn(field(page, 'input[type="number"]'), '42');
      fillIn(field(page, 'input[type="text"]'), EARLY);
    });

    await press('Review adjustment');
    await press('Confirm goodwill grant');

    expect(sentBody()).toMatchObject({ userId: 'u1', intent: 'goodwill', amount: 42, reason: EARLY });
  });

  it('a suspension sends the duration chosen and the reason typed early', async () => {
    const container = hydrateAfter(<UserSanctionForm userId="u1" isSuspended={false} bannedUntil={null} />, (page) => {
      fillIn(field(page, 'select'), '168');
      fillIn(field(page, 'textarea'), EARLY);
    });

    await press('Suspend account');

    expect(sentBody()).toMatchObject({ userId: 'u1', action: 'suspend', reason: EARLY, durationHours: 168 });
    expect(field<HTMLSelectElement>(container, 'select').value).toBe('168');
  });

  it('a reinstatement, which draws no duration, sends the reason typed early', async () => {
    hydrateAfter(<UserSanctionForm userId="u1" isSuspended bannedUntil={null} />, (page) => {
      fillIn(field(page, 'textarea'), EARLY);
    });

    await press('Reinstate account');

    expect(sentBody()).toMatchObject({ action: 'reinstate', reason: EARLY, durationHours: null });
  });
});
