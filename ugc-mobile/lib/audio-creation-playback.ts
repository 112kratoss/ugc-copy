/**
 * Playback of audio creations (voiceovers, sound effects).
 *
 * One store, one native player. A card in the Creations feed and the reel's
 * audio page both draw the same creation, so the state lives outside them: the
 * second one opens on the position the first one left, and starting one
 * creation ends another by construction rather than by every view remembering
 * to stop its neighbours.
 *
 * Nothing here plays by itself. Sound starts on a tap and stops as soon as the
 * creation has no place on screen that could stop it (HIG, Playing audio).
 *
 * The native player is injected so this file stays free of React Native and
 * Expo and can be tested as plain logic; `audio-creation-native-player.ts`
 * holds the real one.
 */

export type AudioPlaybackPhase = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface AudioPlaybackSnapshot {
  phase: AudioPlaybackPhase;
  /** Seconds into the file. */
  positionSeconds: number;
  /** The file's own length once the player has read it; null before. */
  durationSeconds: number | null;
}

/** What the store asks of a native player. */
export interface AudioPlayerHandle {
  play: () => void;
  pause: () => void;
  seekTo: (seconds: number) => void;
  release: () => void;
}

/** What a native player reports back. */
export interface AudioPlayerEvents {
  onStatus: (status: 'loading' | 'ready' | 'error') => void;
  onPlayingChange: (playing: boolean) => void;
  onProgress: (positionSeconds: number, durationSeconds: number | null) => void;
  onEnded: () => void;
}

export type CreateAudioPlayer = (url: string, events: AudioPlayerEvents) => AudioPlayerHandle;

export interface AudioPlaybackStore {
  subscribe: (listener: () => void) => () => void;
  /** Stable between changes, and always the same idle object for a creation that is not loaded. */
  getSnapshot: (itemId: string) => AudioPlaybackSnapshot;
  /** The play button: starts, pauses, resumes, replays after the end, reloads after an error. */
  toggle: (itemId: string, url: string) => void;
  /** Moves to a fraction (0–1) of the file's length. Ignored until the length is known. */
  seek: (itemId: string, fraction: number) => void;
  /**
   * A place on screen that draws this creation's player, and whether a person
   * can reach its controls right now (its screen is focused, its slide is the
   * one in view).
   */
  present: (itemId: string, presenter: object, reachable: boolean) => void;
  /** The presenter is gone. */
  withdraw: (itemId: string, presenter: object) => void;
  /**
   * This creation's controls went out of reach where they are still drawn: its
   * card was scrolled off the screen. Its sound stops and its place is kept.
   */
  pause: (itemId: string) => void;
  /**
   * Every control went out of reach at once: the app left the foreground.
   * Sound stops now, and stays stopped until it is asked for again.
   */
  suspend: () => void;
}

const IDLE: AudioPlaybackSnapshot = Object.freeze({ phase: 'idle', positionSeconds: 0, durationSeconds: null });

interface LoadedAudio {
  itemId: string;
  player: AudioPlayerHandle;
  status: 'loading' | 'ready' | 'error';
  playing: boolean;
  /** The person's last word: play, or pause. */
  wantsPlay: boolean;
  ended: boolean;
  positionSeconds: number;
  durationSeconds: number | null;
  snapshot: AudioPlaybackSnapshot;
}

/**
 * Read from what the person asked for, not from what the player has got round
 * to: the button answers the tap on the same frame, and the native player's
 * own report (`playing`) only corrects it when something else stops the sound.
 */
function phaseOf(loaded: LoadedAudio): AudioPlaybackPhase {
  if (loaded.status === 'error') return 'error';
  if (loaded.ended) return 'ended';
  if (!loaded.wantsPlay) return 'paused';
  // Asked to play with the file not ready: opening it, or waiting on the network.
  return loaded.status === 'ready' ? 'playing' : 'loading';
}

