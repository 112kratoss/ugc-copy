import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TemplateCatalogClient from '@/app/components/templates/TemplateCatalogClient';
import type { MediaTemplate } from '@/app/components/templates/types';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  listTemplates: vi.fn(),
  listTemplatePage: vi.fn(),
}));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => mocks.useAuth(),
}));

vi.mock('@/app/components/templates/api', () => ({
  listTemplates: (options: unknown) => mocks.listTemplates(options),
  listTemplatePage: (options: unknown) => mocks.listTemplatePage(options),
}));

vi.mock('@/app/components/templates/TemplatePrimitives', () => ({
  TemplatePageShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  TemplateCard: ({
    template,
    mode,
  }: {
    template: MediaTemplate;
    mode: 'public' | 'owner';
  }) => <article data-mode={mode}>{template.name}</article>,
}));

function template(overrides: Partial<MediaTemplate> = {}): MediaTemplate {
  return {
    id: 'template-1',
    slug: 'server-template',
    name: 'Server Template',
    description: 'Already available in the server response.',
    category: 'Product',
    videoUrl: null,
    thumbnailUrl: null,
    creatorUserId: 'creator-1',
    creator: null,
    inputSlots: [{ key: 'image', kind: 'image', label: 'Image', required: true }],
    outputKind: 'video',
    status: 'active',
    useCount: 3,
    estimatedTotalCredits: 5,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('TemplateCatalogClient initial data', () => {
  beforeEach(() => {
    mocks.useAuth.mockReset();
    mocks.listTemplates.mockReset();
    mocks.listTemplatePage.mockReset();
    mocks.useAuth.mockReturnValue({ session: null, isLoading: false });
  });

  it('loads the next bounded catalog page on demand', async () => {
    mocks.listTemplatePage.mockResolvedValue({
      templates: [template({ id: 'template-2', name: 'Second Page' })],
      nextCursor: null,
    });
    render(<TemplateCatalogClient
      initialTemplates={[template()]}
      initialNextCursor="cursor-2"
    />);

    screen.getByRole('button', { name: 'Load more templates' }).click();
    expect(await screen.findByText('Second Page')).toBeInTheDocument();
    expect(mocks.listTemplatePage).toHaveBeenCalledWith({ cursor: 'cursor-2', limit: 48 });
    expect(screen.queryByRole('button', { name: 'Load more templates' })).not.toBeInTheDocument();
  });

  it('renders server-provided public templates immediately without a duplicate API fetch', async () => {
    render(<TemplateCatalogClient initialTemplates={[template()]} />);

    expect(screen.getByText('Server Template')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading templates')).not.toBeInTheDocument();
    await act(async () => Promise.resolve());
    expect(mocks.listTemplates).not.toHaveBeenCalled();
  });

  it('treats a server-provided empty catalog as loaded without refetching', async () => {
    render(<TemplateCatalogClient initialTemplates={[]} />);

    expect(screen.getByText('No templates are live yet')).toBeInTheDocument();
    await act(async () => Promise.resolve());
    expect(mocks.listTemplates).not.toHaveBeenCalled();
  });

  it('uses the public API as a resilience fallback when no bootstrap was provided', async () => {
    mocks.listTemplates.mockResolvedValue([template({ name: 'Client Fallback Template' })]);

    render(<TemplateCatalogClient />);

    expect(screen.getByLabelText('Loading templates')).toBeInTheDocument();
    expect(await screen.findByText('Client Fallback Template')).toBeInTheDocument();
    expect(mocks.listTemplates).toHaveBeenCalledWith({ token: undefined, mine: false });
  });

  it('keeps owner mode authenticated and API-backed even if initial data is passed', async () => {
    mocks.useAuth.mockReturnValue({
      session: { access_token: 'owner-token', user: { id: 'owner-1' } },
      isLoading: false,
    });
    mocks.listTemplates.mockResolvedValue([
      template({ id: 'owned-template', name: 'Owned Template', status: 'draft' }),
    ]);

    render(
      <TemplateCatalogClient
        mode="owner"
        initialTemplates={[template({ name: 'Public Bootstrap Template' })]}
      />
    );

    await waitFor(() => {
      expect(mocks.listTemplates).toHaveBeenCalledWith({ token: 'owner-token', mine: true });
    });
    expect(await screen.findByText('Owned Template')).toBeInTheDocument();
    expect(screen.queryByText('Public Bootstrap Template')).not.toBeInTheDocument();
  });
});
