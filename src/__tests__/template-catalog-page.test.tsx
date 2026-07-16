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
  listActiveMediaTemplates: (client: unknown) => mocks.listActiveMediaTemplates(client),
}));

vi.mock('@/app/components/RouteAuthBoundary', () => ({
  OptionalAuth: ({ children }: { children: ReactNode }) => (
    <div data-testid="optional-auth">{children}</div>
  ),
}));

vi.mock('@/app/components/templates/TemplateCatalogClient', () => ({
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
    });
    expect(mocks.catalogProps.mock.calls[0]?.[0]).not.toHaveProperty(
      'initialTemplates.0.authoring'
    );
  });

  it('falls back to the existing client fetch when the server bootstrap fails', async () => {
    const serverError = new Error('database unavailable');
    mocks.createServiceClient.mockReturnValue({ source: 'service-client' });
    mocks.listActiveMediaTemplates.mockRejectedValue(serverError);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { default: TemplatesPage } = await import('@/app/templates/page');

    render(await TemplatesPage());

    expect(mocks.catalogProps).toHaveBeenCalledWith({ initialTemplates: undefined });
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to server-render the template catalog:',
      serverError
    );
    consoleError.mockRestore();
  });
});