export function createAudioPlaybackStore(createPlayer: CreateAudioPlayer): AudioPlaybackStore {
  const listeners = new Set<() => void>();
  const presenters = new Map<string, Map<object, boolean>>();
  let loaded: LoadedAudio | null = null;

  const emit = () => listeners.forEach((listener) => listener());

  /** Recomputes the loaded creation's snapshot; tells listeners only when it changed. */
  const publish = () => {
    if (!loaded) return;
    const phase = phaseOf(loaded);
    const previous = loaded.snapshot;
    if (
      previous.phase === phase
      && previous.positionSeconds === loaded.positionSeconds
      && previous.durationSeconds === loaded.durationSeconds
    ) return;
    loaded.snapshot = { phase, positionSeconds: loaded.positionSeconds, durationSeconds: loaded.durationSeconds };
    emit();
  };

  const unload = () => {
    if (!loaded) return;
    const { player } = loaded;
    loaded = null;
    player.release();
    emit();
  };

  const load = (itemId: string, url: string) => {
    unload();
    const next: LoadedAudio = {
      itemId,
      // Assigned just below; the events need `next` to tell a live player from a released one.
      player: undefined as unknown as AudioPlayerHandle,
      status: 'loading',
      playing: false,
      wantsPlay: true,
      ended: false,
      positionSeconds: 0,
      durationSeconds: null,
      snapshot: { phase: 'loading', positionSeconds: 0, durationSeconds: null },
    };
    // A released player can still deliver an event that was already on its way.
    const live = () => loaded === next;
    next.player = createPlayer(url, {
      onStatus: (status) => {
        if (!live()) return;
        next.status = status;
        publish();
      },
      onPlayingChange: (playing) => {
        if (!live()) return;
        next.playing = playing;
        if (playing) {
          next.wantsPlay = true;
          next.ended = false;
        } else if (next.status === 'ready' && !next.ended) {
          // Stopped with the file ready, and not by reaching its end: something
          // outside paused it (a call, the app leaving the screen). It stays
          // paused until it is asked to play again.
          next.wantsPlay = false;
        }
        publish();
      },
      onProgress: (positionSeconds, durationSeconds) => {
        if (!live()) return;
        if (durationSeconds !== null && durationSeconds > 0) next.durationSeconds = durationSeconds;
        // The end is reported once, by `onEnded`; a late tick must not move it.
        if (!next.ended) next.positionSeconds = Math.max(0, positionSeconds);
        publish();
      },
      onEnded: () => {
        if (!live()) return;
        next.ended = true;
        next.wantsPlay = false;
        next.playing = false;
        if (next.durationSeconds !== null) next.positionSeconds = next.durationSeconds;
        publish();
      },
    });
    loaded = next;
    emit();
    next.player.play();
  };

  /** Stops the loaded creation's sound where it is; it stays stopped until it is asked for again. */
  const pauseLoaded = () => {
    if (!loaded || !(loaded.wantsPlay || loaded.playing)) return;
    loaded.wantsPlay = false;
    loaded.player.pause();
    publish();
  };

  const isReachable = (itemId: string) => {
    const forItem = presenters.get(itemId);
    if (!forItem) return false;
    for (const reachable of forItem.values()) if (reachable) return true;
    return false;
  };

  /** Sound with no control on screen is stopped; a creation nothing draws is let go of. */
  const enforcePresence = () => {
    if (!loaded) return;
    if (!presenters.has(loaded.itemId)) {
      unload();
      return;
    }
    if (!isReachable(loaded.itemId)) pauseLoaded();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot(itemId) {
      return loaded?.itemId === itemId ? loaded.snapshot : IDLE;
    },

    toggle(itemId, url) {
      // Only something on screen can start sound, so there is always a control to stop it with.
      if (!isReachable(itemId)) return;

      if (!loaded || loaded.itemId !== itemId || loaded.status === 'error') {
        // An error reloads with the address the caller holds now: signed
        // addresses expire, and the list hands out fresh ones.
        load(itemId, url);
        return;
      }

      if (loaded.ended) {
        loaded.ended = false;
        loaded.wantsPlay = true;
        loaded.positionSeconds = 0;
        loaded.player.seekTo(0);
        loaded.player.play();
      } else if (loaded.wantsPlay) {
        loaded.wantsPlay = false;
        loaded.player.pause();
      } else {
        loaded.wantsPlay = true;
        loaded.player.play();
      }
      publish();
    },

    seek(itemId, fraction) {
      if (!loaded || loaded.itemId !== itemId || loaded.status === 'error') return;
      if (loaded.durationSeconds === null || !Number.isFinite(fraction)) return;
      const target = Math.min(1, Math.max(0, fraction)) * loaded.durationSeconds;
      loaded.ended = false;
      loaded.positionSeconds = target;
      loaded.player.seekTo(target);
      publish();
    },

    present(itemId, presenter, reachable) {
      const forItem = presenters.get(itemId) ?? new Map<object, boolean>();
      forItem.set(presenter, reachable);
      presenters.set(itemId, forItem);
      enforcePresence();
    },

    withdraw(itemId, presenter) {
      const forItem = presenters.get(itemId);
      if (!forItem) return;
      forItem.delete(presenter);
      if (forItem.size === 0) presenters.delete(itemId);
      enforcePresence();
    },

    pause(itemId) {
      if (loaded?.itemId === itemId) pauseLoaded();
    },

    suspend() {
      pauseLoaded();
    },
  };
}

/** `m:ss`, the way a player counts; a missing or broken number is `0:00`. */
export function formatAudioClock(seconds: number | null | undefined) {
  const whole = typeof seconds === 'number' && Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** How much of the bar is filled, 0–1. */
export function getAudioProgressFraction(snapshot: Pick<AudioPlaybackSnapshot, 'positionSeconds' | 'durationSeconds'>) {
  if (!snapshot.durationSeconds || snapshot.durationSeconds <= 0) return 0;
  return Math.min(1, Math.max(0, snapshot.positionSeconds / snapshot.durationSeconds));
}
