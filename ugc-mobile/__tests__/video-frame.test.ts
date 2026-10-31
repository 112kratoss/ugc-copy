import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Payload = Record<string, unknown>;

/** What the module asked of one player, and the native answers a case decides. */
type FakePlayer = {
  source: { uri: string };
  muted: boolean;
  audioMixingMode?: string;
  bufferOptions: unknown;
  played: boolean;
  released: boolean;
  thumbnailRequests: unknown[][];
  listenerCount: () => number;
  emit: (event: string, payload?: Payload) => void;
  addListener: (event: string, listener: (payload: Payload) => void) => { remove: () => void };
  generateThumbnailsAsync: (times: unknown, options: unknown) => Promise<unknown[]>;
  play: () => void;
  release: () => void;
};

const native = vi.hoisted(() => {
  const state = {
    platform: { OS: 'ios' },
    /** expo-video's native module as `requireOptionalNativeModule` finds it; an Android binary built with the parked patch has the playerless read. */
    expoVideo: null as Record<string, unknown> | null,
    players: [] as unknown[],
    /**
     * Whether a new player is given its item as iOS gives it: once the asset
     * has loaded, after the code that made the player has run.
     */
    attachItems: true,
    /** The stills a player's request is answered with, decided per case. */
    answer: (async () => []) as (player: never) => Promise<unknown[]>,
    makePlayer(source: { uri: string }) {
      const listeners = new Map<string, Set<(payload: Record<string, unknown>) => void>>();
      const player = {
        source,
        muted: false,
        bufferOptions: undefined as unknown,
        played: false,
        released: false,
        thumbnailRequests: [] as unknown[][],
        listenerCount: () => [...listeners.values()].reduce((count, set) => count + set.size, 0),
        emit(event: string, payload: Record<string, unknown> = {}) {
          for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
        },
        addListener(event: string, listener: (payload: Record<string, unknown>) => void) {
          const set = listeners.get(event) ?? new Set();
          set.add(listener);
          listeners.set(event, set);
          return { remove: () => { set.delete(listener); } };
        },
        generateThumbnailsAsync(times: unknown, options: unknown) {
          player.thumbnailRequests.push([times, options]);
          return state.answer(player as never);
        },
        play() { player.played = true; },
        release() { player.released = true; },
      };
      state.players.push(player);
      if (state.attachItems) void Promise.resolve().then(() => player.emit('sourceChange', { source }));
      return player;
    },
  };
  return state;
});

vi.mock('react-native', () => ({ Platform: native.platform }));
vi.mock('expo-video', () => ({ createVideoPlayer: (source: { uri: string }) => native.makePlayer(source) }));
vi.mock('expo', () => ({ requireOptionalNativeModule: (name: string) => (name === 'ExpoVideo' ? native.expoVideo : null) }));

