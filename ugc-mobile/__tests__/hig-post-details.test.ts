import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildGenerationStats } from '../lib/post-details-view-model';
import { TITLE_MAX_LENGTH } from '../lib/post-new-view-model';

/**
 * S12's rules, in the form a suite can hold. Sources: Feedback, Loading, Text
 * views, Labels, Image views, Gestures, Page controls — plus the app's own
 * older rule that a spend says its price, which S9 set and this surface broke.
 */

const mobileRoot = path.resolve(__dirname, '..');
const read = (name: string) => readFileSync(path.join(mobileRoot, name), 'utf8');

const postRoute = read('app/post/[id].tsx');
const detailsPage = read('components/post-details-page.tsx');
const bundleContent = read('components/post-resource-bundle-content.tsx');
const clipboard = read('lib/copy-to-clipboard.ts');
const ui = read('components/ui.tsx');

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

const appSources = ['app', 'components'].flatMap((root) => sourceFiles(path.join(mobileRoot, root)));

describe('the post that cannot load', () => {
  /**
   * This route is the canonical resolver for a shared link, so it is where a
   * deleted or private post lands. It used to answer with one grey sentence on
   * a black screen: no chrome, no retry, and — since the arrow lived in the
   * loaded branch only — nothing visible to press to leave.
   */
  it('keeps the way off the screen in the states that show no post', () => {
    const emptyBranch = postRoute.slice(postRoute.indexOf('if (!item) {'), postRoute.indexOf('// This route is the canonical post resolver'));
    expect(emptyBranch).toContain('<BackControl topInset={topInset} />');
    expect(emptyBranch).toContain('<ActivityIndicator');
  });

  it('says what happened and offers the retry it already had in hand', () => {
    expect(postRoute).toContain("This post isn&apos;t available");
    expect(postRoute).toContain('accessibilityLabel="Try again"');
    expect(postRoute).toContain('onPress={() => void refetchPost()}');
  });

  it('draws one back control for every state rather than one per branch', () => {
    expect(postRoute.match(/accessibilityLabel="Go back"/g)).toHaveLength(1);
  });

  /**
   * A cold launch from a shared link can leave nothing behind this screen, and
   * `router.back()` on an empty stack does nothing — the one visible exit would
   * answer a press by not moving. Same fallback the viewer settled on.
   */
  it('has somewhere to go when there is nothing to go back to', () => {
    const leave = postRoute.slice(postRoute.indexOf('function leavePost'), postRoute.indexOf('function BackControl'));
    expect(leave).toContain('router.canGoBack()');
    expect(leave).toContain("router.replace('/(tabs)/showcase'");
    // Every exit from the screen goes through it, deletion included.
    expect(postRoute).not.toMatch(/=> router\.back\(\)/);
  });
});

describe('reading order on the text post', () => {
  /**
   * VoiceOver reads a screen in view-hierarchy order. Appended after the pager,
   * the floating arrow — the screen's only visible exit — came after the post
   * and every one of its comments. It leads the tree now and stays on top by
   * z-order rather than by being drawn last.
   */
  it('puts the back control ahead of the pager it floats over', () => {
    expect(postRoute.indexOf('{onDetailsPage ? null : <BackControl')).toBeGreaterThan(-1);
    expect(postRoute.indexOf('{onDetailsPage ? null : <BackControl'))
      .toBeLessThan(postRoute.indexOf('<FlatList\n'));
  });

  it('keeps it painted over the pager', () => {
    const control = postRoute.slice(postRoute.indexOf('function BackControl'));
    expect(control).toContain("position: 'absolute'");
    expect(control).toContain('zIndex: 2');
  });
});

describe('copying says that it copied', () => {
  /**
   * HIG Feedback: feedback reaches more people when it arrives on more than one
   * channel — "whether they silence their device, look away from the screen, or
   * use VoiceOver". The app had four copy controls and four answers; the
   * invite screen's was the only complete one.
   */
  it('sends every copy through the one helper', () => {
    const strays = appSources
      .filter((filePath) => readFileSync(filePath, 'utf8').includes('Clipboard.setStringAsync'))
      .map((filePath) => path.relative(mobileRoot, filePath).replaceAll(path.sep, '/'));

    expect(strays).toEqual([]);
  });

  it('reaches touch, sound and the screen reader in that helper', () => {
    expect(clipboard).toContain('Clipboard.setStringAsync(text)');
    expect(clipboard).toContain('Haptics.selectionAsync()');
    expect(clipboard).toContain('AccessibilityInfo.announceForAccessibility?.(announcement)');
  });

  it('gives the pill a visible result to wear', () => {
    expect(bundleContent).toContain('showConfirmed ? confirmLabel : label');
    expect(bundleContent).toContain('accessibilityLabel={showConfirmed ? confirmLabel : label}');
    expect(bundleContent).toContain('showConfirmed ? <Check');
  });

  it('asks for that result at every copy control', () => {
    // Closes on its own line: a lazy match to the first `/>` would stop
    // inside the `icon={<Copy … />}` prop.
    const openTag = /<ResourceAction[\s\S]*?\n\s*\/>/g;
    const copyControls = [...bundleContent.matchAll(openTag), ...detailsPage.matchAll(openTag)]
      .map(([tag]) => tag)
      .filter((tag) => tag.includes('label="Copy"'));

    expect(copyControls).toHaveLength(2);
    for (const tag of copyControls) expect(tag).toContain('confirmLabel="Copied"');
  });

  it('lets the confirmation clear itself, and drops the timer with the pill', () => {
    expect(bundleContent).toContain('const CONFIRM_MS = 1800');
    expect(bundleContent).toContain('clearTimeout(confirmTimer.current)');
  });
});

