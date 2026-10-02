import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createAudioPlaybackStore,
  formatAudioClock,
  getAudioProgressFraction,
  type AudioPlayerEvents,
} from '../lib/audio-creation-playback';

function harness() {
  const players: Array<{
    url: string;
    events: AudioPlayerEvents;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    seekTo: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  }> = [];
  const store = createAudioPlaybackStore((url, events) => {
    const player = { url, events, play: vi.fn(), pause: vi.fn(), seekTo: vi.fn(), release: vi.fn() };
    players.push(player);
    return player;
  });
  const card = {};
  /** The usual start: a card on screen, tapped, and the file begins to play. */
  const startPlaying = (itemId = 'voiceover', url = 'https://files.test/a.mp3?token=1') => {
    store.present(itemId, card, true);
    store.toggle(itemId, url);
    const player = players.at(-1)!;
    player.events.onStatus('ready');
    player.events.onProgress(0, 6);
    player.events.onPlayingChange(true);
    return player;
  };
  return { store, players, card, startPlaying };
}

describe('audio creation playback', () => {
  it('is idle, and the same idle object, for a creation that is not loaded', () => {
    const { store } = harness();
    expect(store.getSnapshot('anything')).toEqual({ phase: 'idle', positionSeconds: 0, durationSeconds: null });
    expect(store.getSnapshot('anything')).toBe(store.getSnapshot('something-else'));
  });

  it('opens the file on the first tap and reports loading until the file is ready', () => {
    const { store, players, card } = harness();
    store.present('voiceover', card, true);

    store.toggle('voiceover', 'https://files.test/a.mp3?token=1');

    expect(players).toHaveLength(1);
    expect(players[0].url).toBe('https://files.test/a.mp3?token=1');
    expect(players[0].play).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot('voiceover').phase).toBe('loading');

    players[0].events.onProgress(0, 6.11);
    expect(store.getSnapshot('voiceover')).toEqual({ phase: 'loading', positionSeconds: 0, durationSeconds: 6.11 });
    players[0].events.onStatus('ready');
    expect(store.getSnapshot('voiceover').phase).toBe('playing');
    players[0].events.onPlayingChange(true);
    expect(store.getSnapshot('voiceover').phase).toBe('playing');
  });

  it('pauses and resumes from the same place on the same player', () => {
    const { store, players, startPlaying } = harness();
    const player = startPlaying();
    player.events.onProgress(2.5, 6);

    store.toggle('voiceover', 'https://files.test/a.mp3?token=2');
    expect(player.pause).toHaveBeenCalledTimes(1);
    // The button answers the tap; it does not wait for the player to agree.
    expect(store.getSnapshot('voiceover')).toEqual({ phase: 'paused', positionSeconds: 2.5, durationSeconds: 6 });
    player.events.onPlayingChange(false);
    expect(store.getSnapshot('voiceover').phase).toBe('paused');

    store.toggle('voiceover', 'https://files.test/a.mp3?token=3');
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot('voiceover').phase).toBe('playing');
    // A re-signed address for the same creation is not a new file to open.
    expect(players).toHaveLength(1);
    expect(player.release).not.toHaveBeenCalled();
  });

  it('a tap while the file is still opening cancels the start', () => {
    const { store, players, card } = harness();
    store.present('voiceover', card, true);
    store.toggle('voiceover', 'https://files.test/a.mp3');
    store.toggle('voiceover', 'https://files.test/a.mp3');

    expect(players[0].pause).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot('voiceover').phase).toBe('paused');
  });

  it('shows waiting, not paused, when playback stalls on the network', () => {
    const { store, startPlaying } = harness();
    const player = startPlaying();
    player.events.onStatus('loading');
    player.events.onPlayingChange(false);
    expect(store.getSnapshot('voiceover').phase).toBe('loading');
  });

  it('stays paused when something outside pauses it', () => {
    const { store, startPlaying } = harness();
    const player = startPlaying();
    // The app left the foreground: the player stops by itself, file still ready.
    player.events.onPlayingChange(false);
    expect(store.getSnapshot('voiceover').phase).toBe('paused');
    store.toggle('voiceover', 'https://files.test/a.mp3');
    expect(player.play).toHaveBeenCalledTimes(2);
  });

  it('rests at the end and replays from the start', () => {
    const { store, startPlaying } = harness();
    const player = startPlaying();
    player.events.onProgress(5.9, 6);
    player.events.onEnded();
    player.events.onPlayingChange(false);
    // A tick that was already on its way must not move a finished file.
    player.events.onProgress(5.95, 6);
    expect(store.getSnapshot('voiceover')).toEqual({ phase: 'ended', positionSeconds: 6, durationSeconds: 6 });

    store.toggle('voiceover', 'https://files.test/a.mp3');
    expect(player.seekTo).toHaveBeenCalledWith(0);
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot('voiceover')).toEqual({ phase: 'playing', positionSeconds: 0, durationSeconds: 6 });
  });

  it('reloads with the current address after an error', () => {
    const { store, players, startPlaying } = harness();
    const first = startPlaying('voiceover', 'https://files.test/a.mp3?token=expired');
    first.events.onStatus('error');
    expect(store.getSnapshot('voiceover').phase).toBe('error');

    store.toggle('voiceover', 'https://files.test/a.mp3?token=fresh');
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(players).toHaveLength(2);
    expect(players[1].url).toBe('https://files.test/a.mp3?token=fresh');
    expect(store.getSnapshot('voiceover').phase).toBe('loading');
  });

  it('plays one creation at a time', () => {
    const { store, players, card, startPlaying } = harness();
    const first = startPlaying('voiceover');
    store.present('sound-effect', card, true);

    store.toggle('sound-effect', 'https://files.test/b.wav');

    expect(first.release).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot('voiceover').phase).toBe('idle');
    expect(store.getSnapshot('sound-effect').phase).toBe('loading');
    // The released player can still report; it no longer speaks for anything.
    first.events.onPlayingChange(true);
    first.events.onProgress(3, 6);
    expect(store.getSnapshot('voiceover').phase).toBe('idle');
    expect(players[1].play).toHaveBeenCalledTimes(1);
  });

  it('seeks by a fraction of the length, and only once the length is known', () => {
    const { store, players, card, startPlaying } = harness();
    store.present('unknown-length', card, true);
    store.toggle('unknown-length', 'https://files.test/c.mp3');
    store.seek('unknown-length', 0.5);
    expect(players[0].seekTo).not.toHaveBeenCalled();

    const player = startPlaying();
    store.seek('voiceover', 0.5);
    expect(player.seekTo).toHaveBeenCalledWith(3);
    expect(store.getSnapshot('voiceover').positionSeconds).toBe(3);
    store.seek('voiceover', 7);
    expect(player.seekTo).toHaveBeenLastCalledWith(6);
    store.seek('some-other-creation', 0.2);
    expect(player.seekTo).toHaveBeenCalledTimes(2);
  });

  it('seeking away from the end makes it playable again without a restart', () => {
    const { store, startPlaying } = harness();
    const player = startPlaying();
    player.events.onEnded();
    store.seek('voiceover', 0.5);
    expect(store.getSnapshot('voiceover').phase).toBe('paused');
    store.toggle('voiceover', 'https://files.test/a.mp3');
    expect(player.seekTo).toHaveBeenCalledTimes(1);
    expect(player.play).toHaveBeenCalledTimes(2);
  });

  it('does not start sound for a creation with no control on screen', () => {
    const { store, players, card } = harness();
    store.toggle('voiceover', 'https://files.test/a.mp3');
    expect(players).toHaveLength(0);

    store.present('voiceover', card, false);
    store.toggle('voiceover', 'https://files.test/a.mp3');
    expect(players).toHaveLength(0);
  });

  it('pauses when its last reachable control goes, and keeps the position', () => {
    const { store, card, startPlaying } = harness();
    const player = startPlaying();
    player.events.onProgress(4, 6);
    const reelSlide = {};
    store.present('voiceover', reelSlide, true);

    // The card's screen is covered by the reel; the reel's slide can still stop it.
    store.present('voiceover', card, false);
    expect(player.pause).not.toHaveBeenCalled();

    // The reader swipes to the next slide.
    store.present('voiceover', reelSlide, false);
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot('voiceover')).toMatchObject({ phase: 'paused', positionSeconds: 4 });
    expect(player.release).not.toHaveBeenCalled();
  });

  it('lets go of the player when nothing draws the creation any more', () => {
    const { store, card, startPlaying } = harness();
    const player = startPlaying();

    store.withdraw('voiceover', card);

    expect(player.release).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot('voiceover').phase).toBe('idle');
  });

  it('keeps another creation playing when an unrelated card leaves the screen', () => {
    const { store, startPlaying } = harness();
    const player = startPlaying();
    const otherCard = {};
    store.present('sound-effect', otherCard, true);
    store.withdraw('sound-effect', otherCard);
    expect(player.pause).not.toHaveBeenCalled();
    expect(player.release).not.toHaveBeenCalled();
  });

  it('tells listeners about real changes only, and leaves other creations alone', () => {
    const { store, startPlaying } = harness();
    const listener = vi.fn();
    const player = startPlaying();
    const idle = store.getSnapshot('sound-effect');
    const unsubscribe = store.subscribe(listener);

    player.events.onProgress(1, 6);
    expect(listener).toHaveBeenCalledTimes(1);
    const playing = store.getSnapshot('voiceover');
    player.events.onProgress(1, 6);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot('voiceover')).toBe(playing);
    expect(store.getSnapshot('sound-effect')).toBe(idle);

    unsubscribe();
    player.events.onProgress(2, 6);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('the app leaving the foreground', () => {
  it('stops the sound at once, and does not start it again by itself', () => {
    const { store, startPlaying } = harness();
    const player = startPlaying();
    player.events.onProgress(2, 6);

    store.suspend();

    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot('voiceover')).toEqual({ phase: 'paused', positionSeconds: 2, durationSeconds: 6 });
    expect(player.release).not.toHaveBeenCalled();

    // Back in front: still paused, where it stopped, until it is tapped.
    player.events.onPlayingChange(false);
    expect(store.getSnapshot('voiceover').phase).toBe('paused');
    store.toggle('voiceover', 'https://files.test/a.mp3');
    expect(player.play).toHaveBeenCalledTimes(2);
  });

  it('cancels a start that had not produced sound yet', () => {
    const { store, players, card } = harness();
    store.present('voiceover', card, true);
    store.toggle('voiceover', 'https://files.test/a.mp3');

    store.suspend();

    expect(players[0].pause).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot('voiceover').phase).toBe('paused');
  });

  it('has nothing to do when nothing is playing', () => {
    const { store, startPlaying } = harness();
    store.suspend();
    const player = startPlaying();
    store.toggle('voiceover', 'https://files.test/a.mp3');
    player.events.onPlayingChange(false);
    expect(player.pause).toHaveBeenCalledTimes(1);
    store.suspend();
    expect(player.pause).toHaveBeenCalledTimes(1);
  });

  /**
   * Found on a Pixel 9a emulator, 2026-10-02: with a voiceover playing and the
   * launcher brought in front, Android's audio track stayed `started` and the
   * sound played on with nothing on screen to stop it. expo-video pauses a
   * backgrounded player by walking its video views, and an audio creation's
   * player is attached to none. Only a device shows the sound itself, so this
   * holds the wiring that stops it: the app-state event, beside the player.
   */
  it('is what the app-state event reports, beside the player', () => {
    const adapter = readFileSync(path.join(__dirname, '..', 'lib', 'audio-creation-native-player.ts'), 'utf8');
    expect(adapter).toMatch(/AppState\.addEventListener\('change', \(state\) => \{\s*if \(state !== 'active'\) audioCreationPlayback\.suspend\(\);/);
    // Registered with the first player, so it is in place before any sound.
    expect(adapter).toMatch(/const createNativeAudioPlayer: CreateAudioPlayer = \(url, events\) => \{\s*stopWhenAppLeavesForeground\(\);/);
    // The rule it stands in for: expo-video pauses the players its views hold, and only those.
    const manager = readFileSync(path.join(
      __dirname, '..', 'node_modules', 'expo-video', 'android', 'src', 'main', 'java', 'expo', 'modules', 'video', 'managers', 'VideoManager.kt',
    ), 'utf8');
    expect(manager).toMatch(/fun onAppBackgrounded\(\) \{\s*for \(videoView in videoViews\.values\) \{\s*if \(shouldPauseVideo\(videoView\)\) \{\s*handleVideoPause\(videoView\)/);
  });
});

describe('a card scrolled off the screen', () => {
  it('stops its sound and keeps its place for the way back', () => {
    const { store, startPlaying } = harness();
    const player = startPlaying();
    player.events.onProgress(3, 6);

    store.pause('voiceover');

    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot('voiceover')).toEqual({ phase: 'paused', positionSeconds: 3, durationSeconds: 6 });
    expect(player.release).not.toHaveBeenCalled();

    store.toggle('voiceover', 'https://files.test/a.mp3');
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(player.seekTo).not.toHaveBeenCalled();
  });

  it('leaves the sound of a creation still on screen alone', () => {
    const { store, startPlaying } = harness();
    const player = startPlaying();

    store.pause('sound-effect');

    expect(player.pause).not.toHaveBeenCalled();
    expect(store.getSnapshot('voiceover').phase).toBe('playing');
  });

  it('has nothing to do for a creation that is already quiet', () => {
    const { store, startPlaying } = harness();
    const player = startPlaying();
    store.toggle('voiceover', 'https://files.test/a.mp3');
    player.events.onPlayingChange(false);

    store.pause('voiceover');

    expect(player.pause).toHaveBeenCalledTimes(1);
  });

  /**
   * Only a device shows a list scrolling, so this holds the wiring: the
   * Creations feed reports the cards that left the screen, with any part of a
   * card still showing counted as there (a tall card's player can be the part
   * left on screen, and it must go on answering taps and playing).
   */
  it('is the feed reporting each audio card that left the screen', () => {
    const feed = readFileSync(path.join(__dirname, '..', 'components', 'profile-media-feed.tsx'), 'utf8');
    expect(feed).toMatch(/viewabilityConfig: \{ itemVisiblePercentThreshold: 0, minimumViewTime: 0 \},\s*onViewableItemsChanged: \(\{ changed \}[^)]*\) => \{\s*for \(const token of changed\) \{\s*if \(!token\.isViewable && token\.item\?\.audio\) audioCreationPlayback\.pause\(token\.item\.id\);/);
    expect(feed).toContain('viewabilityConfigCallbackPairs={audioViewabilityPairs}');
    // Audio cards are recycled among themselves: a row holding a player is not handed to a picture.
    expect(feed).toMatch(/getItemType=\{\(card\) => card\.isTextOnly\s*\? 'text'\s*: card\.audio\s*\? 'audio'/);
  });
});

describe('audio player read-outs', () => {
  it('counts time the way a player does', () => {
    expect(formatAudioClock(0)).toBe('0:00');
    expect(formatAudioClock(6.11)).toBe('0:06');
    expect(formatAudioClock(59.9)).toBe('0:59');
    expect(formatAudioClock(75)).toBe('1:15');
    expect(formatAudioClock(600)).toBe('10:00');
    expect(formatAudioClock(null)).toBe('0:00');
    expect(formatAudioClock(Number.NaN)).toBe('0:00');
    expect(formatAudioClock(-3)).toBe('0:00');
  });

  it('fills the bar by the share of the file played', () => {
    expect(getAudioProgressFraction({ positionSeconds: 3, durationSeconds: 6 })).toBe(0.5);
    expect(getAudioProgressFraction({ positionSeconds: 9, durationSeconds: 6 })).toBe(1);
    expect(getAudioProgressFraction({ positionSeconds: 3, durationSeconds: null })).toBe(0);
    expect(getAudioProgressFraction({ positionSeconds: 3, durationSeconds: 0 })).toBe(0);
  });
});
