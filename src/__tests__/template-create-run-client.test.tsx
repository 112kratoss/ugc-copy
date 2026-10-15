import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CreateTemplateRunClient from '@/components/templates/CreateTemplateRunClient';
import { TemplateApiError } from '@/components/templates/api';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  createTemplateRun: vi.fn(),
  // One stable router: a new object per render re-runs the effect that names it.
  router: {
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  },
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => mocks.useAuth(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
}));

vi.mock('@/components/templates/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/templates/api')>()),
  createTemplateRun: (...args: unknown[]) => mocks.createTemplateRun(...args),
}));

describe('CreateTemplateRunClient refusals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAuth.mockReturnValue({
      session: { access_token: 'creator-token', user: { id: 'creator-1' } },
      isLoading: false,
    });
  });

  it("says the creator's own draft or disabled template isn't live and leads back to its page, with no Try again", async () => {
    mocks.createTemplateRun.mockRejectedValue(new TemplateApiError('Template not found.', 404, 'TEMPLATE_NOT_ACTIVE'));

    render(<CreateTemplateRunClient slug="product-reveal" />);

    expect(await screen.findByText("This template isn't live")).toBeInTheDocument();
    expect(screen.queryByText('Could not start template')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to template' })).toHaveAttribute('href', '/templates/product-reveal');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(mocks.router.replace).not.toHaveBeenCalled();
  });

  it('shows the server sentence for a template that is gone, without a Try again that repeats it', async () => {
    mocks.createTemplateRun.mockRejectedValue(new TemplateApiError('Template not found.', 404, 'TEMPLATE_NOT_FOUND'));

    render(<CreateTemplateRunClient slug="product-reveal" />);

    expect(await screen.findByText('Could not start template')).toBeInTheDocument();
    expect(screen.getByText('Template not found.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/templates/product-reveal');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('keeps Try again, with the same idempotency key, for a refusal a retry can clear', async () => {
    mocks.createTemplateRun
      .mockRejectedValueOnce(new TemplateApiError('Too many template requests. Try again shortly.', 429, 'RATE_LIMITED'))
      .mockResolvedValueOnce({ id: 'run-1', templateTitle: 'Product Reveal' });

    render(<CreateTemplateRunClient slug="product-reveal" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith('/template-runs/run-1'));
    expect(mocks.createTemplateRun).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = mocks.createTemplateRun.mock.calls as Array<[string, string, string]>;
    expect(firstCall.slice(0, 2)).toEqual(['product-reveal', 'creator-token']);
    expect(secondCall[2]).toBe(firstCall[2]);
  });
});