describe('what a creation cost', () => {
  const video = { model: 'Seedance 2.0', duration: 8, cost: 285 };

  /**
   * The page showed the model and then the duration *or* the cost, so a video —
   * which always has a duration, and is the expensive kind — never said what it
   * cost. Studio calls the same number "285 credits" two screens away.
   */
  it('shows a video its cost as well as its length', () => {
    expect(buildGenerationStats(video)).toEqual([
      { label: 'Model', value: 'Seedance 2.0' },
      { label: 'Duration', value: '8s' },
      { label: 'Cost', value: '285 credits' },
    ]);
  });

  it('spells the cost the way the rest of the app spells it', () => {
    expect(buildGenerationStats({ model: 'GPT Image 2', duration: null, cost: 1 })[1])
      .toEqual({ label: 'Cost', value: '1 credit' });
    expect(buildGenerationStats({ model: 'GPT Image 2', duration: null, cost: 26863 })[1].value)
      .toMatch(/^[\d,]+ credits$/);
  });

  it('leaves out a fact it does not have, the way the meta line leaves out a zero', () => {
    expect(buildGenerationStats({ model: 'GPT Image 2', duration: 0, cost: 0 }))
      .toEqual([{ label: 'Model', value: 'GPT Image 2' }]);
    expect(buildGenerationStats(null)).toEqual([]);
    expect(buildGenerationStats({ model: '  ', duration: null, cost: null })).toEqual([]);
  });

  it('renders whatever the model produced instead of choosing between two', () => {
    expect(detailsPage).toContain('generationStats.map((stat)');
    expect(detailsPage).not.toContain("generationInfo.duration ? 'Duration' : 'Cost'");
  });

  it('wraps the tiles rather than squeezing three into a phone', () => {
    const stat = detailsPage.slice(detailsPage.indexOf('function DetailStat'));
    expect(stat).toContain('flexBasis: 148');
    expect(detailsPage).toContain("flexDirection: 'row', flexWrap: 'wrap', gap: 10");
  });
});

describe('a title that names the thing', () => {
  /**
   * Layout: "don't obscure [the most important information] by crowding it with
   * nonessential details ... you can make secondary information available in
   * other parts of the window". A creation whose title is its whole prompt set
   * fifteen lines of display type above the creator, the facts and every
   * action — and printed the same text again, in full, one section below.
   */
  it('bounds the details title above any real one', () => {
    expect(detailsPage).toContain('const DETAILS_TITLE_MAX_LINES = 6');
    expect(detailsPage).toContain('numberOfLines={DETAILS_TITLE_MAX_LINES}');
    // A composed title cannot exceed 100 characters, which is fewer lines than
    // the bound — so the bound only ever catches a prompt wearing the slot.
    expect(TITLE_MAX_LENGTH).toBeLessThanOrEqual(100);
  });

  it("sets one title one way across the screen's two pages", () => {
    expect(postRoute).toContain('...appTheme.type.pageTitle');
    expect(postRoute).not.toContain('fontSize: 25');
  });
});

describe('what the surface shows while it waits', () => {
  /**
   * HIG Images asks a placeholder to stand in while content loads. The avatar
   * drew its initial only when there was no photo, so a cold page showed an
   * empty disc where a face was about to appear.
   */
  it('draws the avatar initial whether or not a photo is coming', () => {
    const avatar = ui.slice(ui.indexOf('export function CreatorAvatar'));
    expect(avatar.indexOf('{initial}')).toBeLessThan(avatar.indexOf('{uri ?'));
  });
});

describe('text worth taking away is selectable', () => {
  /**
   * Text views and Labels both ask for it: "if a label contains useful
   * information ... consider letting people select and copy it".
   */
  it('lets the reader select the post, the prompt and the caption', () => {
    expect(postRoute).toContain('<Text selectable');
    expect(detailsPage).toContain('<Text selectable style={{ color: appTheme.colors.textSecondary, ...appTheme.type.bodySm }}>{text}</Text>');
  });
});
