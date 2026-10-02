import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const mobileRoot = path.resolve(__dirname, '..');

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolutePath = path.join(root, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) files.push(...sourceFiles(absolutePath));
    else if (/\.tsx?$/.test(entry)) files.push(absolutePath);
  }
  return files;
}

/** Comments may mention a player; only code counts. A `//` after a colon is a URL, not a comment. */
function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** Every way the app makes an expo-video player. */
const PLAYER_CONSTRUCTION = /\b(?:useVideoPlayer|createVideoPlayer|useViewerVideoPlayer)\(/g;
const CACHED_SOURCE = /\buseCaching:\s*true\b|\bcachedVideoSource\(/;

/** The text of a call's first argument, given the index of its opening parenthesis. */
function firstArgument(code: string, openParen: number) {
  let depth = 0;
  for (let index = openParen; index < code.length; index += 1) {
    const char = code[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(openParen + 1, index);
    } else if (char === ',' && depth === 1) return code.slice(openParen + 1, index);
  }
  return code.slice(openParen + 1);
}

/** The players a source file makes, and how many of them read their clip straight from the network. */
export function countVideoPlayers(source: string) {
  const code = stripComments(source);
  const sources = [...code.matchAll(PLAYER_CONSTRUCTION)]
    .map((match) => firstArgument(code, match.index + match[0].length - 1));
  return { players: sources.length, uncached: sources.filter((argument) => !CACHED_SOURCE.test(argument)).length };
}

/** Files that make a player from a source someone else built. Each says who caches it. */
const EXEMPT: Record<string, string> = {
  'lib/use-viewer-video-player.ts': "the reel's hook: app/viewer.tsx hands it a cached source",
  'lib/use-viewer-video-player.ios.ts': "the reel's hook: app/viewer.tsx hands it a cached source",
  'lib/audio-creation-native-player.ts': "an audio creation's player: it never loops, so no copy queues behind another, and expo-video's iOS cache refuses a response that is not video/*",
};

/**
 * Every player loops, and on Android a loop is the clip queued again behind
 * itself. ExoPlayer buffers 50 seconds ahead across those copies, and each copy
 * of a clip that is not read through the video cache is a new download of the
 * whole file. The create screen's reference tile did that until 2026-10-02: a
 * paused 12s clip was fetched five times on every open, a 5s result eleven
 * times, and a playing preview once more on every loop. Nothing on screen shows
 * it, so the rule is held here: a player's source says it is cached.
 */
describe('video player cache coverage', () => {
  const files = ['app', 'components', 'lib'].flatMap((root) => sourceFiles(path.join(mobileRoot, root)));
  const players = files
    .map((file) => ({ file: path.relative(mobileRoot, file), ...countVideoPlayers(readFileSync(file, 'utf8')) }))
    .filter((entry) => entry.players > 0);

  it('tells a cached source from an uncached one', () => {
    expect(countVideoPlayers('const player = useVideoPlayer(source, (instance) => { instance.loop = true; });'))
      .toEqual({ players: 1, uncached: 1 });
    expect(countVideoPlayers('const player = createVideoPlayer({ uri, headers }, MEDIA_PLAYER_OPTIONS);'))
      .toEqual({ players: 1, uncached: 1 });
    expect(countVideoPlayers('const player = createVideoPlayer({ ...source, useCaching: true }, MEDIA_PLAYER_OPTIONS);'))
      .toEqual({ players: 1, uncached: 0 });
    expect(countVideoPlayers('const player = useVideoPlayer(cachedVideoSource(source), (instance) => { instance.loop = true; });'))
      .toEqual({ players: 1, uncached: 0 });
    expect(countVideoPlayers('const own = useViewerVideoPlayer(lent ? null : { ...source, useCaching: true }, (instance) => {});'))
      .toEqual({ players: 1, uncached: 0 });
    // Caching named only in a comment or in a later argument does not count.
    expect(countVideoPlayers('// useCaching: true\nconst player = useVideoPlayer(source, () => ({ useCaching: true }));'))
      .toEqual({ players: 1, uncached: 1 });
  });

  it('sees the players the app makes', () => {
    expect(players.map((entry) => entry.file).sort()).toEqual(expect.arrayContaining([
      'app/viewer.tsx',
      'components/feed-video-preview.tsx',
      'components/recoverable-video-preview.tsx',
    ]));
  });

  it('reads every player through the video cache', () => {
    const uncached = players
      .filter((entry) => !(entry.file in EXEMPT) && entry.uncached > 0)
      .map((entry) => `${entry.file}: ${entry.uncached} of ${entry.players}`);
    expect(uncached).toEqual([]);
  });

  it('holds the uncached audio player to the two things its exemption rests on', () => {
    const audio = stripComments(readFileSync(path.join(mobileRoot, 'lib/audio-creation-native-player.ts'), 'utf8'));
    // No loop, so Android never queues the file behind itself.
    expect(audio).toContain('player.loop = false;');
    expect(audio).not.toMatch(/\.loop = true/);
    // And the reason it cannot simply be cached: on iOS the cache answers a
    // sound file with an unsupported-format error.
    const iosCache = readFileSync(
      path.join(mobileRoot, 'node_modules/expo-video/ios/Cache/ResourceLoaderDelegate.swift'), 'utf8',
    );
    expect(iosCache).toMatch(/func isSupported\(mimeType: String\?\) -> Bool \{\s*return mimeType\?\.starts\(with: "video\/"\) \?\? false/);
  });

  it('keeps no exemption for a file that no longer makes a player', () => {
    const stale = Object.keys(EXEMPT).filter((file) => !players.some((entry) => entry.file === file));
    expect(stale).toEqual([]);
  });
});
