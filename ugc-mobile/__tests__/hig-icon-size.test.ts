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
 * creator screen 25→24), and by N3 when the workspace-menu control moved to one
 * shared glyph at one size (home dashboard 4→3). S5 took the showcase feed's
 * four files to zero: one `FeedMediaPlate` replaced four hand-drawn placeholder
 * circles, and the surface's remaining literals moved onto the ramp. S12 took
 * the post details surface's three files to zero the same way. S13/S14 took
 * four more: both profile surfaces, the card feed they share, and
 * `feed-card-shell`'s lone 17pt overflow glyph -- the literal S12 handed to
 * whichever unit owned the feed card next. Thirty off-ramp sizes retired in one
 * unit, the largest drop so far; it leaves the composer's 21 and the home side
 * menu's 11 as the only budgets still in double figures. S15 took the edit
 * profile screen's 2 with it -- the empty cover's 26pt glyph to `icon.hero`,
 * which is what the ramp reserves for an empty state, and the cover pill's 17
 * to `icon.sm` beside its own label. S16 took settings and help to zero: the
 * account hub's nine 22s and help's three moved to `icon.feature`, and the two
 * trailing glyphs the unit added (external-link arrows) arrived on the ramp.
 */
const LEGACY_SIZES: Record<string, number> = {
  'app/(tabs)/showcase.tsx': 0,
  'app/(tabs)/studio.tsx': 0,
  'app/auth.tsx': 0,
  'app/help.tsx': 0,
  'app/invite.tsx': 5,
  'app/onboarding.tsx': 0,
  'app/post/[id].tsx': 0,
  'app/post/new.tsx': 21,
  'app/r/[code].tsx': 5,
  'app/seller-dashboard.tsx': 3,
  'app/settings.tsx': 0,
  'app/viewer.tsx': 14,
  'components/creator-profile-screen.tsx': 0,
  'components/edit-profile-screen.tsx': 0,
  'components/feed-card-shell.tsx': 0,
  'components/feed-pagination-footer.tsx': 0,
  'components/feed-video-preview.tsx': 0,
  'components/home-dashboard.tsx': 0,
  'components/home-feed-card.tsx': 0,
  'components/home-side-menu.tsx': 11,
  'components/media-creation-screen.tsx': 24,
  'components/media-lightbox.tsx': 2,
  'components/media-preview.tsx': 1,
  // 6 → 8 in S8, same cause: an aliased `OutputIcon` at 42 and `SlotIcon` at
  // 34. S19's pass ratchets them down.
  'components/media-template-screens.tsx': 8,
  'components/onboarding-booklet.tsx': 0,
  'components/onboarding-welcome.tsx': 0,
  'components/post-details-page.tsx': 0,
  'components/post-resource-references.tsx': 0,
  'components/profile-dashboard.tsx': 0,
  'components/profile-feed-card.tsx': 0,
  'components/showcase-media-preview.tsx': 0,
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

/**
 * Local names that stand in for a lucide component — `const Icon = isCreate ?
 * Sparkles : FilePlus2`, `const Icon = item.icon`, `const SlotIcon = kind ===
 * 'video' ? Video : ImageIcon`. Twelve places in the tree render an icon this
 * way, and the sweep below matches on the *tag* name, so before S8 every one of
 * them was invisible to this ratchet — it was hiding five off-ramp sizes.
 */
function aliasedIconNames(source: string, imported: Set<string>) {
  const names = new Set<string>();
  const pattern = /const\s+([A-Z][A-Za-z0-9_]*)\s*=\s*([^;\n]+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    const [, name, assignment] = match;
    if (imported.has(name)) continue;
    const fromLucide = [...imported].some((icon) => new RegExp(`\\b${icon}\\b`).test(assignment));
    // `.icon`/`.Icon` catches the indirection through a data table, where the
    // component never appears by name at the assignment at all.
    if (fromLucide || /\.(icon|Icon)\b/.test(assignment)) names.add(name);
  }

  return names;
}

function offRampSizes(source: string) {
  const imported = lucideNames(source);
  const names = new Set([...imported, ...aliasedIconNames(source, imported)]);
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

  it('sees an icon rendered through a local alias', () => {
    // The idiom this sweep was blind to until S8 — twelve places in the tree,
    // hiding five off-ramp sizes.
    const ternary = "import { Sparkles, FilePlus2 } from 'lucide-react-native';\nconst Icon = isCreate ? Sparkles : FilePlus2;\nconst a = <Icon size={26} />;";
    expect(offRampSizes(ternary)).toEqual([26]);
    const table = "import { Heart } from 'lucide-react-native';\nconst Icon = item.icon;\nconst a = <Icon size={21} />;";
    expect(offRampSizes(table)).toEqual([21]);
  });

  it('does not treat an aliased icon on the ramp as a violation', () => {
    const source = "import { Sparkles, FilePlus2 } from 'lucide-react-native';\nconst Icon = isCreate ? Sparkles : FilePlus2;\nconst a = <Icon size={24} />;";
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
