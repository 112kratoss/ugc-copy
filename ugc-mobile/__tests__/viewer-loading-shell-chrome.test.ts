import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A reel whose first load outlives the zoom shows the tile's picture while the
 * window loads (`ViewerShell`). Filmed 2026-09-27: the rail and caption then
 * arrived 0.58 s after the open began. The shell now draws them from the post
 * the tile handed over (`peekOpeningPost`), with the reel's own renderer for a
 * post in flight (`ZoomPostChrome`), so nothing on screen moves when the slide
 * replaces it. A source guard, as `post-details-navigation.test.ts` is: the
 * viewer screen does not render under vitest.
 */
describe('the reel loading shell', () => {
  const viewer = readFileSync('app/viewer.tsx', 'utf8');

  const shell = viewer.slice(viewer.indexOf('function ViewerShell('), viewer.indexOf('function leaveViewer('));
  const chromeAt = shell.indexOf('<ZoomPostChrome post={chromePost} controls={false} />');

  it('draws the opening post\'s rail and caption while the first load runs', () => {
    expect(viewer).toContain('const [openingPost] = useState(() => peekOpeningPost(initialId, Date.now()));');
    expect(viewer).toContain('preview={openingPreview} video={zoom.lentVideo} post={openingPost}>');
    expect(shell).toContain('const chromePost = preview ? post : null;');
    expect(chromeAt).toBeGreaterThan(-1);
  });

  it('answers no taps on that chrome: the slide that replaces it does', () => {
    const wrapper = shell.slice(shell.indexOf('{chromePost ? ('), chromeAt);
    expect(wrapper).toContain('pointerEvents="none"');
  });

  it('draws the reel\'s own working Back and sound controls over it, not the inert copies', () => {
    const back = shell.indexOf('<ViewerTopControl label="Go back" onPress={leaveViewer}');
    const sound = shell.indexOf('toggleViewerAudioMuted();');
    expect(back).toBeGreaterThan(chromeAt);
    expect(sound).toBeGreaterThan(chromeAt);
    expect(shell).toContain('{chromePost && hasImmersiveAudibleMedia(chromePost) ? (');
  });
});

describe('the post chrome drawn in a window', () => {
  const chrome = readFileSync('components/zoom-post-chrome.tsx', 'utf8');

  it('leaves out its inert Back and sound controls when asked to', () => {
    expect(chrome).toContain('export function ZoomPostChrome({ post, controls = true }');
    expect(chrome).toContain('{controls ? (');
    expect(chrome).toContain('{controls && hasImmersiveAudibleMedia(post) ? (');
  });
});
