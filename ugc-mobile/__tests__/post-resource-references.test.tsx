import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PostResourceItem } from '../lib/types';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  // Android draws the row through gesture handler's scroll view (its double is this one).
  Platform: { OS: 'android' },
  Pressable: ({ children, style, ...props }: MockProps) =>
    React.createElement('pressable', { ...props, style: resolvePressableStyle(style) }, children),
  ScrollView: ({ children, ...props }: MockProps) =>
    React.createElement('scroll-view', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => ({
  AudioLines: (props: MockProps) => React.createElement('audio-lines-icon', props),
  ExternalLink: (props: MockProps) => React.createElement('external-link-icon', props),
  FileText: (props: MockProps) => React.createElement('file-text-icon', props),
  ImageIcon: (props: MockProps) => React.createElement('image-icon', props),
  Play: (props: MockProps) => React.createElement('play-icon', props),
}));

vi.mock('@/components/feed-media-frame', () => ({
  FeedMediaFrame: (props: MockProps) => React.createElement('feed-media-frame', props),
}));

vi.mock('@/components/media-lightbox', () => ({
  MediaLightbox: (props: MockProps) => React.createElement('media-lightbox', props),
}));

vi.mock('@/components/mature-cover', async () => {
  const { createContext, createElement } = await import('react');
  return {
    MatureCover: (props: MockProps) => createElement('mature-cover', props),
    MatureMediaCovered: createContext(false),
  };
});

// The still a clip gives, decided per case; by default the clip gives none.
const stills = vi.hoisted(() => ({
  read: true,
  grab: vi.fn<(url: string, options: { signal: AbortSignal }) => Promise<unknown>>(),
}));
vi.mock('@/lib/video-frame', () => ({
  grabVideoFrame: stills.grab,
  get VIDEO_STILLS_READ() { return stills.read; },
}));

beforeEach(() => {
  stills.read = true;
  stills.grab.mockReset();
  stills.grab.mockResolvedValue(null);
});

import { MatureMediaCovered } from '@/components/mature-cover';
import { PostResourceReferences } from '../components/post-resource-references';
import { createPostResourceFileUrlResolver } from '../lib/api-client';

const referenceImage: PostResourceItem = {
  type: 'reference_image',
  role: 'character_reference',
  sectionId: null,
  title: '@alisa',
  description: 'Character reference',
  textContent: null,
  externalUrl: null,
  storagePath: 'references/alisa.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 120_000,
  workflowSnapshot: null,
  sortOrder: 0,
  isPrimary: true,
  remixUse: 'reference_only',
};

const promptItem: PostResourceItem = {
  ...referenceImage,
  type: 'prompt',
  role: 'primary',
  title: 'Prompt',
  storagePath: null,
  contentType: null,
  textContent: 'Create a portrait',
  remixUse: 'text_template',
};

