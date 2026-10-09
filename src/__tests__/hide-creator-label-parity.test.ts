import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import contract from '../../contracts/hide-creator-label-v1.json';
import { hideCreatorLabel } from '../lib/hide-creator-label';

// The row that hides a creator read four ways on 2026-10-09: "Hide Fluffy" on
// the web, "Hide fluffy" on the app's Home, "Hide @fluffy" on its Explore and
// "Hide this creator" in its reel. It is one wording now, worked out by one
// rule on each side of the repository. Web and app share no module (this suite
// cannot even load an app file: the web workspace never installs the app's
// dependencies, which its tsconfig needs), so both suites answer the same
// contract: this one for the web's rule, `ugc-mobile/__tests__/native-menu.test.ts`
// for the app's.
describe('the Hide row, on the web and in the app', () => {
  it.each(contract.cases)('words $creator as "$label" on the web', ({ creator, label }) => {
    expect(hideCreatorLabel(creator)).toBe(label);
  });

  it('is asked the same cases by the app', () => {
    const appTest = readFileSync('ugc-mobile/__tests__/native-menu.test.ts', 'utf8');

    expect(appTest).toContain("from '../../contracts/hide-creator-label-v1.json'");
    expect(appTest).toContain('it.each(hideCreatorLabelContract.cases)');
  });

  // The rule is only as good as its callers: each menu hands it the post's creator.
  it.each([
    'src/app/feed/FeedPostCard.tsx',
    'src/app/showcase/ShowcaseClient.tsx',
    'src/app/showcase/ShowcaseReelViewer.tsx',
  ])("gives the web menu in %s the post's creator", (file) => {
    expect(readFileSync(file, 'utf8')).toContain('creator={item.creator}');
  });

  it('is the only wording of that row in either menu', () => {
    const web = readFileSync('src/app/showcase/ShowcaseFeedInteraction.tsx', 'utf8');
    const appCard = readFileSync('ugc-mobile/lib/feed-feedback-menu.ts', 'utf8');
    const appSheet = readFileSync('ugc-mobile/components/feed-feedback-sheet.tsx', 'utf8');

    expect(web).toContain('label: hideCreatorLabel(creator),');
    expect(appCard).toContain('label: hideCreatorLabel(creator),');
    expect(appSheet).toContain('label={hideLabel}');
    // No row is labelled by a template of its own (a sentence may still begin with the word).
    for (const source of [web, appCard, appSheet]) expect(source).not.toMatch(/label[:=]\s*\{?`Hide \$\{/);
  });
});
