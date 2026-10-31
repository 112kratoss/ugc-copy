import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '..');
const patchFile = 'expo-video+55.0.21+007+android-remote-video-still.patch';
const parkedAt = join('experiments/android-remote-video-still/patches', patchFile);
const shippedAt = join('patches', patchFile);
const lightPlayerPatch = 'patches/expo-video+55.0.21+002+android-light-player-view.patch';
const moduleFile = 'node_modules/expo-video/android/src/main/java/expo/modules/video/VideoModule.kt';
const stillReader = 'lib/video-frame.ts';

/**
 * On Android, stock expo-video 55 reads a still (`generateThumbnailsAsync`)
 * by opening the player's clip with a MediaMetadataRetriever in the body of an
 * async function. Every Expo module's async calls start on one thread,
 * `expo.modules.AsyncFunctionQueue`, and the open blocks it until the clip's
 * header has arrived: on a slow link, session reads from SecureStore, haptics,
 * the clipboard and the viewer's `replaceAsync` all waited behind it, and no
 * JS deadline frees a native thread. So the app read no stills on Android.
 *
 * The patch adds a read with no player, `generateThumbnailFromUrlAsync`, that
 * opens, reads and releases on the IO dispatcher, and moves the stock read's
 * open there too. `lib/video-frame.ts` reads stills on Android only where the
 * binary has the new function, so it is safe in JS from the day it merges. It
 * is Kotlin, so it moves the Android fingerprint and can only ship in a store
 * build: until one is cut it waits in `experiments/android-remote-video-still/`,
 * where `postinstall` does not apply it (see that folder's README).
 */
