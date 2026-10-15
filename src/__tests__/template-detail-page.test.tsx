import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaTemplateRow } from '@/lib/media-template-service';

const mocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  loadMediaTemplateRow: vi.fn(),
  getMediaTemplate: vi.fn(),
  getServerAuthState: vi.fn(),
  logBackendError: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: () => mocks.notFound(),
}));

vi.mock('@/lib/media-template-service', () => ({
  loadMediaTemplateRow: (client: unknown, identifier: string) => mocks.loadMediaTemplateRow(client, identifier),
  getMediaTemplate: (...args: unknown[]) => mocks.getMediaTemplate(...args),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ service: true }),
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => mocks.getServerAuthState(),
}));

vi.mock('@/lib/backend-logger', () => ({
  logBackendError: (event: string, fields: unknown) => mocks.logBackendError(event, fields),
}));

vi.mock('@/components/RouteAuthBoundary', () => ({
  OptionalAuth: ({ children }: { children: ReactNode }) => <div data-testid="optional-auth">{children}</div>,
}));

vi.mock('@/components/templates/TemplateDetailClient', () => ({
  default: ({ slug }: { slug: string }) => <div data-testid="template-detail">{slug}</div>,
}));

import TemplateDetailPage, { generateMetadata } from '@/app/templates/[slug]/page';
import TemplateNotFound from '@/app/templates/[slug]/not-found';

function row(overrides: Partial<MediaTemplateRow> = {}): MediaTemplateRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Product Reveal',
    description: 'Turn one product photo into a reveal video.',
    video_url: null,
    thumbnail_url: null,
    category: 'product',
    is_active: true,
    created_at: '2026-07-16T00:00:00.000Z',
    creator_user_id: 'creator-1',
    slug: 'product-reveal',
    source_canvas_id: 'canvas-1',
    input_slots: [],
    output_kind: 'video',
    status: 'active',
    use_count: 3,
    active_version_id: 'version-1',
    draft_output_node_id: null,
    draft_catalog_revision: null,
    updated_at: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

const params = (slug = 'product-reveal') => ({ params: Promise.resolve({ slug }) });

function signIn(userId: string | null) {
  mocks.getServerAuthState.mockResolvedValue(userId
    ? { session: { user: { id: userId } }, credits: 0 }
    : { session: null, credits: null });
}

describe('template detail page (server render)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signIn(null);
    mocks.loadMediaTemplateRow.mockResolvedValue(row());
  });

  it('builds a live template\'s metadata from its row alone, reading no session', async () => {
    const metadata = await generateMetadata(params());

    expect(metadata.title).toBe('Product Reveal');
    expect(metadata.description).toBe('Turn one product photo into a reveal video.');
    expect(metadata.alternates?.canonical).toBe('/templates/product-reveal');
    expect(metadata.robots).toBeUndefined();
    expect(mocks.loadMediaTemplateRow).toHaveBeenCalledWith({ service: true }, 'product-reveal');
    // The full template signs its media and reads its creator and cost.
    expect(mocks.getMediaTemplate).not.toHaveBeenCalled();
    expect(mocks.getServerAuthState).not.toHaveBeenCalled();
  });

  it('draws a live template for anyone', async () => {
    render(await TemplateDetailPage(params()));

    expect(screen.getByTestId('optional-auth')).toContainElement(screen.getByTestId('template-detail'));
    expect(screen.getByTestId('template-detail')).toHaveTextContent('product-reveal');
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it('answers 404 for a template that does not exist', async () => {
    mocks.loadMediaTemplateRow.mockResolvedValue(null);

    await expect(TemplateDetailPage(params('gone'))).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(generateMetadata(params('gone'))).resolves.toEqual({ title: 'Template not found' });
  });

  it.each([
    ['a draft', { status: 'draft', active_version_id: null }],
    ['a disabled template', { status: 'disabled' }],
    ['a template that is switched off', { is_active: false }],
  ])('answers 404 for %s to a visitor and to another signed-in account', async (_label, overrides) => {
    mocks.loadMediaTemplateRow.mockResolvedValue(row(overrides as Partial<MediaTemplateRow>));

    await expect(TemplateDetailPage(params())).rejects.toThrow('NEXT_NOT_FOUND');

    signIn('someone-else');
    await expect(TemplateDetailPage(params())).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(generateMetadata(params())).resolves.toEqual({ title: 'Template not found' });
  });

  it('shows the creator their own draft under its name, never indexed', async () => {
    mocks.loadMediaTemplateRow.mockResolvedValue(row({ status: 'draft', active_version_id: null }));
    signIn('creator-1');

    render(await TemplateDetailPage(params()));
    const metadata = await generateMetadata(params());

    expect(screen.getByTestId('template-detail')).toHaveTextContent('product-reveal');
    expect(metadata.title).toBe('Product Reveal');
    expect(metadata.robots).toEqual(expect.objectContaining({ index: false }));
  });

  it('keeps the page and an indexable title when the read fails, instead of a soft 404', async () => {
    const failure = new Error('database unavailable');
    mocks.loadMediaTemplateRow.mockRejectedValue(failure);

    render(await TemplateDetailPage(params()));
    const metadata = await generateMetadata(params());

    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(screen.getByTestId('template-detail')).toHaveTextContent('product-reveal');
    expect(metadata.title).toBe('Media Template');
    expect(metadata.robots).toBeUndefined();
    expect(mocks.logBackendError).toHaveBeenCalledWith('template_page_read_failed', { error: failure });
  });

  it('says a missing template was not found and leads back to the catalog', () => {
    render(<TemplateNotFound />);

    expect(screen.getByText('Template not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to templates' })).toHaveAttribute('href', '/templates');
  });
});
