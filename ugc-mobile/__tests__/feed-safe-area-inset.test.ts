import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(path: string) {
  return readFileSync(join(__dirname, '..', path), 'utf8');
}

const FULL_BLEED_FEEDS = [
  ['Home', 'components/home-dashboard.tsx', 'paddingTop: topInset,'],
  ['Showcase', 'app/(tabs)/showcase.tsx', 'paddingTop: topInset + 12,'],
  ['Alerts', 'app/(tabs)/studio.tsx', 'paddingTop: topInset + 18,'],
  ['Profile', 'components/profile-dashboard.tsx', 'paddingTop: topInset + 12,'],
] as const;

// Padding the screen wrapper shrinks the scroll viewport, so content can never
// travel under the status bar. Padding the content container keeps the list
// full-screen and starts content in the same place, which is what lets a feed
// bleed as it scrolls. Home, Alerts and Profile all shipped the wrapper form
// once; pin the shape so they do not drift back.
describe('feed safe-area inset placement', () => {
  it.each(FULL_BLEED_FEEDS)('keeps the %s inset inside the scrollable content', (_, path, inset) => {
    const source = readSource(path);

    expect(source).toContain('contentInsetAdjustmentBehavior="never"');
    expect(source).toContain(inset);
    // The wrapper must not re-inset the screen, or the viewport shrinks again.
    expect(source).not.toContain('background, paddingTop: topInset }}>');
  });

  it.each(FULL_BLEED_FEEDS)('covers the %s status-bar strip with the shared scrim', (_, path) => {
    const source = readSource(path);

    expect(source).toContain('<TopScrim topInset={topInset} />');
    expect(source).toContain("import { TopScrim } from '@/components/top-scrim'");
  });

  // The scrim is absolutely positioned, so a sibling rendered after it paints
  // underneath. Appending it last would drag a dark band across the top of any
  // open sheet.
  it.each([
    ['Home', 'components/home-dashboard.tsx'],
    ['Showcase', 'app/(tabs)/showcase.tsx'],
  ])('renders the %s scrim before its sheets', (_, path) => {
    const source = readSource(path);

    expect(source.indexOf('<TopScrim')).toBeLessThan(source.indexOf('<FeedFeedbackSheet'));
  });
});
