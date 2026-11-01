import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Payload = Record<string, unknown>;

/** What the reader asked of one player, and the native answers a case gives. */
type FakePlayer = {
  source: { uri: string };
  muted: boolean;
  audioMixingMode?: string;
  duration: number;
  played: boolean;
  released: boolean;
  listenerCount: () => number;
  emit: (event: string, payload?: Payload) => void;
};

const native = vi.hoisted(() => {
  const state = {
    players: [] as unknown[],
    /** Whether making a player throws, as a binary without the module would. */
    refuse: false,
    makePlayer(source: { uri: string }) {
      if (state.refuse) throw new Error('Cannot find native module ExpoVideo');
      const listeners = new Map<string, Set<(payload: Record<string, unknown>) => void>>();
      const player = {
        source,
        muted: false,
        audioMixingMode: undefined as string | undefined,
        // expo-video reports 0 until the item has loaded.
        duration: 0,
        played: false,
        released: false,
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
        play() { player.played = true; },
        release() { player.released = true; },
      };
      state.players.push(player);
      return player;
    },
  };
  return state;
});

vi.mock('expo-video', () => ({ createVideoPlayer: (source: { uri: string }) => native.makePlayer(source) }));

import { MEDIA_FILE_LENGTH_DEADLINE_MS, readMediaFileLength } from '../lib/media-file-length';

const players = () => native.players as FakePlayer[];
/** Every queued step that can run now has run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The read's answer so far: pending until it settles. */
function watch(read: Promise<number | null>) {
  const seen: { value: number | null | 'pending' } = { value: 'pending' };
  void read.then((value) => { seen.value = value; });
  return seen;
}

/** Let go of, and heard no more from: nothing it reports later reaches the reader. */
function expectLetGo(player: FakePlayer) {
  expect(player.released).toBe(true);
  expect(player.listenerCount()).toBe(0);
}

beforeEach(() => {
  native.players.length = 0;
  native.refuse = false;
});

afterEach(() => {
  vi.useRealTimers();
});

// DocumentPicker reports no length, so a picked track reached the draft with none, and the creator's
// check, which holds a track under its slot's shortest only when its length is known, never held one:
// the start refused it at Generate. The app has no audio module, so the file is opened in the video
// player it ships, as an audio creation is played.
describe('a picked sound file’s length', () => {
  it('is the length its player reports once the file has loaded, and the player is let go', async () => {
    const read = readMediaFileLength('file:///cache/beat.mp3');
    const [player] = players();
    expect(player.source).toEqual({ uri: 'file:///cache/beat.mp3' });

    player.emit('sourceLoad', { duration: 1.48 });
    await expect(read).resolves.toBe(1.48);
    expectLetGo(player);
  });

  it('comes from a player that is muted, never played, and declares how it shares the audio session', async () => {
    const read = readMediaFileLength('file:///cache/beat.mp3');
    const [player] = players();

    expect(player.muted).toBe(true);
    expect(player.audioMixingMode).toBe('auto');
    player.emit('sourceLoad', { duration: 4 });
    await read;
    expect(player.played).toBe(false);
  });

  it('is read from the ready player where its load reported none, as iOS gives NaN for an item not yet timed', async () => {
    const read = watch(readMediaFileLength('file:///cache/beat.m4a'));
    const [player] = players();

    player.emit('sourceLoad', { duration: Number.NaN });
    player.emit('statusChange', { status: 'loading' });
    await settle();
    expect(read.value).toBe('pending');
    expect(player.released).toBe(false);

    player.duration = 2.4;
    player.emit('statusChange', { status: 'readyToPlay' });
    await settle();
    expect(read.value).toBe(2.4);
    expectLetGo(player);
  });

  it('waits on past a ready player that holds no length yet, for the load that brings it (Android)', async () => {
    const read = watch(readMediaFileLength('file:///cache/beat.wav'));
    const [player] = players();

    player.emit('statusChange', { status: 'readyToPlay' });
    await settle();
    expect(read.value).toBe('pending');

    player.emit('sourceLoad', { duration: 3.2 });
    await settle();
    expect(read.value).toBe(3.2);
    expectLetGo(player);
  });

  it('is unknown for a file its player cannot load, a format the phone does not play', async () => {
    const read = readMediaFileLength('file:///cache/beat.ogg');
    const [player] = players();

    player.emit('statusChange', { status: 'error', error: { message: 'Cannot Open' } });
    await expect(read).resolves.toBeNull();
    expectLetGo(player);
  });

  it('is unknown once the deadline passes on a load that never ends, and nothing it reports later counts', async () => {
    vi.useFakeTimers();
    const read = watch(readMediaFileLength('file:///cache/beat.mp3'));
    const [player] = players();

    await vi.advanceTimersByTimeAsync(MEDIA_FILE_LENGTH_DEADLINE_MS - 1);
    expect(read.value).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(read.value).toBeNull();
    expectLetGo(player);

    // Its listeners are gone, so a late load reaches nothing.
    player.emit('sourceLoad', { duration: 1.5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(read.value).toBeNull();
  });

  it('is unknown where no player can be made', async () => {
    native.refuse = true;

    await expect(readMediaFileLength('file:///cache/beat.mp3')).resolves.toBeNull();
  });

  it('ignores a length of zero or less, and takes the first real one', async () => {
    const read = watch(readMediaFileLength('file:///cache/beat.mp3'));
    const [player] = players();

    player.emit('sourceLoad', { duration: 0 });
    player.emit('sourceLoad', { duration: -1 });
    await settle();
    expect(read.value).toBe('pending');

    player.emit('sourceLoad', { duration: 6.25 });
    player.emit('sourceLoad', { duration: 9 });
    await settle();
    expect(read.value).toBe(6.25);
  });
});