describe('PostResourceReferences', () => {
  it('renews a preloaded reference URL before opening instead of replaying a stale link', async () => {
    const resolveFileUrl = vi.fn()
      .mockResolvedValueOnce('https://media.test/expired.jpg')
      .mockResolvedValueOnce('https://media.test/renewed.jpg');
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(<PostResourceReferences items={[referenceImage]} onOpenUrl={vi.fn()} resolveFileUrl={resolveFileUrl} />);
    });
    await renderer.act(async () => {
      tree!.root.findByProps({ accessibilityLabel: 'Open reference @alisa' }).props.onPress();
    });
    expect(resolveFileUrl).toHaveBeenCalledTimes(2);
    expect(tree!.root.findByType('media-lightbox' as never).props.items[0].url).toBe('https://media.test/renewed.jpg');
    renderer.act(() => tree?.unmount());
  });

  it('does not open the cached link when renewal is denied', async () => {
    const onError = vi.fn();
    const resolveFileUrl = vi.fn().mockResolvedValueOnce('https://media.test/expired.jpg').mockRejectedValueOnce(new Error('Access unavailable'));
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(<PostResourceReferences items={[referenceImage]} onOpenUrl={vi.fn()} onError={onError} resolveFileUrl={resolveFileUrl} />);
    });
    await renderer.act(async () => {
      tree!.root.findByProps({ accessibilityLabel: 'Open reference @alisa' }).props.onPress();
    });
    expect(onError).toHaveBeenCalledWith('Access unavailable');
    expect(tree!.root.findByType('media-lightbox' as never).props.activeIndex).toBeNull();
    renderer.act(() => tree?.unmount());
  });

  it('renews the next item and does not reopen a lightbox closed during renewal', async () => {
    const videoReference = { ...referenceImage, id: 'video', type: 'reference_video' as const, contentType: 'video/mp4', storagePath: 'references/clip.mp4', sortOrder: 1 };
    let finish: (url: string) => void = () => undefined;
    const resolveFileUrl = vi.fn(async (path: string) => `https://media.test/initial/${path}`);
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(<PostResourceReferences items={[referenceImage, videoReference]} onOpenUrl={vi.fn()} resolveFileUrl={resolveFileUrl} />);
    });
    const lightbox = () => tree!.root.findByType('media-lightbox' as never);
    resolveFileUrl.mockResolvedValueOnce('https://media.test/renewed.jpg');
    await renderer.act(async () => {
      tree!.root.findAllByProps({ accessibilityLabel: 'Open reference @alisa' })[0].props.onPress();
    });
    resolveFileUrl.mockResolvedValueOnce('https://media.test/renewed.mp4');
    await renderer.act(async () => { lightbox().props.onNavigate(1); });
    expect(lightbox().props.activeIndex).toBe(1);
    expect(lightbox().props.items[1].url).toBe('https://media.test/renewed.mp4');
    resolveFileUrl.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const callsBefore = resolveFileUrl.mock.calls.length;
    renderer.act(() => { lightbox().props.onNavigate(0); lightbox().props.onNavigate(0); });
    expect(resolveFileUrl.mock.calls.length).toBe(callsBefore + 1);
    expect(lightbox().props.statusMessage).toBe('Opening reference…');
    renderer.act(() => { lightbox().props.onClose(); });
    await renderer.act(async () => { finish('https://media.test/late.jpg'); });
    expect(lightbox().props.activeIndex).toBeNull();
    expect(lightbox().props.statusMessage).toBeNull();
    renderer.act(() => tree?.unmount());
  });

  it('keeps the selected reference on navigation denial and exposes the failure inside the lightbox', async () => {
    const next = { ...referenceImage, id: 'next', sortOrder: 1, storagePath: 'references/next.jpg' };
    const resolveFileUrl = vi.fn(async (path: string) => `https://media.test/${path}`);
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(<PostResourceReferences items={[referenceImage, next]} onOpenUrl={vi.fn()} resolveFileUrl={resolveFileUrl} />);
    });
    const lightbox = () => tree!.root.findByType('media-lightbox' as never);
    await renderer.act(async () => { tree!.root.findAllByProps({ accessibilityLabel: 'Open reference @alisa' })[0].props.onPress(); });
    resolveFileUrl.mockRejectedValueOnce(new Error('Access denied'));
    await renderer.act(async () => { lightbox().props.onNavigate(1); });
    expect(lightbox().props.activeIndex).toBe(0);
    expect(lightbox().props.errorMessage).toBe('Couldn’t open reference. Try again or close the preview.');
    await renderer.act(async () => { lightbox().props.onNavigate(1); });
    expect(lightbox().props.activeIndex).toBe(1);
    expect(lightbox().props.errorMessage).toBeNull();
    renderer.act(() => tree?.unmount());
  });

  it('preloads and renders an unlocked reference image with contained media', async () => {
    const resolveFileUrl = vi.fn(async () => 'https://cdn.example.com/alisa.jpg');
    let tree: renderer.ReactTestRenderer | undefined;

    await renderer.act(async () => {
      tree = renderer.create(
        <PostResourceReferences
          items={[promptItem, referenceImage]}
          onOpenUrl={vi.fn()}
          resolveFileUrl={resolveFileUrl}
        />
      );
    });

    expect(resolveFileUrl).toHaveBeenCalledWith('references/alisa.jpg');
    expect(tree!.root.findByProps({ children: 'References' })).toBeTruthy();
    expect(tree!.root.findByProps({ children: '@alisa' })).toBeTruthy();

    const preview = tree!.root.find((node) => String(node.type) === 'feed-media-frame');
    expect(preview.props.kind).toBe('image');
    expect(preview.props.url).toBe('https://cdn.example.com/alisa.jpg');
  });

  it('shows a reference image in the app instead of a browser tab', async () => {
    const onOpenUrl = vi.fn(async () => undefined);
    let tree: renderer.ReactTestRenderer | undefined;

    await renderer.act(async () => {
      tree = renderer.create(
        <PostResourceReferences
          items={[referenceImage]}
          onOpenUrl={onOpenUrl}
          resolveFileUrl={async () => 'https://cdn.example.com/alisa.jpg'}
        />
      );
    });

    const lightbox = () => tree!.root.findByType('media-lightbox' as never);
    expect(lightbox().props.activeIndex).toBeNull();

    const reference = tree!.root.findByProps({ accessibilityLabel: 'Open reference @alisa' });
    await renderer.act(async () => {
      await reference.props.onPress();
    });

    expect(onOpenUrl).not.toHaveBeenCalled();
    expect(lightbox().props.activeIndex).toBe(0);
    expect(lightbox().props.items).toEqual([
      expect.objectContaining({
        url: 'https://cdn.example.com/alisa.jpg',
        mediaKind: 'image',
        label: '@alisa',
        caption: 'Character reference',
      }),
    ]);

    await renderer.act(async () => {
      lightbox().props.onClose();
    });
    expect(lightbox().props.activeIndex).toBeNull();
  });

  it('plays a reference video in the app but still hands audio to the browser', async () => {
    const onOpenUrl = vi.fn(async () => undefined);
    const videoReference: PostResourceItem = {
      ...referenceImage,
      id: 'video-reference',
      type: 'reference_video',
      title: 'Camera movement',
      storagePath: 'references/camera.mp4',
      contentType: 'video/mp4',
    };
    const audioReference: PostResourceItem = {
      ...referenceImage,
      id: 'audio-reference',
      type: 'reference_audio',
      title: 'Timing track',
      storagePath: 'references/timing.mp3',
      contentType: 'audio/mpeg',
    };
    let tree: renderer.ReactTestRenderer | undefined;

    await renderer.act(async () => {
      tree = renderer.create(
        <PostResourceReferences
          items={[videoReference, audioReference]}
          onOpenUrl={onOpenUrl}
          resolveFileUrl={async (path) => `https://cdn.example.com/${path}`}
        />
      );
    });

    const lightbox = () => tree!.root.findByType('media-lightbox' as never);
    expect(lightbox().props.items.map((item: { mediaKind: string }) => item.mediaKind)).toEqual(['video']);

    await renderer.act(async () => {
      await tree!.root.findByProps({ accessibilityLabel: 'Open reference Camera movement' }).props.onPress();
    });
    expect(lightbox().props.activeIndex).toBe(0);
    expect(onOpenUrl).not.toHaveBeenCalled();

    await renderer.act(async () => {
      await tree!.root.findByProps({ accessibilityLabel: 'Open reference Timing track' }).props.onPress();
    });
    expect(onOpenUrl).toHaveBeenCalledWith('https://cdn.example.com/references/timing.mp3');
  });

  it('keeps an external link as a link', async () => {
    const onOpenUrl = vi.fn(async () => undefined);
    const linkedImage: PostResourceItem = {
      ...referenceImage,
      id: 'linked',
      title: 'Mood board',
      storagePath: null,
      externalUrl: 'https://example.com/board',
    };
    let tree: renderer.ReactTestRenderer | undefined;

    await renderer.act(async () => {
      tree = renderer.create(
        <PostResourceReferences items={[linkedImage]} onOpenUrl={onOpenUrl} resolveFileUrl={vi.fn()} />
      );
    });

    await renderer.act(async () => {
      await tree!.root.findByProps({ accessibilityLabel: 'Open reference Mood board' }).props.onPress();
    });
    expect(onOpenUrl).toHaveBeenCalledWith('https://example.com/board');
    expect(tree!.root.findByType('media-lightbox' as never).props.items).toEqual([]);
  });

  it('renders an openable clip that gives no still without an inline preview', async () => {
    const sourceVideo: PostResourceItem = {
      ...referenceImage,
      type: 'source_file',
      title: 'Source clip',
      storagePath: 'references/source.mp4',
      contentType: 'video/mp4',
      role: 'before_input',
      remixUse: 'import_source',
    };
    let tree: renderer.ReactTestRenderer | undefined;

    await renderer.act(async () => {
      tree = renderer.create(
        <PostResourceReferences
          items={[sourceVideo]}
          onOpenUrl={vi.fn()}
          resolveFileUrl={async () => 'https://cdn.example.com/source.mp4'}
        />
      );
    });

    expect(tree!.root.findByProps({ children: 'Source clip' })).toBeTruthy();
    expect(tree!.root.findAll((node) => String(node.type) === 'feed-media-frame')).toHaveLength(0);
    expect(tree!.root.findByProps({ children: 'Open video' })).toBeTruthy();
  });

  it('includes explicit video and audio reference item types', async () => {
    const videoReference: PostResourceItem = {
      ...referenceImage,
      id: 'video-reference',
      type: 'reference_video',
      title: 'Camera movement',
      storagePath: 'references/camera.mp4',
      contentType: 'video/mp4',
    };
    const audioReference: PostResourceItem = {
      ...referenceImage,
      id: 'audio-reference',
      type: 'reference_audio',
      title: 'Timing track',
      storagePath: 'references/timing.mp3',
      contentType: 'audio/mpeg',
    };
    let tree: renderer.ReactTestRenderer | undefined;

    await renderer.act(async () => {
      tree = renderer.create(
        <PostResourceReferences
          items={[videoReference, audioReference]}
          onOpenUrl={vi.fn()}
          resolveFileUrl={async (path) => `https://cdn.example.com/${path}`}
        />
      );
    });

    expect(tree!.root.findByProps({ children: 'Camera movement' })).toBeTruthy();
    expect(tree!.root.findByProps({ children: 'Timing track' })).toBeTruthy();
    expect(tree!.root.findByProps({ children: 'Open video' })).toBeTruthy();
    expect(tree!.root.findByProps({ children: 'Open audio' })).toBeTruthy();
  });

  it("signs the previews of every group a bundle renders in one call", async () => {
    // One list per resource group, as PostResourceBundleContent draws them.
    const signMany = vi.fn(async (_postId: string, paths: string[]) => ({
      files: paths.map((path) => ({ storagePath: path, url: `https://signed.test/${path}` })),
    }));
    const signOne = vi.fn(async (_postId: string, path: string) => `https://signed.test/one/${path}`);
    const resolve = createPostResourceFileUrlResolver({ signMany, signOne });
    const resolveFileUrl = (path: string) => resolve('post-1', path, { disposition: 'inline' });
    const secondGroupImage: PostResourceItem = { ...referenceImage, id: 'second', title: '@second', storagePath: 'references/second.jpg' };
    let tree: renderer.ReactTestRenderer | undefined;

    await renderer.act(async () => {
      tree = renderer.create(
        <>
          <PostResourceReferences items={[referenceImage]} onOpenUrl={vi.fn()} resolveFileUrl={resolveFileUrl} />
          <PostResourceReferences items={[secondGroupImage]} onOpenUrl={vi.fn()} resolveFileUrl={resolveFileUrl} />
        </>
      );
    });

    expect(signMany).toHaveBeenCalledTimes(1);
    expect(signMany).toHaveBeenCalledWith('post-1', ['references/alisa.jpg', 'references/second.jpg'], { disposition: 'inline' });
    expect(signOne).not.toHaveBeenCalled();
    expect(tree!.root.findAll((node) => String(node.type) === 'feed-media-frame').map((node) => node.props.url)).toEqual([
      'https://signed.test/references/alisa.jpg',
      'https://signed.test/references/second.jpg',
    ]);
    renderer.act(() => tree?.unmount());
  });

  it('keeps a preview link that arrives while every effect runs again', async () => {
    // A hidden <Activity> shown again runs every effect with its state kept, as
    // Fast Refresh does. The path stays requested, so a link dropped while
    // hidden was never asked for again and the tile kept its spinner.
    let finish: (url: string) => void = () => undefined;
    const resolveFileUrl = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const references = (mode: 'visible' | 'hidden') => (
      <React.Activity mode={mode}>
        <PostResourceReferences items={[referenceImage]} onOpenUrl={vi.fn()} resolveFileUrl={resolveFileUrl} />
      </React.Activity>
    );
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => { tree = renderer.create(references('visible')); });
    await renderer.act(async () => { tree!.update(references('hidden')); });
    await renderer.act(async () => { finish('https://cdn.example.com/alisa.jpg'); });
    await renderer.act(async () => { tree!.update(references('visible')); });

    expect(tree!.root.findAll((node) => String(node.type) === 'feed-media-frame').map((node) => node.props.url))
      .toEqual(['https://cdn.example.com/alisa.jpg']);
    expect(tree!.root.findAll((node) => String(node.type) === 'activity-indicator')).toHaveLength(0);
    expect(resolveFileUrl).toHaveBeenCalledTimes(1);
    renderer.act(() => tree?.unmount());
  });

  describe('a clip’s still', () => {
    const videoReference: PostResourceItem = {
      ...referenceImage,
      id: 'video-reference',
      type: 'reference_video',
      title: 'Video reference 1',
      description: null,
      storagePath: 'references/clip.mp4',
      contentType: 'video/mp4',
    };
    const STILL = { width: 405, height: 720 };
    const byType = (tree: renderer.ReactTestRenderer, type: string) => tree.root.findAll((node) => String(node.type) === type);

    it('draws the still under the play mark, read once from the clip’s link', async () => {
      stills.grab.mockResolvedValueOnce(STILL);
      let tree: renderer.ReactTestRenderer | undefined;
      await renderer.act(async () => {
        tree = renderer.create(
          <PostResourceReferences items={[videoReference]} onOpenUrl={vi.fn()} resolveFileUrl={async (path) => `https://cdn.example.com/${path}`} />
        );
      });

      expect(stills.grab).toHaveBeenCalledTimes(1);
      expect(stills.grab).toHaveBeenCalledWith('https://cdn.example.com/references/clip.mp4', { signal: expect.any(AbortSignal) });
      const [still] = byType(tree!, 'image');
      expect(still?.props).toMatchObject({ source: STILL, contentFit: 'cover', accessible: false });
      expect(byType(tree!, 'play-icon')).toHaveLength(1);
      expect(tree!.root.findByProps({ children: 'Open video' })).toBeTruthy();
      renderer.act(() => tree?.unmount());
    });

    it('keeps the still, with no spinner and no second read, while opening the clip renews its link', async () => {
      stills.grab.mockResolvedValueOnce(STILL);
      let renew: (url: string) => void = () => undefined;
      const resolveFileUrl = vi.fn(async (path: string) => `https://cdn.example.com/${path}`);
      let tree: renderer.ReactTestRenderer | undefined;
      await renderer.act(async () => {
        tree = renderer.create(<PostResourceReferences items={[videoReference]} onOpenUrl={vi.fn()} resolveFileUrl={resolveFileUrl} />);
      });

      resolveFileUrl.mockImplementationOnce(() => new Promise<string>((resolve) => { renew = resolve; }));
      renderer.act(() => {
        void tree!.root.findByProps({ accessibilityLabel: 'Open reference Video reference 1' }).props.onPress();
      });
      expect(byType(tree!, 'activity-indicator')).toHaveLength(0);
      expect(byType(tree!, 'image').map((node) => node.props.source)).toEqual([STILL]);

      await renderer.act(async () => { renew('https://cdn.example.com/renewed/clip.mp4'); });
      expect(tree!.root.findByType('media-lightbox' as never).props.activeIndex).toBe(0);
      expect(byType(tree!, 'image').map((node) => node.props.source)).toEqual([STILL]);
      expect(stills.grab).toHaveBeenCalledTimes(1);
      renderer.act(() => tree?.unmount());
    });

    it('keeps the plain play mark when the clip gives no still, until opening it renews the link', async () => {
      const resolveFileUrl = vi.fn(async (path: string) => `https://cdn.example.com/${path}`);
      let tree: renderer.ReactTestRenderer | undefined;
      await renderer.act(async () => {
        tree = renderer.create(<PostResourceReferences items={[videoReference]} onOpenUrl={vi.fn()} resolveFileUrl={resolveFileUrl} />);
      });
      expect(byType(tree!, 'image')).toHaveLength(0);
      expect(byType(tree!, 'play-icon')).toHaveLength(1);
      // Re-rendering asks nothing again.
      await renderer.act(async () => {
        tree!.update(<PostResourceReferences items={[videoReference]} onOpenUrl={vi.fn()} resolveFileUrl={resolveFileUrl} />);
      });
      expect(stills.grab).toHaveBeenCalledTimes(1);

      // The first link can have run out, or its read missed the deadline:
      // opening the clip renews the link, and the still is read from that.
      stills.grab.mockResolvedValueOnce(STILL);
      resolveFileUrl.mockResolvedValueOnce('https://cdn.example.com/renewed/clip.mp4');
      await renderer.act(async () => {
        await tree!.root.findByProps({ accessibilityLabel: 'Open reference Video reference 1' }).props.onPress();
      });

      expect(stills.grab).toHaveBeenCalledTimes(2);
      expect(stills.grab).toHaveBeenLastCalledWith('https://cdn.example.com/renewed/clip.mp4', { signal: expect.any(AbortSignal) });
      expect(byType(tree!, 'image').map((node) => node.props.source)).toEqual([STILL]);
      renderer.act(() => tree?.unmount());
    });

    // The reel mounts a slide's Details page beside its playing clip.
    it('reads no still while the page is off screen, calls off one under way when it leaves, and keeps one read', async () => {
      const signals: AbortSignal[] = [];
      stills.grab
        .mockImplementationOnce((_url, { signal }) => {
          signals.push(signal);
          return new Promise(() => undefined);
        })
        .mockImplementationOnce((_url, { signal }) => {
          signals.push(signal);
          return Promise.resolve(STILL);
        });
      const references = (readStills: boolean) => (
        <PostResourceReferences items={[videoReference]} onOpenUrl={vi.fn()} readStills={readStills} resolveFileUrl={async (path) => `https://cdn.example.com/${path}`} />
      );
      let tree: renderer.ReactTestRenderer | undefined;
      await renderer.act(async () => { tree = renderer.create(references(false)); });
      expect(stills.grab).not.toHaveBeenCalled();

      await renderer.act(async () => { tree!.update(references(true)); });
      expect(signals).toHaveLength(1);
      await renderer.act(async () => { tree!.update(references(false)); });
      expect(signals[0].aborted).toBe(true);

      await renderer.act(async () => { tree!.update(references(true)); });
      expect(signals).toHaveLength(2);
      expect(byType(tree!, 'image').map((node) => node.props.source)).toEqual([STILL]);
      await renderer.act(async () => { tree!.update(references(false)); });
      expect(byType(tree!, 'image').map((node) => node.props.source)).toEqual([STILL]);
      expect(stills.grab).toHaveBeenCalledTimes(2);
      renderer.act(() => tree?.unmount());
    });

    it('reads no still where the platform does not read them, and keeps the play mark', async () => {
      stills.read = false;
      let tree: renderer.ReactTestRenderer | undefined;
      await renderer.act(async () => {
        tree = renderer.create(
          <PostResourceReferences items={[videoReference]} onOpenUrl={vi.fn()} resolveFileUrl={async (path) => `https://cdn.example.com/${path}`} />
        );
      });

      expect(stills.grab).not.toHaveBeenCalled();
      expect(byType(tree!, 'image')).toHaveLength(0);
      expect(byType(tree!, 'play-icon')).toHaveLength(1);
      renderer.act(() => tree?.unmount());
    });

    it('calls off a still being read when the row is hidden or goes, and reads it again when the row comes back', async () => {
      // A hidden <Activity> runs every effect's cleanup with its state kept, as
      // Fast Refresh does; shown again, every effect runs again.
      const signals: AbortSignal[] = [];
      const answers: ((still: unknown) => void)[] = [];
      stills.grab.mockImplementation((_url, { signal }) => {
        signals.push(signal);
        return new Promise((resolve) => { answers.push(resolve); });
      });
      const references = (mode: 'visible' | 'hidden') => (
        <React.Activity mode={mode}>
          <PostResourceReferences items={[videoReference]} onOpenUrl={vi.fn()} resolveFileUrl={async (path) => `https://cdn.example.com/${path}`} />
        </React.Activity>
      );
      let tree: renderer.ReactTestRenderer | undefined;
      await renderer.act(async () => { tree = renderer.create(references('visible')); });
      expect(signals).toHaveLength(1);

      await renderer.act(async () => { tree!.update(references('hidden')); });
      expect(signals[0].aborted).toBe(true);
      // The answer that lands after the call-off is not drawn.
      await renderer.act(async () => { answers[0](STILL); });

      await renderer.act(async () => { tree!.update(references('visible')); });
      expect(signals).toHaveLength(2);
      expect(byType(tree!, 'image')).toHaveLength(0);

      const again = { width: 406, height: 720 };
      await renderer.act(async () => { answers[1](again); });
      expect(byType(tree!, 'image').map((node) => node.props.source)).toEqual([again]);
      expect(signals).toHaveLength(2);

      renderer.act(() => tree?.unmount());
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    });

    it('lets a read under way go when the row unmounts', async () => {
      let signal: AbortSignal | undefined;
      stills.grab.mockImplementationOnce((_url, options) => {
        signal = options.signal;
        return new Promise(() => undefined);
      });
      let tree: renderer.ReactTestRenderer | undefined;
      await renderer.act(async () => {
        tree = renderer.create(
          <PostResourceReferences items={[videoReference]} onOpenUrl={vi.fn()} resolveFileUrl={async (path) => `https://cdn.example.com/${path}`} />
        );
      });

      expect(signal?.aborted).toBe(false);
      renderer.act(() => tree?.unmount());
      expect(signal?.aborted).toBe(true);
    });
  });

  it('renders nothing when structured reference items are unavailable', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <PostResourceReferences
          items={undefined}
          onOpenUrl={vi.fn()}
          resolveFileUrl={vi.fn()}
        />
      );
    });

    expect(tree!.toJSON()).toBeNull();
  });
});

