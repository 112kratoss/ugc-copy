import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// The Android blur gate (lib/media-blur.ts) trusts one thing: the ExpoImage
// native module saying `softwareBlurRadius`. Only patches/expo-image+55.0.11.patch
// makes it say so, and only because the same patch swaps glide-transformations'
// RenderScript blur for a software one. These pin the two halves to each other,
// so neither can be edited into a build that blurs through RenderScript again
// while telling the app it is safe.
const root = path.join(__dirname, '..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

describe('expo-image software blur patch', () => {
  const patch = read('patches/expo-image+55.0.11.patch');

  it('replaces the RenderScript blur behind blurRadius', () => {
    expect(patch).toContain('-import jp.wasabeef.glide.transformations.BlurTransformation');
    expect(patch).toContain('-        transform(BlurTransformation(min(it, 25), 4))');
    expect(patch).toContain('+        transform(SoftwareBlurTransformation(min(it, 25), 4))');
    expect(patch).toContain('+++ b/node_modules/expo-image/android/src/main/java/expo/modules/image/SoftwareBlurTransformation.kt');
    expect(patch).toContain('import jp.wasabeef.glide.transformations.internal.FastBlur');
    expect(patch).not.toMatch(/\+.*RenderScript\.create/);
  });

  it('makes Gradle compile expo-image from this patched source instead of linking its prebuilt AAR', () => {
    // SDK 55 ships expo-image as a prebuilt artifact (local-maven-repo). With the
    // publication entry in place the Kotlin above is never compiled and the patch
    // is inert: the first local build proved it, with the wasabeef blur still in
    // the dex and no softwareBlurRadius constant.
    expect(patch).toContain('+++ b/node_modules/expo-image/expo-module.config.json');
    expect(patch).toContain('-    "publication": {');
    expect(patch).toContain('-      "repository": "local-maven-repo"');
    expect(patch).not.toMatch(/\+\s+"publication"/);
  });

  it('advertises the capability the blur gate reads, and nothing else advertises it', () => {
    expect(patch).toContain('+    Constants("softwareBlurRadius" to true)');
    expect(read('lib/media-blur.ts')).toContain("module?.softwareBlurRadius === true");
  });

  it('is set aside for iOS updates and recorded as blocking Android ones until a binary carries it', () => {
    const targets = JSON.parse(read('ota-targets.json')) as {
      targets: { ios: { setAside?: string[] }; android: { setAside?: string[]; $softwareBlurNote?: string } };
    };
    expect(targets.targets.ios.setAside).toContain('patches/expo-image+55.0.11.patch');
    expect(targets.targets.android.setAside ?? []).not.toContain('patches/expo-image+55.0.11.patch');
    expect(targets.targets.android.$softwareBlurNote).toContain('patches/expo-image+55.0.11.patch');
  });
});
