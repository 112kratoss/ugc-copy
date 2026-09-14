import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationListItem } from '@/lib/types';

const state = vi.hoisted(() => ({
  user: { id: 'owner-1' } as { id: string } | null,
  getGenerationDetails: vi.fn(),
  queryOptions: vi.fn(),
  data: undefined as GenerationListItem | undefined,
  isError: false,
  refetch: vi.fn(),
}));
type Props = { children?: React.ReactNode } & Record<string, unknown>;
vi.mock('react-native', () => ({
  ActivityIndicator: (p: Props) => React.createElement('spinner', p),
  View: (p: Props) => React.createElement('view', p),
  Text: (p: Props) => React.createElement('text', p),
  ScrollView: (p: Props) => React.createElement('scroll-view', p),
  Pressable: (p: Props) => React.createElement('pressable', p),
  Linking: { openURL: vi.fn() },
}));
vi.mock('lucide-react-native', () => ({ FileText: () => null, ImageIcon: () => null }));
vi.mock('@/components/feed-media-frame', () => ({ FeedMediaFrame: (p: Props) => React.createElement('media-frame', p) }));
vi.mock('@/components/media-lightbox', () => ({ MediaLightbox: (p: Props) => React.createElement('lightbox', p) }));
vi.mock('@/components/ui', () => ({ SecondaryButton: (p: Props) => React.createElement('button', p) }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: state.user, api: { getGenerationDetails: state.getGenerationDetails } }) }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (options: unknown) => {
  state.queryOptions(options);
  return { data: state.data, isError: state.isError, refetch: state.refetch };
} }));

import { GenerationReferences } from '@/components/generation-references';

function generation(url: string | null): GenerationListItem {
  return { id: 'gen-1', model: 'nano-banana-2', category: 'image', status: 'succeeded',
    created_at: '2026-09-15', output_url: null,
    input_media: [{ id: 'ref-1', mediaType: 'image', metadata: { handle: '@alisa' }, url }] };
}
function render() {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => { tree = renderer.create(<GenerationReferences generationId="gen-1" />); });
  return tree;
}

describe('GenerationReferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = { id: 'owner-1' };
    state.data = undefined;
    state.isError = false;
    state.refetch.mockReset();
  });

  it('scopes the full-detail read to the signed-in owner and selected generation', async () => {
    render();
    const options = state.queryOptions.mock.calls[0][0];
    expect(options.queryKey).toEqual(['owner-generation-details', 'owner-1', 'gen-1']);
    state.getGenerationDetails.mockResolvedValue(generation('https://signed.test/image'));
    await options.queryFn();
    expect(state.getGenerationDetails).toHaveBeenCalledWith('gen-1');
    state.getGenerationDetails.mockResolvedValue(null);
    await expect(options.queryFn()).rejects.toThrow('no longer available');
  });

  it('shows loading, retries failures, and hides an empty reference section', () => {
    const tree = render();
    expect(tree.root.findAllByType('spinner' as never)).toHaveLength(1);
    state.isError = true;
    renderer.act(() => tree.update(<GenerationReferences generationId="gen-1" />));
    const retry = tree.root.findByType('button' as never);
    expect(retry.props.label).toBe('Retry references');
    renderer.act(() => retry.props.onPress());
    expect(state.refetch).toHaveBeenCalled();
    state.data = { ...generation(null), input_media: [] };
    state.isError = false;
    renderer.act(() => tree.update(<GenerationReferences generationId="gen-1" />));
    expect(tree.toJSON()).toBeNull();
  });

  it('renews a reference URL before opening the in-app lightbox', async () => {
    state.data = generation('https://signed.test/old');
    state.refetch.mockResolvedValue({ data: generation('https://signed.test/fresh') });
    const tree = render();
    expect(tree.root.findByType('media-frame' as never).props.url).toBe('https://signed.test/old');
    const open = tree.root.findByType('pressable' as never);
    expect(open.props.accessibilityLabel).toBe('Open reference @alisa');
    await renderer.act(async () => { open.props.onPress(); });
    expect(state.refetch).toHaveBeenCalledWith({ throwOnError: true });
    expect(tree.root.findByType('lightbox' as never).props).toMatchObject({ activeIndex: 0,
      items: [{ id: 'ref-1', label: '@alisa', mediaKind: 'image', url: 'https://signed.test/fresh' }] });
  });

  it('keeps missing files visible and reports an explicit open failure', async () => {
    state.data = generation(null);
    state.refetch.mockResolvedValue({ data: generation(null) });
    const tree = render();
    await renderer.act(async () => { tree.root.findByType('pressable' as never).props.onPress(); });
    expect(tree.root.findAllByType('text' as never).map((node) => node.props.children)).toContain('This reference file is unavailable.');
    expect(tree.root.findByType('lightbox' as never).props.activeIndex).toBeNull();
  });

  it('retries a failed thumbnail even when the refreshed URL is unchanged', async () => {
    state.data = generation('https://signed.test/image');
    state.refetch.mockResolvedValue({ data: state.data });
    const tree = render();
    renderer.act(() => tree.root.findByType('media-frame' as never).props.onImageError());
    expect(tree.root.findAllByType('media-frame' as never)).toHaveLength(0);
    await renderer.act(async () => { tree.root.findByType('pressable' as never).props.onPress(); });
    expect(tree.root.findByType('media-frame' as never).props.url).toBe('https://signed.test/image');
  });

  it('hides cached owner data when signed out', () => {
    state.data = generation('https://signed.test/private');
    state.user = null;
    expect(render().toJSON()).toBeNull();
    expect(state.queryOptions.mock.calls[0][0].enabled).toBe(false);
  });
});
