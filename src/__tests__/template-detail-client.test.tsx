import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TemplateDetailClient from '@/components/templates/TemplateDetailClient';
import type { MediaTemplate } from '@/components/templates/types';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  getTemplate: vi.fn(),
  fetch: vi.fn(),
  // One stable router: a new object per render re-runs every effect that names it.
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
  getTemplate: (...args: unknown[]) => mocks.getTemplate(...args),
}));

const TEMPLATE_ID = '11111111-1111-4111-8111-111111111111';

function template(overrides: Partial<MediaTemplate> = {}): MediaTemplate {
  return {
    id: TEMPLATE_ID,
    slug: 'product-reveal',
    name: 'Product Reveal',
    description: 'Turn one product photo into a reveal video.',
    category: 'Product',
    videoUrl: null,
    thumbnailUrl: null,
    creatorUserId: 'creator-1',
    creator: { id: 'creator-1', username: 'athul', displayName: 'Athul', avatarUrl: null },
    inputSlots: [{ key: 'product', kind: 'image', label: 'Product photo', required: true }],
    outputKind: 'video',
    status: 'active',
    moderationDisabledAt: null,
    useCount: 1,
    estimatedTotalCredits: 12,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

function signIn(userId: string | null) {
  mocks.useAuth.mockReturnValue({
    session: userId ? { access_token: `${userId}-token`, user: { id: userId } } : null,
    isLoading: false,
  });
}

function respond(status: number, body: unknown) {
  mocks.fetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

async function openReportForm(reason: string, details?: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Report template' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Report reason' }), { target: { value: reason } });
  if (details !== undefined) {
    fireEvent.change(screen.getByRole('textbox', { name: 'Report details' }), { target: { value: details } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));
}

describe('TemplateDetailClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetch);
    signIn(null);
    mocks.getTemplate.mockResolvedValue(template());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("the creator's own template that is not live", () => {
    it.each([
      ['draft', 'Draft', 'This template is a draft'],
      ['disabled', 'Disabled', 'This template is disabled'],
    ] as const)('shows a %s with its status, the canvas, and no start', async (status, label, title) => {
      signIn('creator-1');
      mocks.getTemplate.mockResolvedValue(template({ status }));

      render(<TemplateDetailClient slug="product-reveal" />);

      expect(await screen.findByText(title)).toBeInTheDocument();
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText(/Only you can see it/)).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Use this template' })).not.toBeInTheDocument();
      // Once, where the start button stood: the header leaves it out.
      const canvasLinks = screen.getAllByRole('link', { name: 'Open in workflow canvas' });
      expect(canvasLinks).toHaveLength(1);
      expect(canvasLinks[0]).toHaveAttribute('href', `/templates/${TEMPLATE_ID}/edit`);
      expect(mocks.getTemplate).toHaveBeenCalledWith('product-reveal', 'creator-1-token');
    });

    it('tells the creator a taken-down template cannot be published again', async () => {
      signIn('creator-1');
      mocks.getTemplate.mockResolvedValue(template({ status: 'disabled', moderationDisabledAt: '2026-10-15T12:00:00.000Z' }));

      render(<TemplateDetailClient slug="product-reveal" />);

      expect(await screen.findByText('This template was taken down')).toBeInTheDocument();
      expect(screen.getByText('Taken down')).toBeInTheDocument();
      expect(screen.getByText(/can't be published again/)).toBeInTheDocument();
      expect(screen.queryByText('This template is disabled')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Use this template' })).not.toBeInTheDocument();
    });

    it('offers a live template\'s start to its creator, with the canvas in the header and no report row', async () => {
      signIn('creator-1');

      render(<TemplateDetailClient slug="product-reveal" />);

      expect(await screen.findByRole('link', { name: 'Use this template' })).toHaveAttribute(
        'href',
        '/templates/product-reveal/create',
      );
      expect(screen.getAllByRole('link', { name: 'Open in workflow canvas' })).toHaveLength(1);
      expect(screen.queryByText('Draft')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Report template' })).not.toBeInTheDocument();
    });
  });

  it('links "Created by" to the creator\'s page and keeps "1 use" singular', async () => {
    render(<TemplateDetailClient slug="product-reveal" />);

    expect(await screen.findByRole('link', { name: /Created by\s*Athul/ })).toHaveAttribute('href', '/creators/athul');
    expect(screen.getByText('1 use')).toBeInTheDocument();
  });

  it('names a creator with no handle without a link', async () => {
    mocks.getTemplate.mockResolvedValue(template({
      creator: { id: 'creator-1', username: null, displayName: 'Athul', avatarUrl: null },
      useCount: 2,
    }));

    render(<TemplateDetailClient slug="product-reveal" />);

    expect(await screen.findByText('Athul')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Created by/ })).not.toBeInTheDocument();
    expect(screen.getByText('2 uses')).toBeInTheDocument();
  });

  describe('Report template', () => {
    it('files the template with the reason and context the viewer gave', async () => {
      signIn('viewer-1');
      respond(200, { success: true });

      render(<TemplateDetailClient slug="product-reveal" />);
      await openReportForm('stolen_content', '  Copied from my workflow.  ');

      expect(await screen.findByText('Report submitted for review.')).toBeInTheDocument();
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      const [path, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
      expect(path).toBe('/api/moderation/reports');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        Authorization: 'Bearer viewer-1-token',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(String(init.body))).toEqual({
        targetType: 'template',
        targetId: TEMPLATE_ID,
        reason: 'stolen_content',
        details: 'Copied from my workflow.',
      });
      expect(screen.queryByRole('combobox', { name: 'Report reason' })).not.toBeInTheDocument();
    });

    it('offers only the reasons a template can be reported for, and sends no empty context', async () => {
      signIn('viewer-1');
      respond(200, { success: true });

      render(<TemplateDetailClient slug="product-reveal" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Report template' }));

      const options = screen.getAllByRole('option').map((option) => option.getAttribute('value'));
      expect(options).toEqual(['', 'spam', 'stolen_content', 'unsafe_content', 'other']);
      expect(screen.getByRole('button', { name: 'Submit report' })).toBeDisabled();

      fireEvent.change(screen.getByRole('combobox', { name: 'Report reason' }), { target: { value: 'spam' } });
      fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));

      await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
      expect(JSON.parse(String((mocks.fetch.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
        targetType: 'template',
        targetId: TEMPLATE_ID,
        reason: 'spam',
      });
    });

    it('says an earlier report that is still open already covers it', async () => {
      signIn('viewer-1');
      respond(409, { error: 'You already reported this template. Our moderation team will review it.', code: 'ALREADY_REPORTED' });

      render(<TemplateDetailClient slug="product-reveal" />);
      await openReportForm('unsafe_content');

      expect(await screen.findByRole('status')).toHaveTextContent(
        'You already reported this template. Our moderation team will review it.',
      );
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('says why a report was refused', async () => {
      signIn('viewer-1');
      respond(404, { error: 'Template not found.' });

      render(<TemplateDetailClient slug="product-reveal" />);
      await openReportForm('other');

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not report this template. Template not found.');
      // The form stays open with the choice, so it can be sent again.
      expect(screen.getByRole('combobox', { name: 'Report reason' })).toHaveValue('other');
    });

    it('sends a signed-out visitor to sign in and back to the template', async () => {
      render(<TemplateDetailClient slug="product-reveal" />);
      await openReportForm('spam');

      expect(mocks.router.push).toHaveBeenCalledWith('/login?returnUrl=%2Ftemplates%2Fproduct-reveal');
      expect(mocks.fetch).not.toHaveBeenCalled();
    });
  });
});
