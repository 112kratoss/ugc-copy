import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { appTheme } from '../lib/theme';

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

const files = ['app', 'components', 'lib'].flatMap((root) => sourceFiles(path.join(mobileRoot, root)));

/**
 * Apple's Icons chapter asks for "a consistent size ... across all interface
 * icons in your app". This app arrived at 25 distinct icon sizes between 11 and
 * 44pt, so the ramp in `appTheme.icon` is being adopted rather than imposed: the
 * sizes already in the tree are recorded below as each file's budget, and the
 * ratchet only turns one way. A new off-ramp size in any file pushes it over
 * budget and fails; snapping a screen to the ramp during its Phase 3 pass drops
 * the count, and that file's entry comes down with it.
 */
const ICON_RAMP = new Set<number>([
  appTheme.icon.xs,
  appTheme.icon.sm,
  appTheme.icon.compact,
  appTheme.icon.default,
  appTheme.icon.feature,
  appTheme.icon.hero,
]);

/**
 * Off-ramp icon sizes each file still carries. Seeded by the F4 pass on
 * 2026-08-27; ratcheted down by N1 the same day, when the back controls on
 * seven screens moved to `BackGlyph` at `appTheme.icon.feature` and stopped
 * being counted here at 20/21/22/26/30; and again by N2, when the Close
 * controls on eleven modal surfaces moved to `CloseGlyph` at the same size
 * (create menu 1→0, home side menu 12→11, unlock prompt 3→2, composer 22→21,
 * creator screen 25→24).
 */
const LEGACY_SIZES: Record<string, number> = {
  'app/(tabs)/showcase.tsx': 3,
  'app/(tabs)/studio.tsx': 2,
  'app/auth.tsx': 3,
  'app/help.tsx': 3,
  'app/invite.tsx': 5,
  'app/onboarding.tsx': 1,
  'app/post/[id].tsx': 4,
  'app/post/new.tsx': 21,
  'app/r/[code].tsx': 5,
  'app/seller-dashboard.tsx': 3,
  'app/settings.tsx': 9,
  'app/viewer.tsx': 14,
  'components/creator-profile-screen.tsx': 11,
  'components/edit-profile-screen.tsx': 2,
  'components/feed-card-shell.tsx': 1,
  'components/feed-pagination-footer.tsx': 1,
  'components/feed-video-preview.tsx': 1,
  'components/home-dashboard.tsx': 4,
  'components/home-feed-card.tsx': 2,
  'components/home-side-menu.tsx': 11,
  'components/media-creation-screen.tsx': 24,
  'components/media-lightbox.tsx': 2,
  'components/media-preview.tsx': 1,
  'components/media-template-screens.tsx': 6,
  'components/onboarding-booklet.tsx': 2,
  'components/onboarding-welcome.tsx': 1,
  'components/post-details-page.tsx': 2,
  'components/post-resource-references.tsx': 3,
  'components/profile-dashboard.tsx': 12,
  'components/profile-feed-card.tsx': 6,
  'components/showcase-media-preview.tsx': 2,
  'components/unlock-remix-prompt.tsx': 2,
};

/** Names imported from lucide-react-native here, aliases resolved to the local name. */
function lucideNames(source: string) {
  const names = new Set<string>();
  // `[^}]*` keeps each match inside one import statement — a lazy `[\s\S]*?`
  // would run from the file's first `import {` through every other import
  // until it reached lucide's closing brace, and collect the lot.
  const pattern = /import\s+\{([^}]*)\}\s+from\s+'lucide-react-native'/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    for (const specifier of match[1].split(',')) {
      const name = specifier.trim().replace(/^type\s+/, '');
      if (!name || name === 'LucideProvider') continue;
      const [imported, alias] = name.split(/\s+as\s+/);
      names.add((alias ?? imported).trim());
    }
  }

  return names;
}

function offRampSizes(source: string) {
  const names = lucideNames(source);
  const found: number[] = [];

  for (const name of names) {
    const pattern = new RegExp(`<${name}(?=[\\s/>])`, 'g');
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(source))) {
      // Walk to the `>` that closes this opening tag, ignoring any inside a
      // prop's braces or parens.
      let depth = 0;
      let end = -1;
      for (let index = match.index; index < source.length; index += 1) {
        const character = source[index];
        if (character === '{' || character === '(') depth += 1;
        else if (character === '}' || character === ')') depth -= 1;
        else if (character === '>' && depth === 0) { end = index; break; }
      }
      if (end === -1) continue;

      const size = source.slice(match.index, end + 1).match(/size=\{\s*(\d+)\s*\}/);
      if (size && !ICON_RAMP.has(Number(size[1]))) found.push(Number(size[1]));
    }
  }

  return found;
}

describe('HIG icon sizes — one ramp, adopted by ratchet', () => {
  it('exposes a ramp that steps with the type ramp', () => {
    expect([...ICON_RAMP].sort((a, b) => a - b)).toEqual([14, 16, 18, 20, 24, 32]);
  });

  it('sees an off-ramp size on a lucide icon', () => {
    const source = "import { Heart } from 'lucide-react-native';\nconst a = <Heart size={19} />;";
    expect(offRampSizes(source)).toEqual([19]);
  });

  it('leaves a size that is on the ramp alone', () => {
    const source = "import { Heart } from 'lucide-react-native';\nconst a = <Heart size={20} />;";
    expect(offRampSizes(source)).toEqual([]);
  });

  it('does not mistake a same-named component from elsewhere for an icon', () => {
    const source = "import { Heart } from './not-lucide';\nconst a = <Heart size={19} />;";
    expect(offRampSizes(source)).toEqual([]);
  });

  it('lets no file carry more off-ramp icon sizes than it already did', () => {
    const over = files.flatMap((filePath) => {
      const relativePath = path.relative(mobileRoot, filePath).replaceAll(path.sep, '/');
      const count = offRampSizes(readFileSync(filePath, 'utf8')).length;
      const allowed = LEGACY_SIZES[relativePath] ?? 0;
      return count > allowed ? [`${relativePath}: ${count} off-ramp sizes, budget ${allowed}`] : [];
    });

    expect(over).toEqual([]);
  });
});