describe('Android remote video still', () => {
  const read = (relativePath: string) => readFileSync(join(projectRoot, relativePath), 'utf8');
  const shipped = existsSync(join(projectRoot, shippedAt));
  const parked = existsSync(join(projectRoot, parkedAt));
  const lines = read(shipped ? shippedAt : parkedAt).split('\n');
  const isComment = (line: string) => line.trimStart().startsWith('//');
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1));
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).map((line) => line.slice(1));
  const code = added.filter((line) => !isComment(line)).map((line) => line.trim());
  const sequenceNumber = (name: string) => Number(/^expo-video\+55\.0\.21\+(\d+)\+/.exec(name)?.[1] ?? Number.NaN);
  const header = `diff --git a/${moduleFile} b/${moduleFile}`;

  it('lives in one place: parked in experiments/, or shipped from patches/', () => {
    expect([shipped, parked].filter(Boolean)).toHaveLength(1);
  });

  it('is still parked only because 0.1.8 is the newest store build', () => {
    // The next store build is cut from a release bump. Move the patch into
    // patches/ in that commit (README, "Graduating"), so the binary carries
    // it. If that release ships no Android binary, repin this version instead.
    if (parked) {
      expect(JSON.parse(read('app.json')).expo.version).toBe('0.1.8');
    }
  });

  it('is cut for the installed expo-video, and applied by postinstall once shipped', () => {
    const packageJson = JSON.parse(read('package.json'));
    const packageLock = JSON.parse(read('package-lock.json'));

    // patch-package matches a patch to a package by the version in its file
    // name. A bump needs the patch cut again, or dropped if upstream has it.
    expect(packageJson.dependencies['expo-video']).toBe('~55.0.21');
    expect(packageLock.packages['node_modules/expo-video'].version).toBe('55.0.21');
    expect(packageJson.scripts.postinstall).toBe('patch-package');
  });

  it('touches the module definition and nothing else', () => {
    expect(lines.filter((line) => line.startsWith('diff --git '))).toEqual([header]);
  });

  it('applies after every other patch that changes the module definition, on the file the last of them leaves', () => {
    // patch-package applies a package's patches in the order of the number in
    // their names, and this one is cut against what the others leave of this
    // file. Patches for other files of the package may carry any number.
    const others = readdirSync(join(projectRoot, 'patches'))
      .filter((name) => name.startsWith('expo-video+55.0.21+') && name !== patchFile)
      .filter((name) => read(join('patches', name)).split('\n').includes(header))
      .sort((one, other) => sequenceNumber(one) - sequenceNumber(other));
    const last = others[others.length - 1];
    expect(last).toBe(lightPlayerPatch.slice('patches/'.length));
    expect(sequenceNumber(last)).toBeLessThan(sequenceNumber(patchFile));

    // Each file in a patch names the blob it starts from and the one it
    // makes: this patch starts from the blob the last of the others makes.
    const blobs = (patch: string[]) => /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(patch[patch.indexOf(header) + 1] ?? '')?.slice(1, 3);
    const [, leftByTheLast] = blobs(read(join('patches', last)).split('\n')) ?? [];
    const [startsFrom] = blobs(lines) ?? [];
    expect(leftByTheLast).toBeTruthy();
    expect(startsFrom).toBe(leftByTheLast);
  });

  it('has a number of its own among the expo-video patches, and ships no earlier than the parked ones below it', () => {
    // Two patches with one number, shipped or still parked, would meet in
    // patches/ on the day they graduate. Shipped ahead of a lower-numbered
    // patch that is still parked, this one would have that one land in the
    // middle of an applied order later, and patch-package refuses such a tree
    // at the next install. Graduate them together or in number order.
    const own = sequenceNumber(patchFile);
    const shippedNames = readdirSync(join(projectRoot, 'patches')).filter((name) => name !== patchFile);
    const parkedNames = readdirSync(join(projectRoot, 'experiments'))
      .flatMap((experiment) => {
        const folder = join(projectRoot, 'experiments', experiment, 'patches');
        return existsSync(folder) ? readdirSync(folder) : [];
      })
      .filter((name) => name !== patchFile && name.startsWith('expo-video+55.0.21+'));
    expect(own).toBeGreaterThan(0);
    expect([...shippedNames, ...parkedNames].map(sequenceNumber)).not.toContain(own);
    if (shipped) {
      expect(parkedNames.map(sequenceNumber).filter((number) => number < own)).toEqual([]);
    }
  });

  it('is compiled at all: the module is built from source on Android', () => {
    // Expo's Android modules are linked as prebuilt archives, and a patch to
    // the Kotlin of one is then ignored without a word. Either of these makes
    // the build compile the module instead.
    const listed = JSON.parse(read('package.json')).expo?.autolinking?.android?.buildFromSource?.includes('expo-video') === true;
    const publicationDropped = read(lightPlayerPatch).includes('\n-    "publication": {\n');
    expect(listed || publicationDropped).toBe(true);
  });

  it('opens, reads and releases the playerless still on the IO dispatcher', () => {
    const start = code.findIndex((line) => line.startsWith('AsyncFunction("generateThumbnailFromUrlAsync") Coroutine {'));
    expect(start).toBeGreaterThanOrEqual(0);
    const body = code.slice(start);
    const at = (text: string) => body.findIndex((line) => line.includes(text));

    // The body's first statement leaves the shared thread; nothing that can
    // block comes before it.
    expect(body[1]).toBe('return@Coroutine withContext(Dispatchers.IO) {');
    expect(at('MediaMetadataRetriever()')).toBeGreaterThan(1);
    expect(at('retriever.setDataSource(url, ')).toBeGreaterThan(at('MediaMetadataRetriever()'));
    // The platform's cache reads up to 20 MiB ahead while the retriever is open; these two headers, taken off before
    // the request goes out, hold it to 1 MiB ahead and drop the connection there.
    expect(body[at('retriever.setDataSource(url, ')]).toBe(
      'retriever.setDataSource(url, mapOf("x-cache-config" to "256/1024/0", "x-disconnect-at-highwatermark" to "1"))',
    );
    expect(at('retriever.generateThumbnailAtTime(time, options)')).toBeGreaterThan(at('retriever.setDataSource('));
    // Released whatever the read did, with the call every API level has.
    expect(at('} finally {')).toBeGreaterThan(at('retriever.generateThumbnailAtTime('));
    expect(at('runCatching { retriever.release() }')).toBeGreaterThan(at('} finally {'));
    expect(code).toContain('import kotlinx.coroutines.Dispatchers');
    expect(code).toContain('import kotlinx.coroutines.withContext');
  });

  it("moves the stock read's open, and its close, onto the IO dispatcher too", () => {
    expect(removed).toContain('        return@Coroutine ref.toMetadataRetriever().safeUse {');
    const contexts = code.flatMap((line, index) => (line === 'return@Coroutine withContext(Dispatchers.IO) {' ? [index] : []));
    const opens = code.flatMap((line, index) => (line === 'ref.toMetadataRetriever().safeUse {' ? [index] : []));
    // The second `withContext` is the stock read's: its first statement opens
    // the clip, and `safeUse` closes it in the same context.
    expect(contexts).toHaveLength(2);
    expect(opens).toEqual([contexts[1] + 1]);
  });

  it('is the function the still reader looks for', () => {
    // A rename on either side would leave Android reading no stills, without a word.
    expect(read(stillReader)).toContain('generateThumbnailFromUrlAsync(url: string, timeSeconds: number, options: VideoThumbnailOptions)');
    expect(code.some((line) => line.startsWith('AsyncFunction("generateThumbnailFromUrlAsync") Coroutine { url: String, time: Duration, options: VideoThumbnailOptions? ->'))).toBe(true);
  });
});
