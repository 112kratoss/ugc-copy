import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  listActiveMediaTemplates: vi.fn(),
  catalogProps: vi.fn(),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => mocks.createServiceClient(),
}));

vi.mock('@/lib/media-template-service', () => ({
  listActiveMediaTemplatesPage: async (client: unknown) => ({
    templates: await mocks.listActiveMediaTemplates(client),
    nextCursor: 'next-page',
  }),
}));

vi.mock('@/components/RouteAuthBoundary', () => ({
  OptionalAuth: ({ children }: { children: ReactNode }) => (
    <div data-testid="optional-auth">{children}</div>
  ),
}));

vi.mock('@/components/templates/TemplateCatalogClient', () => ({
  default: (props: unknown) => {
    mocks.catalogProps(props);
    return <div data-testid="template-catalog" />;
  },
}));

const ACTIVE_TEMPLATE = {
  id: 'template-1',
  slug: 'product-reveal',
  name: 'Product Reveal',
  description: 'Turn one product photo into a reveal video.',
  category: 'Product',
  videoUrl: null,
  thumbnailUrl: 'https://example.com/product-reveal.webp',
  creatorUserId: 'creator-1',
  creator: {
    id: 'creator-1',
    username: 'creator',
    displayName: 'Creator',
    avatarUrl: null,
  },
  inputSlots: [{ key: 'product', kind: 'image', label: 'Product', required: true }],
  outputKind: null,
  status: 'active',
  useCount: 18,
  estimatedTotalCredits: 12,
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:00.000Z',
  authoring: {
    sourceCanvasId: 'private-canvas',
    outputNodeId: 'private-node',
    activeVersionId: 'private-version',
  },
};

describe('TemplatesPage server bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createServiceClient.mockReset();
    mocks.listActiveMediaTemplates.mockReset();
    mocks.catalogProps.mockReset();
  });

  it('server-loads active templates and gives the public catalog hydrated data', async () => {
    const serviceClient = { source: 'service-client' };
    mocks.createServiceClient.mockReturnValue(serviceClient);
    mocks.listActiveMediaTemplates.mockResolvedValue([ACTIVE_TEMPLATE]);
    const { default: TemplatesPage } = await import('@/app/templates/page');

    render(await TemplatesPage());

    expect(screen.getByTestId('optional-auth')).toContainElement(screen.getByTestId('template-catalog'));
    expect(mocks.listActiveMediaTemplates).toHaveBeenCalledWith(serviceClient);
    expect(mocks.catalogProps).toHaveBeenCalledWith({
      initialTemplates: [expect.objectContaining({
        id: 'template-1',
        outputKind: 'video',
      })],
      initialNextCursor: 'next-page',
    });
    expect(mocks.catalogProps.mock.calls[0]?.[0]).not.toHaveProperty(
      'initialTemplates.0.authoring'
    );
  });

  // An empty catalog is a page that says "No templates are live yet": nothing
  // to index until a template is live (SEO audit, 2026-11-13).
  it('keeps an empty catalog out of the index', async () => {
    mocks.createServiceClient.mockReturnValue({ source: 'service-client' });
    mocks.listActiveMediaTemplates.mockResolvedValue([]);
    const { generateMetadata } = await import('@/app/templates/page');

    const metadata = await generateMetadata();

    expect(metadata.robots).toMatchObject({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe('/templates');
  });

  it('indexes the catalog once a template is live', async () => {
    mocks.createServiceClient.mockReturnValue({ source: 'service-client' });
    mocks.listActiveMediaTemplates.mockResolvedValue([ACTIVE_TEMPLATE]);
    const { generateMetadata } = await import('@/app/templates/page');

    expect((await generateMetadata()).robots).toBeUndefined();
  });

  // A failed read says nothing about the catalog, so the page stays indexable.
  it('leaves the catalog indexable when the read fails', async () => {
    mocks.createServiceClient.mockReturnValue({ source: 'service-client' });
    mocks.listActiveMediaTemplates.mockRejectedValue(new Error('database unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { generateMetadata } = await import('@/app/templates/page');

    expect((await generateMetadata()).robots).toBeUndefined();
    consoleError.mockRestore();
  });

  it('falls back to the existing client fetch when the server bootstrap fails', async () => {
    const serverError = new Error('database unavailable');
    mocks.createServiceClient.mockReturnValue({ source: 'service-client' });
    mocks.listActiveMediaTemplates.mockRejectedValue(serverError);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { default: TemplatesPage } = await import('@/app/templates/page');

    render(await TemplatesPage());

    expect(mocks.catalogProps).toHaveBeenCalledWith({
      initialTemplates: undefined,
      initialNextCursor: null,
    });
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to server-render the template catalog:',
      serverError
    );
    consoleError.mockRestore();
  });
});