const players = () => native.players as FakePlayer[];
const answerWith = (answer: (player: FakePlayer) => Promise<unknown[]>) => {
  native.answer = answer as (player: never) => Promise<unknown[]>;
};
/** Every queued step that can run now has run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// A fresh module per case: reads queue across the app, so one case's read must
// not hold the next case's, and the platform is read when the module loads.
async function load() {
  vi.resetModules();
  return import('../lib/video-frame');
}

const STILL = { width: 405, height: 720 };

beforeEach(() => {
  native.platform.OS = 'ios';
  native.expoVideo = null;
  native.players.length = 0;
  native.attachItems = true;
  answerWith(async () => [STILL]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('grabVideoFrame', () => {
  it('reads a still from a muted player held to a second of buffer, and lets it go', async () => {
    const { grabVideoFrame, VIDEO_FRAME_MAX_SIDE, VIDEO_FRAME_TIME_SECONDS, VIDEO_STILLS_READ } = await load();
    expect(VIDEO_STILLS_READ).toBe(true);

    await expect(grabVideoFrame('https://cdn.test/clip.mp4')).resolves.toBe(STILL);

    const [player] = players();
    expect(player.source).toEqual({ uri: 'https://cdn.test/clip.mp4' });
    expect(player.muted).toBe(true);
    expect(player.audioMixingMode).toBe('auto');
    expect(player.bufferOptions).toEqual({ preferredForwardBufferDuration: 1 });
    expect(player.thumbnailRequests).toEqual([
      [VIDEO_FRAME_TIME_SECONDS, { maxWidth: VIDEO_FRAME_MAX_SIDE, maxHeight: VIDEO_FRAME_MAX_SIDE }],
    ]);
    expect(player.played).toBe(false);
    expect(player.listenerCount()).toBe(0);
    expect(player.released).toBe(true);
  });

  // Stock expo-video opens an Android clip for a still on the one thread every
  // Expo module's async calls share: a slow link there held up session reads,
  // haptics and the clipboard. The binaries in phones today have only that.
  it.each([
    ['no expo-video module', null],
    ['expo-video without the playerless read', { generateThumbnailsAsync: () => undefined }],
  ])('reads nothing on an Android binary with %s, and makes no player there', async (_case, expoVideo) => {
    native.platform.OS = 'android';
    native.expoVideo = expoVideo;
    const { grabVideoFrame, VIDEO_STILLS_READ } = await load();

    expect(VIDEO_STILLS_READ).toBe(false);
    await expect(grabVideoFrame('https://cdn.test/clip.mp4')).resolves.toBeNull();
    expect(players()).toHaveLength(0);
  });

  it('never asks for the playerless read on iOS, whose binary reads from a player', async () => {
    const generateThumbnailFromUrlAsync = vi.fn(async () => STILL);
    native.expoVideo = { generateThumbnailFromUrlAsync };
    const { grabVideoFrame } = await load();

    await expect(grabVideoFrame('https://cdn.test/clip.mp4')).resolves.toBe(STILL);
    expect(generateThumbnailFromUrlAsync).not.toHaveBeenCalled();
    expect(players()).toHaveLength(1);
  });

  describe('on an Android binary that reads a still with no player', () => {
    const generateThumbnailFromUrlAsync = vi.fn<(url: string, time: number, options: unknown) => Promise<unknown>>();

    beforeEach(() => {
      native.platform.OS = 'android';
      native.expoVideo = { generateThumbnailFromUrlAsync };
      generateThumbnailFromUrlAsync.mockReset();
      generateThumbnailFromUrlAsync.mockResolvedValue(STILL);
    });

    it('reads the still from the clip’s link at the moment and size iOS reads, and makes no player', async () => {
      const { grabVideoFrame, VIDEO_FRAME_MAX_SIDE, VIDEO_FRAME_TIME_SECONDS, VIDEO_STILLS_READ } = await load();
      expect(VIDEO_STILLS_READ).toBe(true);

      await expect(grabVideoFrame('https://cdn.test/clip.mp4')).resolves.toBe(STILL);
      expect(generateThumbnailFromUrlAsync.mock.calls).toEqual([
        ['https://cdn.test/clip.mp4', VIDEO_FRAME_TIME_SECONDS, { maxWidth: VIDEO_FRAME_MAX_SIDE, maxHeight: VIDEO_FRAME_MAX_SIDE }],
      ]);
      expect(players()).toHaveLength(0);
    });

    it('reads one still at a time, and starts the next when one never returns', async () => {
      vi.useFakeTimers();
      generateThumbnailFromUrlAsync.mockImplementation((url) => (url.endsWith('stuck.mp4')
        ? new Promise(() => undefined)
        : Promise.resolve(STILL)));
      const { grabVideoFrame, VIDEO_FRAME_DEADLINE_MS } = await load();

      const stuck = grabVideoFrame('https://cdn.test/stuck.mp4');
      const next = grabVideoFrame('https://cdn.test/next.mp4');
      await vi.advanceTimersByTimeAsync(VIDEO_FRAME_DEADLINE_MS - 1);
      expect(generateThumbnailFromUrlAsync).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(stuck).resolves.toBeNull();
      await expect(next).resolves.toBe(STILL);
      expect(generateThumbnailFromUrlAsync.mock.calls.map(([url]) => url)).toEqual([
        'https://cdn.test/stuck.mp4', 'https://cdn.test/next.mp4',
      ]);
    });

    it('asks nothing for a read called off before its turn, and gives none for one called off midway', async () => {
      let answerLate: (still: unknown) => void = () => undefined;
      generateThumbnailFromUrlAsync.mockImplementation(() => new Promise((resolve) => { answerLate = resolve; }));
      const { grabVideoFrame } = await load();
      const midway = new AbortController();
      const waiting = new AbortController();

      const firstStill = grabVideoFrame('https://cdn.test/first.mp4', { signal: midway.signal });
      const secondStill = grabVideoFrame('https://cdn.test/second.mp4', { signal: waiting.signal });
      await settle();
      waiting.abort();
      midway.abort();

      await expect(firstStill).resolves.toBeNull();
      await expect(secondStill).resolves.toBeNull();
      expect(generateThumbnailFromUrlAsync).toHaveBeenCalledTimes(1);
      answerLate(STILL);
      await settle();
      expect(generateThumbnailFromUrlAsync).toHaveBeenCalledTimes(1);
    });

    it('gives no still when the clip cannot be read, and the next read still runs', async () => {
      generateThumbnailFromUrlAsync.mockImplementation((url) => (url.endsWith('broken.mp4')
        ? Promise.reject(new Error('setDataSource failed: status = 0x80000000'))
        : Promise.resolve(STILL)));
      const { grabVideoFrame } = await load();

      await expect(grabVideoFrame('https://cdn.test/broken.mp4')).resolves.toBeNull();
      await expect(grabVideoFrame('https://cdn.test/next.mp4')).resolves.toBe(STILL);
    });
  });

  it('waits until the player has its item, before which it answers with no still, and no longer', async () => {
    native.attachItems = false;
    const attached = new Set<FakePlayer>();
    answerWith(async (player) => (attached.has(player) ? [STILL] : []));
    const { grabVideoFrame } = await load();

    const still = grabVideoFrame('https://cdn.test/clip.mp4');
    await settle();
    const [player] = players();
    // A change to no source is not the item arriving.
    player.emit('sourceChange', { source: null });
    await settle();
    expect(player.thumbnailRequests).toHaveLength(0);

    // The item is all a still needs: nothing has to buffer first.
    attached.add(player);
    player.emit('sourceChange', { source: { uri: 'https://cdn.test/clip.mp4' } });

    await expect(still).resolves.toBe(STILL);
    expect(player.listenerCount()).toBe(0);
    expect(player.released).toBe(true);
  });

  it('gives no still for a clip that will not load, and lets its player go', async () => {
    native.attachItems = false;
    const { grabVideoFrame } = await load();

    const still = grabVideoFrame('https://cdn.test/expired.mp4');
    await settle();
    const [player] = players();
    player.emit('statusChange', { status: 'error', error: { message: 'The link has expired.' } });

    await expect(still).resolves.toBeNull();
    expect(player.thumbnailRequests).toHaveLength(0);
    expect(player.listenerCount()).toBe(0);
    expect(player.released).toBe(true);
  });

  it('reads one still at a time, in the order asked', async () => {
    let answerFirst: (stills: unknown[]) => void = () => undefined;
    const second = { width: 720, height: 405 };
    answerWith((player) => (player.source.uri.endsWith('first.mp4')
      ? new Promise((resolve) => { answerFirst = resolve; })
      : Promise.resolve([second])));
    const { grabVideoFrame } = await load();

    const firstStill = grabVideoFrame('https://cdn.test/first.mp4');
    const secondStill = grabVideoFrame('https://cdn.test/second.mp4');
    await settle();
    expect(players()).toHaveLength(1);

    answerFirst([STILL]);
    await expect(firstStill).resolves.toBe(STILL);
    await expect(secondStill).resolves.toBe(second);
    expect(players().map((player) => player.source.uri)).toEqual([
      'https://cdn.test/first.mp4',
      'https://cdn.test/second.mp4',
    ]);
    expect(players().every((player) => player.released)).toBe(true);
  });

  it('makes no player for a read called off before its turn, and lets go of one called off midway', async () => {
    let answerLate: (stills: unknown[]) => void = () => undefined;
    answerWith(() => new Promise((resolve) => { answerLate = resolve; }));
    const { grabVideoFrame } = await load();
    const midway = new AbortController();
    const waiting = new AbortController();

    const firstStill = grabVideoFrame('https://cdn.test/first.mp4', { signal: midway.signal });
    const secondStill = grabVideoFrame('https://cdn.test/second.mp4', { signal: waiting.signal });
    await settle();
    waiting.abort();
    midway.abort();

    await expect(firstStill).resolves.toBeNull();
    await expect(secondStill).resolves.toBeNull();
    expect(players()).toHaveLength(1);
    expect(players()[0].released).toBe(true);

    // The native answer that lands afterwards changes nothing.
    answerLate([STILL]);
    await settle();
    expect(players()).toHaveLength(1);
  });

  it('starts the next read when a read never returns', async () => {
    vi.useFakeTimers();
    answerWith((player) => (player.source.uri.endsWith('stuck.mp4')
      ? new Promise(() => undefined)
      : Promise.resolve([STILL])));
    const { grabVideoFrame, VIDEO_FRAME_DEADLINE_MS } = await load();

    const stuck = grabVideoFrame('https://cdn.test/stuck.mp4');
    const next = grabVideoFrame('https://cdn.test/next.mp4');
    await vi.advanceTimersByTimeAsync(VIDEO_FRAME_DEADLINE_MS - 1);
    expect(players()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(stuck).resolves.toBeNull();
    await expect(next).resolves.toBe(STILL);
    expect(players()[0].released).toBe(true);
  });

  it('gives no still when the clip cannot be read, and the next read still runs', async () => {
    answerWith((player) => (player.source.uri.endsWith('broken.mp4')
      ? Promise.reject(new Error('Failed to generate a thumbnail'))
      : Promise.resolve([STILL])));
    const { grabVideoFrame } = await load();

    await expect(grabVideoFrame('https://cdn.test/broken.mp4')).resolves.toBeNull();
    await expect(grabVideoFrame('https://cdn.test/next.mp4')).resolves.toBe(STILL);
    expect(players().every((player) => player.released)).toBe(true);
  });
});
