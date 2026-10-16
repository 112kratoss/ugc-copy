import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// A reel swipe used to re-render every mounted slide: renderItem built new
// closures for each slide and the slide was not memoised (measured 2026-10-16,
// 14-18 slide renders per swipe). The slide is memoised and takes one stable set
// of item-taking handlers; these pins keep the inline closures from coming back.
const source = readFileSync(path.join(__dirname, '..', 'app', 'viewer.tsx'), 'utf8');
const start = source.indexOf('renderItem={({ item, index }) => (');
const end = source.indexOf('scrollEnabled={!overlayOpenItemId', start);
const renderItem = source.slice(start, end);

describe('reel slide rendering', () => {
  it('reads the reel list item renderer', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it('memoises the slide', () => {
    expect(source).toContain('const ImmersiveSlide = memo(function ImmersiveSlide({');
  });

  it('hands every slide the same handler functions', () => {
    for (const name of [
      'onActionsOpen', 'onComments', 'onCreatorOpen', 'onOwnerAction', 'onPageChange',
      'onRecreate', 'onSave', 'onShare', 'onUnlockRemix',
    ]) {
      expect(renderItem).toContain(`${name}={slideHandlers.${name}}`);
    }
    // No handler prop built inline per slide (`onX={() => …}` or `onX={(a) => …}`).
    expect(renderItem).not.toMatch(/\bon[A-Z]\w*=\{\(?[\w, ]*\)?\s*=>/);
  });

  it('gives the playing video id only to the slide that owns it', () => {
    expect(renderItem).toContain('activeVideoId={activeVideoId === item.id ? activeVideoId : null}');
  });
});