describe('PostResourceReferences in a mature purchase', () => {
  const videoReference: PostResourceItem = {
    ...referenceImage,
    id: 'video-reference',
    type: 'reference_video',
    title: 'Camera movement',
    storagePath: 'references/camera.mp4',
    contentType: 'video/mp4',
    sortOrder: 1,
  };
  const byType = (tree: renderer.ReactTestRenderer, type: string) => tree.root.findAll((node) => String(node.type) === type);

  it('draws the plate over a reference picture, and signs nothing under it, until the screen shows it', async () => {
    const resolveFileUrl = vi.fn(async (path: string) => `https://cdn.example.com/${path}`);
    const references = (coverMedia: boolean) => (
      <PostResourceReferences coverMedia={coverMedia} items={[referenceImage, videoReference]} onOpenUrl={vi.fn()} resolveFileUrl={resolveFileUrl} />
    );
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(references(true));
    });

    expect(byType(tree!, 'feed-media-frame')).toHaveLength(0);
    const [plate] = byType(tree!, 'mature-cover');
    // The screen's own Show lifts it, so the plate offers none.
    expect(plate?.props).toEqual({ variant: 'tile' });
    expect(byType(tree!, 'mature-cover')).toHaveLength(1);
    expect(resolveFileUrl).not.toHaveBeenCalled();
    expect(tree!.root.findByType('media-lightbox' as never).props.items).toEqual([]);

    await renderer.act(async () => {
      tree!.update(references(false));
    });

    expect(byType(tree!, 'mature-cover')).toHaveLength(0);
    expect(byType(tree!, 'feed-media-frame').map((node) => node.props.url)).toEqual(['https://cdn.example.com/references/alisa.jpg']);
    expect(resolveFileUrl).toHaveBeenCalledWith('references/alisa.jpg');
    renderer.act(() => tree?.unmount());
  });

  it('opens a covered picture or clip in the browser, never on the in-app stage', async () => {
    const onOpenUrl = vi.fn(async () => undefined);
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(
        <PostResourceReferences
          coverMedia
          items={[referenceImage, videoReference]}
          onOpenUrl={onOpenUrl}
          resolveFileUrl={async (path) => `https://cdn.example.com/${path}`}
        />
      );
    });

    const picture = tree!.root.findByProps({ accessibilityLabel: 'Open reference @alisa' });
    expect(picture.props.accessibilityHint).toBe('Mature content. Opens in your browser.');
    await renderer.act(async () => { await picture.props.onPress(); });
    await renderer.act(async () => {
      await tree!.root.findByProps({ accessibilityLabel: 'Open reference Camera movement' }).props.onPress();
    });

    expect(onOpenUrl.mock.calls).toEqual([
      ['https://cdn.example.com/references/alisa.jpg'],
      ['https://cdn.example.com/references/camera.mp4'],
    ]);
    expect(tree!.root.findByType('media-lightbox' as never).props.activeIndex).toBeNull();
    // Under the plate the clip reads no still, so it keeps its own icon and label.
    expect(tree!.root.findByProps({ children: 'Open video' })).toBeTruthy();
    expect(byType(tree!, 'mature-cover')).toHaveLength(1);
    // Opening it in the browser signed a link; no still is read from it.
    expect(stills.grab).not.toHaveBeenCalled();
  });

  it('reads no still under the plate, and draws none when the plate comes back', async () => {
    const still = { width: 405, height: 720 };
    stills.grab.mockResolvedValueOnce(still);
    const references = (coverMedia: boolean) => (
      <PostResourceReferences coverMedia={coverMedia} items={[videoReference]} onOpenUrl={vi.fn()} resolveFileUrl={async (path) => `https://cdn.example.com/${path}`} />
    );
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => { tree = renderer.create(references(true)); });
    expect(stills.grab).not.toHaveBeenCalled();

    await renderer.act(async () => { tree!.update(references(false)); });
    expect(stills.grab).toHaveBeenCalledTimes(1);
    expect(byType(tree!, 'image').map((node) => node.props.source)).toEqual([still]);

    await renderer.act(async () => { tree!.update(references(true)); });
    expect(byType(tree!, 'image')).toHaveLength(0);
    expect(byType(tree!, 'play-icon')).toHaveLength(1);
    expect(stills.grab).toHaveBeenCalledTimes(1);
    renderer.act(() => tree?.unmount());
  });

  it('calls off a still being read when the plate comes back, and reads it again when it lifts', async () => {
    const signals: AbortSignal[] = [];
    const still = { width: 405, height: 720 };
    stills.grab
      .mockImplementationOnce((_url, { signal }) => {
        signals.push(signal);
        return new Promise(() => undefined);
      })
      .mockImplementationOnce((_url, { signal }) => {
        signals.push(signal);
        return Promise.resolve(still);
      });
    const references = (coverMedia: boolean) => (
      <PostResourceReferences coverMedia={coverMedia} items={[videoReference]} onOpenUrl={vi.fn()} resolveFileUrl={async (path) => `https://cdn.example.com/${path}`} />
    );
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => { tree = renderer.create(references(false)); });
    expect(signals).toHaveLength(1);

    await renderer.act(async () => { tree!.update(references(true)); });
    expect(signals[0].aborted).toBe(true);

    await renderer.act(async () => { tree!.update(references(false)); });
    expect(signals).toHaveLength(2);
    expect(byType(tree!, 'image').map((node) => node.props.source)).toEqual([still]);
    renderer.act(() => tree?.unmount());
  });

  it('keeps the plate, and then the picture, when every effect runs again', async () => {
    // A hidden <Activity> shown again runs every effect of its subtree with its
    // state kept, as Fast Refresh does after an edit.
    const resolveFileUrl = vi.fn(async () => 'https://cdn.example.com/alisa.jpg');
    const references = (coverMedia: boolean, mode: 'visible' | 'hidden' = 'visible') => (
      <React.Activity mode={mode}>
        <PostResourceReferences coverMedia={coverMedia} items={[referenceImage]} onOpenUrl={vi.fn()} resolveFileUrl={resolveFileUrl} />
      </React.Activity>
    );
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => { tree = renderer.create(references(true)); });
    await renderer.act(async () => { tree!.update(references(true, 'hidden')); });
    await renderer.act(async () => { tree!.update(references(true)); });

    expect(byType(tree!, 'mature-cover')).toHaveLength(1);
    expect(resolveFileUrl).not.toHaveBeenCalled();

    await renderer.act(async () => { tree!.update(references(false)); });
    await renderer.act(async () => { tree!.update(references(false, 'hidden')); });
    await renderer.act(async () => { tree!.update(references(false)); });

    expect(byType(tree!, 'feed-media-frame').map((node) => node.props.url)).toEqual(['https://cdn.example.com/alisa.jpg']);
    expect(resolveFileUrl).toHaveBeenCalledTimes(1);
    renderer.act(() => tree?.unmount());
  });

  it('takes the cover from the screen when the prop is left out', async () => {
    const resolveFileUrl = vi.fn(async () => 'https://cdn.example.com/alisa.jpg');
    const references = (covered: boolean) => (
      <MatureMediaCovered.Provider value={covered}>
        <PostResourceReferences items={[referenceImage]} onOpenUrl={vi.fn()} resolveFileUrl={resolveFileUrl} />
      </MatureMediaCovered.Provider>
    );
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(references(true));
    });

    expect(byType(tree!, 'mature-cover')).toHaveLength(1);
    expect(tree!.root.findByProps({ accessibilityLabel: 'Open reference @alisa' }).props.accessibilityHint)
      .toBe('Mature content. Opens in your browser.');
    expect(resolveFileUrl).not.toHaveBeenCalled();

    await renderer.act(async () => {
      tree!.update(references(false));
    });

    expect(byType(tree!, 'mature-cover')).toHaveLength(0);
    expect(byType(tree!, 'feed-media-frame').map((node) => node.props.url)).toEqual(['https://cdn.example.com/alisa.jpg']);
    expect(tree!.root.findByProps({ accessibilityLabel: 'Open reference @alisa' }).props.accessibilityHint).toBeUndefined();
    renderer.act(() => tree?.unmount());
  });
});
