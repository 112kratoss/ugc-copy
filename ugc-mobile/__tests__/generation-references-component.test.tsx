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
  // Android draws the rows through gesture handler's scroll view (its double is the one above).
  Platform: { OS: 'android' },
}));
vi.mock('lucide-react-native', () => ({
  FileText: (p: Props) => React.createElement('file-icon', p),
  ImageIcon: () => null,
  Play: (p: Props) => React.createElement('play-icon', p),
}));
vi.mock('@/components/feed-media-frame', () => ({ FeedMediaFrame: (p: Props) => React.createElement('media-frame', p) }));
vi.mock('@/components/media-lightbox', () => ({ MediaLightbox: (p: Props) => React.createElement('lightbox', p) }));
vi.mock('@/components/ui', () => ({ SecondaryButton: (p: Props) => React.createElement('button', p) }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: state.user, api: { getGenerationDetails: state.getGenerationDetails } }) }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (options: unknown) => {
  state.queryOptions(options);
  return { data: state.data, isError: state.isError, refetch: state.refetch };
} }));
// The still a clip's link gives, decided per case; by default none.
const stills = vi.hoisted(() => ({
  grab: vi.fn<(url: string, options: { signal: AbortSignal }) => Promise<unknown>>(),
}));
vi.mock('@/lib/video-frame', () => ({ grabVideoFrame: stills.grab, VIDEO_STILLS_READ: true }));

import { GenerationOutputs, GenerationReferences } from '@/components/generation-references';
import { resetVideoStillsForTests } from '@/lib/use-video-stills';

beforeEach(() => {
  stills.grab.mockReset();
  stills.grab.mockResolvedValue(null);
  resetVideoStillsForTests();
});

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

  describe('a video input', () => {
    function withClip(url: string | null, storagePath: string | null = 'inputs/owner-1/clip.mp4'): GenerationListItem {
      return { ...generation(null), input_media: [{ id: 'clip-1', mediaType: 'video', role: 'motion_reference_video', storagePath, url }] };
    }
    const images = (tree: renderer.ReactTestRenderer) => tree.root.findAllByType('image' as never);

    it('draws its still under the play mark, read once from its link', async () => {
      const STILL = { width: 405, height: 720 };
      stills.grab.mockResolvedValueOnce(STILL);
      state.data = withClip('https://signed.test/clip.mp4');
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(<GenerationReferences generationId="gen-1" />); });

      expect(stills.grab).toHaveBeenCalledTimes(1);
      expect(stills.grab).toHaveBeenCalledWith('https://signed.test/clip.mp4', { signal: expect.any(AbortSignal) });
      expect(images(tree).map((node) => node.props.source)).toEqual([STILL]);
      expect(tree.root.findAllByType('play-icon' as never)).toHaveLength(1);
      expect(tree.root.findAllByType('file-icon' as never)).toHaveLength(0);
    });

    it('reads as a clip with no still, and is read again from the link that opening it renews', async () => {
      state.data = withClip('https://signed.test/clip.mp4');
      const fresh = withClip('https://signed.test/fresh/clip.mp4');
      state.refetch.mockImplementation(async () => {
        state.data = fresh;
        return { data: fresh };
      });
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(<GenerationReferences generationId="gen-1" />); });
      // A play mark, where it was a file's icon.
      expect(tree.root.findAllByType('play-icon' as never)).toHaveLength(1);
      expect(tree.root.findAllByType('file-icon' as never)).toHaveLength(0);
      expect(images(tree)).toHaveLength(0);

      const STILL = { width: 720, height: 405 };
      stills.grab.mockResolvedValueOnce(STILL);
      await renderer.act(async () => { tree.root.findByType('pressable' as never).props.onPress(); });
      await renderer.act(async () => { tree.update(<GenerationReferences generationId="gen-1" />); });
      expect(stills.grab).toHaveBeenCalledTimes(2);
      expect(stills.grab).toHaveBeenLastCalledWith('https://signed.test/fresh/clip.mp4', { signal: expect.any(AbortSignal) });
      expect(images(tree).map((node) => node.props.source)).toEqual([STILL]);
    });

    it('keeps a still by its file, which the recipe’s row reads under the same storage path', async () => {
      const STILL = { width: 405, height: 720 };
      stills.grab.mockResolvedValueOnce(STILL);
      state.data = withClip('https://signed.test/clip.mp4');
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(<GenerationReferences generationId="gen-1" />); });
      renderer.act(() => tree.unmount());

      // Another visit, with a newly signed link: drawn at once, and not read again.
      state.data = withClip('https://signed.test/again/clip.mp4');
      await renderer.act(async () => { tree = renderer.create(<GenerationReferences generationId="gen-1" />); });
      expect(images(tree).map((node) => node.props.source)).toEqual([STILL]);
      expect(stills.grab).toHaveBeenCalledTimes(1);
    });
  });

  it('hides cached owner data when signed out', () => {
    state.data = generation('https://signed.test/private');
    state.user = null;
    expect(render().toJSON()).toBeNull();
    expect(state.queryOptions.mock.calls[0][0].enabled).toBe(false);
  });
});

