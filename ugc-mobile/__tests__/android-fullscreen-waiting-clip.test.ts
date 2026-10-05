import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '..');
const patchFile = 'expo-video+55.0.21+006+android-fullscreen-waiting-clip.patch';
const parkedAt = join('experiments/android-fullscreen-waiting-clip/patches', patchFile);
const shippedAt = join('patches', patchFile);
const lightPlayerPatch = 'patches/expo-video+55.0.21+002+android-light-player-view.patch';
const activityFile = 'node_modules/expo-video/android/src/main/java/expo/modules/video/FullscreenPlayerActivity.kt';
const previewHook = 'lib/use-native-preview-playback.ts';
// The fingerprints of shipped Android builds that were cut with this patch in
// patches/. Add `targets.android.fingerprint` here in the commit that moves
// ota-targets.json to such a build (README, "Graduating").
const androidBuildsWithThePatch: string[] = [];

/**
 * On Android, expo-video's fullscreen player is an activity of its own. As
 * the app is left from it (Home, the lock screen, a call), its `onPause`
 * stops the clip only if the clip is playing at that moment. A clip that has
 * been asked to play and is still waiting for data is not playing, so it
 * keeps its request, and when the data comes it starts: behind the launcher
 * or the lock screen, with sound, until the app is opened again.
 *
 * JS cannot cover it. The app's own activity is paused for as long as the
 * fullscreen player is in front, so `AppState` says nothing when the app is
 * then left, and the app's timers do not run.
 *
 * The patch asks the other question: whether the clip means to play
 * (`playWhenReady`), which a playing clip does too. It is Kotlin, so it moves
 * the Android fingerprint and can only ship in a store build: until one is
 * cut it waits in `experiments/android-fullscreen-waiting-clip/`, where
 * `postinstall` does not apply it (see that folder's README).
 */
describe('Android fullscreen waiting clip', () => {
  const read = (relativePath: string) => readFileSync(join(projectRoot, relativePath), 'utf8');
  const shipped = existsSync(join(projectRoot, shippedAt));
  const parked = existsSync(join(projectRoot, parkedAt));
  const lines = read(shipped ? shippedAt : parkedAt).split('\n');
  const isComment = (line: string) => line.trimStart().startsWith('//');
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1));
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).map((line) => line.slice(1));
  const kept = lines.filter((line) => line.startsWith(' ')).map((line) => line.slice(1));
  const sequenceNumber = (name: string) => Number(/^expo-video\+55\.0\.21\+(\d+)\+/.exec(name)?.[1] ?? Number.NaN);

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

  it('touches the fullscreen activity and nothing else, in one place', () => {
    expect(lines.filter((line) => line.startsWith('diff --git '))).toEqual([
      `diff --git a/${activityFile} b/${activityFile}`,
    ]);
    expect(lines.filter((line) => line.startsWith('@@ '))).toHaveLength(1);
  });

  it('has a number of its own among the expo-video patches, and no shipped patch changes its file', () => {
    // patch-package applies a package's patches in the order of the number in
    // their names, and refuses a tree whose applied patches are not the first
    // of that order. Two patches with one number, shipped or still parked,
    // would meet in patches/ on the day they graduate.
    const own = sequenceNumber(patchFile);
    const shippedNames = readdirSync(join(projectRoot, 'patches')).filter((name) => name !== patchFile);
    const parkedNames = readdirSync(join(projectRoot, 'experiments'))
      .flatMap((experiment) => {
        const folder = join(projectRoot, 'experiments', experiment, 'patches');
        return existsSync(folder) ? readdirSync(folder) : [];
      })
      .filter((name) => name !== patchFile);
    expect(own).toBeGreaterThan(0);
    expect([...shippedNames, ...parkedNames].map(sequenceNumber)).not.toContain(own);

    // Shipped ahead of a lower-numbered patch that is still parked, this one
    // would have that one land in the middle of an applied order later.
    // Graduate them together or in the order of their numbers.
    if (shipped) {
      expect(parkedNames.map(sequenceNumber).filter((number) => number < own)).toEqual([]);
    }

    // This patch is cut against the file as expo-video ships it. A shipped
    // patch that changes the same file means this one has to be cut again, on
    // top of it.
    const shippedForExpoVideo = shippedNames.filter((name) => name.startsWith('expo-video+55.0.21'));
    expect(shippedForExpoVideo.length).toBeGreaterThan(0);
    expect(shippedForExpoVideo.filter((name) => read(join('patches', name)).includes(`a/${activityFile} `))).toEqual([]);
  });

  it('is compiled at all: the module is built from source on Android', () => {
    // Expo's Android modules are linked as prebuilt archives, and a patch to
    // the Kotlin of one is then ignored without a word. Either of these makes
    // the build compile the module instead.
    const listed = JSON.parse(read('package.json')).expo?.autolinking?.android?.buildFromSource?.includes('expo-video') === true;
    const publicationDropped = read(lightPlayerPatch).includes('\n-    "publication": {\n');
    expect(listed || publicationDropped).toBe(true);
  });

  it('stops a clip that means to play, not only one that is playing', () => {
    expect(removed).toEqual(['      wasAutoPaused = videoPlayer?.player?.isPlaying == true']);
    expect(added.filter((line) => !isComment(line))).toEqual(['      wasAutoPaused = videoPlayer?.player?.playWhenReady == true']);
  });

  it('leaves the rest of the way out, and of picture-in-picture, as expo-video has it', () => {
    // Still only when the clip is not meant to go on in the background and the
    // activity is not closing; still by hiding the controls and pausing.
    expect(kept).toContain('    if (videoPlayer?.staysActiveInBackground != true && !didFinish) {');
    expect(kept).toContain('      if (wasAutoPaused) {');
    expect(kept).toContain('        playerView.useController = false');
    expect(kept).toContain('        videoPlayer?.player?.pause()');

    // `wasAutoPaused` keeps its one reader: a clip stopped on the way out is
    // started again if the way out turns out to be into picture-in-picture.
    // The patch must not reach that method (it has a single hunk, above) or
    // name the flag anywhere but in the line it changes.
    expect(added.filter((line) => !isComment(line) && line.includes('wasAutoPaused'))).toHaveLength(1);
    expect(added.some((line) => line.includes('onPictureInPictureModeChanged'))).toBe(false);
  });

  it('keeps the two-second rule in the preview hook until updates reach only builds that carry the patch', () => {
    // The preview hook lets a clip keep its request to play while its own
    // fullscreen player is in front (`behindFullscreen`). On a build without
    // this patch that is what lets a waiting clip start behind the launcher,
    // so the hook does not let a clip that has waited long there start by
    // itself (`LONG_WAIT_MS`). That rule costs a press after a long stall even
    // when the person is still watching. It can go, with the tests the README
    // lists, once the Android build that updates reach was cut with the patch
    // in patches/.
    //
    // Both names come with "Let a preview clip play in Android's fullscreen
    // player". Until that change is on main the hook has neither, a clip
    // cannot play in the fullscreen player at all, and this has nothing to
    // hold.
    const hook = read(previewHook);
    const androidTarget = JSON.parse(read('ota-targets.json')).targets.android;
    const reachedBuildCarriesIt = shipped && androidBuildsWithThePatch.includes(androidTarget.fingerprint);
    if (hook.includes('behindFullscreen') && !reachedBuildCarriesIt) {
      expect(hook).toContain('LONG_WAIT_MS');
    }
  });
});
