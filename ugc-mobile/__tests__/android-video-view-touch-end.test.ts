import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '..');
const patchFile = 'expo-video+55.0.21+005+android-video-view-touch-end.patch';
const parkedAt = join('experiments/android-video-view-touch-end/patches', patchFile);
const shippedAt = join('patches', patchFile);
const lightPlayerPatch = 'patches/expo-video+55.0.21+002+android-light-player-view.patch';
const viewFile = 'node_modules/expo-video/android/src/main/java/expo/modules/video/VideoView.kt';

/**
 * On Android, expo-video's view tells JS of the touches on a player with
 * native controls from `onInterceptTouchEvent`. The controls' time bar asks
 * its parents not to intercept as a touch lands on it, the view records that
 * request like any other view group, and Android then stops calling the hook
 * for the rest of the gesture: JS hears the touch start and never its end.
 * Whatever JS view took that start stays React's responder and the next press
 * is lost once.
 *
 * The app keeps every JS view it can from taking such a touch
 * (`lib/native-touch-owner.ts`). A view that takes the start question in the
 * capture phase is asked before the player's view, so that cannot cover it: a
 * `ScrollView` does while it is coasting, and one left at the default
 * `keyboardShouldPersistTaps` does while the keyboard is up.
 *
 * The patch ends it where it starts: the view passes the request on to the
 * views above without recording it, as React Native's own root views do, so
 * its hook goes on being called and JS hears the whole touch. It is Kotlin,
 * so it moves the Android fingerprint and can only ship in a store build:
 * until one is cut it waits in `experiments/android-video-view-touch-end/`,
 * where `postinstall` does not apply it (see that folder's README).
 */
describe('Android video view touch end', () => {
  const read = (relativePath: string) => readFileSync(join(projectRoot, relativePath), 'utf8');
  const shipped = existsSync(join(projectRoot, shippedAt));
  const parked = existsSync(join(projectRoot, parkedAt));
  const lines = read(shipped ? shippedAt : parkedAt).split('\n');
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1));
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---'));

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

  it('touches the video view and nothing else', () => {
    expect(lines.filter((line) => line.startsWith('diff --git '))).toEqual([`diff --git a/${viewFile} b/${viewFile}`]);
    expect(removed).toEqual([]);
  });

  it('applies after every other patch that changes the video view, on the file the last of them leaves', () => {
    // patch-package applies a package's patches in the order of the number in
    // their names, and this one is cut against what the others leave of this
    // one file. A patch that changes other files of the package may carry any
    // number, a later one included: one for the fullscreen activity was parked
    // as `+006+` for the same store build.
    const number = (name: string) => Number(name.split('+')[2]);
    const header = `diff --git a/${viewFile} b/${viewFile}`;
    const others = readdirSync(join(projectRoot, 'patches'))
      .filter((name) => name.startsWith('expo-video+55.0.21+') && name !== patchFile)
      .filter((name) => read(join('patches', name)).split('\n').includes(header))
      .sort((one, other) => number(one) - number(other));
    const last = others[others.length - 1];
    expect(last).toBe(lightPlayerPatch.slice('patches/'.length));
    expect(number(last)).toBeLessThan(number(patchFile));

    // Each file in a patch names the blob it starts from and the one it
    // makes: this patch starts from the blob the last of the others makes.
    const blobs = (patch: string[]) => /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(patch[patch.indexOf(header) + 1] ?? '')?.slice(1, 3);
    const [, leftByTheLast] = blobs(read(join('patches', last)).split('\n')) ?? [];
    const [startsFrom] = blobs(lines) ?? [];
    expect(leftByTheLast).toBeTruthy();
    expect(startsFrom).toBe(leftByTheLast);
  });

  it('is compiled at all: the module is built from source on Android', () => {
    // Expo's Android modules are linked as prebuilt archives, and a patch to
    // the Kotlin of one is then ignored without a word. Either of these makes
    // the build compile the module instead.
    const listed = JSON.parse(read('package.json')).expo?.autolinking?.android?.buildFromSource?.includes('expo-video') === true;
    const publicationDropped = read(lightPlayerPatch).includes('\n-    "publication": {\n');
    expect(listed || publicationDropped).toBe(true);
  });

  it('passes the request on to the views above and never records it on the view', () => {
    expect(added).toContain('  override fun requestDisallowInterceptTouchEvent(disallowIntercept: Boolean) {');
    expect(added).toContain('    parent?.requestDisallowInterceptTouchEvent(disallowIntercept)');

    // Calling through to ViewGroup would set the view's own flag, and its
    // hook would go quiet again. Dropping the request instead would let a
    // scroll view above the player take a scrub.
    expect(added.filter((line) => !line.trimStart().startsWith('//')).some((line) => line.includes('super.'))).toBe(false);
    expect(added.filter((line) => line.includes('requestDisallowInterceptTouchEvent(')).map((line) => line.trim())).toEqual([
      'override fun requestDisallowInterceptTouchEvent(disallowIntercept: Boolean) {',
      'parent?.requestDisallowInterceptTouchEvent(disallowIntercept)',
    ]);
  });
});