/**
 * A run of several files: the library sends the first only, and the details
 * slide lists every one from the full record (audit 01-2).
 */
describe('GenerationOutputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = { id: 'owner-1' };
    state.data = undefined;
    state.isError = false;
    state.refetch.mockReset();
  });

  function run(kind: 'image' | 'video', overrides: Partial<GenerationListItem> = {}): GenerationListItem {
    const extension = kind === 'video' ? 'mp4' : 'png';
    return { id: 'gen-1', model: 'model', category: kind, status: 'succeeded', created_at: '2026-10-14',
      output_url: `https://signed.test/out-0.${extension}`,
      output_urls: [0, 1, 2].map((index) => `https://signed.test/out-${index}.${extension}`),
      output_count: 3, preview_url: 'https://signed.test/out-0.poster.webp', input_media: [], ...overrides };
  }
  function renderOutputs(count = 3) {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<GenerationOutputs generationId="gen-1" count={count} />); });
    return tree;
  }
  const cards = (tree: renderer.ReactTestRenderer) => tree.root.findAllByType('pressable' as never);
  const frames = (tree: renderer.ReactTestRenderer) => tree.root.findAllByType('media-frame' as never);
  const lightbox = (tree: renderer.ReactTestRenderer) => tree.root.findByType('lightbox' as never);
  const texts = (tree: renderer.ReactTestRenderer) => tree.root.findAllByType('text' as never).map((node) => node.props.children);

  it('reads the record the references read', () => {
    renderOutputs();
    expect(state.queryOptions.mock.calls[0][0].queryKey).toEqual(['owner-generation-details', 'owner-1', 'gen-1']);
  });

  it('holds a place for each output while the record loads', () => {
    const tree = renderOutputs();
    expect(cards(tree).map((card) => [card.props.accessibilityLabel, card.props.disabled])).toEqual([
      ['Output 1 of 3, loading', true], ['Output 2 of 3, loading', true], ['Output 3 of 3, loading', true],
    ]);
  });

  it('lists every output and opens the lightbox at the one tapped, with its own file', () => {
    const record = run('image');
    state.data = record;
    const tree = renderOutputs();
    expect(cards(tree).map((card) => card.props.accessibilityLabel))
      .toEqual(['Open output 1 of 3', 'Open output 2 of 3', 'Open output 3 of 3']);
    // The first draws its poster; the others have none and draw themselves.
    expect(frames(tree).map((frame) => frame.props.url)).toEqual([
      'https://signed.test/out-0.poster.webp', 'https://signed.test/out-1.png', 'https://signed.test/out-2.png',
    ]);
    expect(texts(tree)).toContain('Main output');

    renderer.act(() => cards(tree)[2].props.onPress());
    expect(lightbox(tree).props.activeIndex).toBe(2);
    expect(lightbox(tree).props.items.map((item: { url: string }) => item.url)).toEqual(record.output_urls);
    expect(lightbox(tree).props.items[2]).toMatchObject({ id: 'gen-1:output:2', url: 'https://signed.test/out-2.png',
      mediaKind: 'image', label: 'Output 3' });
    renderer.act(() => lightbox(tree).props.onNavigate(0));
    expect(lightbox(tree).props.activeIndex).toBe(0);
    renderer.act(() => lightbox(tree).props.onClose());
    expect(lightbox(tree).props.activeIndex).toBeNull();
  });

  it('draws a video by its poster and a play mark, and never hands its file to the image view', () => {
    state.data = run('video');
    const tree = renderOutputs();
    expect(frames(tree).map((frame) => [frame.props.kind, frame.props.url]))
      .toEqual([['image', 'https://signed.test/out-0.poster.webp']]);
    expect(tree.root.findAllByType('play-icon' as never)).toHaveLength(3);

    renderer.act(() => cards(tree)[1].props.onPress());
    expect(lightbox(tree).props.items[1]).toMatchObject({ url: 'https://signed.test/out-1.mp4', mediaKind: 'video' });
  });

  it('draws a video output that has no poster by a still read from its file, under the play mark', async () => {
    stills.grab.mockImplementation(async (url) => ({ from: url }));
    state.data = run('video');
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => { tree = renderer.create(<GenerationOutputs generationId="gen-1" count={3} />); });

    // The primary output has its poster; the other two are read, each once.
    expect(stills.grab.mock.calls.map(([url]) => url)).toEqual(['https://signed.test/out-1.mp4', 'https://signed.test/out-2.mp4']);
    expect(frames(tree).map((frame) => frame.props.url)).toEqual(['https://signed.test/out-0.poster.webp']);
    expect(tree.root.findAllByType('image' as never).map((node) => node.props.source)).toEqual([
      { from: 'https://signed.test/out-1.mp4' }, { from: 'https://signed.test/out-2.mp4' },
    ]);
    expect(tree.root.findAllByType('play-icon' as never)).toHaveLength(3);
  });

  it('reads no still for a run of pictures', async () => {
    state.data = run('image');
    await renderer.act(async () => { renderer.create(<GenerationOutputs generationId="gen-1" count={3} />); });
    expect(stills.grab).not.toHaveBeenCalled();
  });

  it('gives the poster to the primary output where an older run listed it later', () => {
    state.data = run('video', {
      output_url: 'https://signed.test/out-2.mp4',
      media: { id: 'gen-1', kind: 'video', url: 'https://signed.test/out-2.mp4', previewUrl: 'https://signed.test/out-2.poster.webp' } as GenerationListItem['media'],
      preview_url: 'https://signed.test/out-2.poster.webp',
    });
    const tree = renderOutputs();
    const withPoster = cards(tree).filter((card) => card.findAllByType('media-frame' as never).length > 0);
    expect(withPoster.map((card) => card.props.accessibilityLabel)).toEqual(['Open output 3 of 3']);
  });

  it('renews an output from a fresh read when the lightbox retries it', async () => {
    state.data = run('image');
    state.refetch.mockResolvedValue({ data: run('image', {
      output_urls: ['https://signed.test/new-0.png', 'https://signed.test/new-1.png', 'https://signed.test/new-2.png'],
    }) });
    const tree = renderOutputs();
    renderer.act(() => cards(tree)[1].props.onPress());
    await expect(lightbox(tree).props.items[1].resolveRetryUrl()).resolves.toBe('https://signed.test/new-1.png');
    expect(state.refetch).toHaveBeenCalledWith({ throwOnError: true });
    state.refetch.mockResolvedValue({ data: run('image', { output_urls: ['https://signed.test/new-0.png'] }) });
    await expect(lightbox(tree).props.items[1].resolveRetryUrl()).rejects.toThrow('This output is unavailable.');
  });

  it('marks a picture that failed, and loads it again when it is opened', () => {
    state.data = run('image');
    const tree = renderOutputs();
    renderer.act(() => frames(tree)[1].props.onImageError());
    expect(frames(tree)).toHaveLength(2);
    expect(texts(tree)).toContain('Unavailable · Tap to retry');
    renderer.act(() => cards(tree)[1].props.onPress());
    expect(frames(tree)).toHaveLength(3);
  });

  it('offers a retry when the record cannot be read', () => {
    state.isError = true;
    const tree = renderOutputs();
    const retry = tree.root.findByType('button' as never);
    expect(retry.props.label).toBe('Retry outputs');
    renderer.act(() => retry.props.onPress());
    expect(state.refetch).toHaveBeenCalled();
    expect(cards(tree)).toHaveLength(0);
  });

  it('lists nothing for a single file, for sound, or once signed out', () => {
    state.data = run('image', { output_urls: ['https://signed.test/out-0.png'] });
    expect(renderOutputs().toJSON()).toBeNull();
    state.data = { ...run('image'), category: 'audio' };
    expect(renderOutputs().toJSON()).toBeNull();
    state.data = run('image');
    state.user = null;
    expect(renderOutputs().toJSON()).toBeNull();
  });
});
