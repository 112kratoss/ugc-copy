import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refreshMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

import { PostModerationControls } from '@/app/admin/(console)/content/PostModerationControls';

const POST_ID = '11111111-0000-4000-8000-000000000001';
const SUBMISSION_ID = '22222222-0000-4000-8000-000000000002';
const NEXT_SUBMISSION_ID = '33333333-0000-4000-8000-000000000003';

describe('PostModerationControls', () => {
  beforeEach(() => {
    refreshMock.mockReset();
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(SUBMISSION_ID)
      .mockReturnValue(NEXT_SUBMISSION_ID);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reuses the submission key after an HTTP error so partial take-downs can resume safely', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Storage revocation failed.' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'already_applied',
          action: 'take_down',
          mediaRevocationVerified: true,
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(<PostModerationControls postId={POST_ID} reviewStatus="visible" />);
    fireEvent.click(screen.getByRole('button', { name: 'Take down' }));
    fireEvent.change(screen.getByLabelText('Reason (required)'), {
      target: { value: 'Confirmed policy violation.' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Permanently take down' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Storage revocation failed.');

    fireEvent.click(screen.getByRole('button', { name: 'Permanently take down' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(firstBody.idempotencyKey).toBe(SUBMISSION_ID);
    expect(retryBody.idempotencyKey).toBe(SUBMISSION_ID);
    expect(refreshMock).toHaveBeenCalledOnce();
  });
});
