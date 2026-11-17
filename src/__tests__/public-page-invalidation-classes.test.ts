import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every write that invalidates a cached feed or public page, by file and by
 * kind, so that a new one is classified before it ships (owner, 2026-11-17:
 * "refresh only the pages that show them, and in the background"; removals
 * stay an instant wipe of everything).
 *
 * The kinds are the helpers of `showcase-feed-cache.ts` and
 * `marketplace-resource-list-cache.ts`:
 *
 * - `invalidateShowcaseFeedCache`: a removal, the feeds and every public page
 *   at once (and the operator's lever);
 * - `invalidateShowcaseFeedAndRefreshPostPages`: a change to one post that
 *   removes nothing, the feeds at once and the pages that draw the post in
 *   the background;
 * - `invalidateShowcaseFeedAndRefreshEveryPage`: a change whose pages cannot
 *   be named, the feeds at once and every public page in the background;
 * - `invalidateShowcaseFeedCacheOnly`: the feeds alone;
 * - `invalidateMarketplaceResourceListCache`: the storefront in the
 *   background (a sale, a free unlock).
 *
 * Next's own `revalidateTag`, `revalidatePath` and `updateTag` are used by
 * those two modules alone, where each tag keeps one profile
 * (`PUBLIC_PAGE_CACHE_TAG` says why).
 *
 * A use is a reference in code: a call, or the helper handed on as a
 * default or a dependency (`invalidateFeedCache = invalidateShowcaseFeedCache`),
 * counted wherever its name is an expression; imports, types and comments are
 * not. A file whose uses change fails here until its row is brought up to
 * date, with what the new use is for.
 */

const HELPERS = [
  'revalidateTag',
  'revalidatePath',
  'updateTag',
  'invalidateShowcaseFeedCache',
  'invalidateShowcaseFeedAndRefreshPostPages',
  'invalidateShowcaseFeedAndRefreshEveryPage',
  'invalidateShowcaseFeedCacheOnly',
  'invalidateMarketplaceResourceListCache',
] as const;
type Helper = typeof HELPERS[number];

type Classified = {
  uses: Partial<Record<Helper, number>>;
  /** What each use is: the change it follows and the class it is in. */
  why: string;
};

const CLASSIFIED: Record<string, Classified> = {
  // The helpers themselves.
  'src/lib/showcase-feed-cache.ts': {
    uses: { revalidateTag: 15 },
    why: 'the four kinds: a removal (the feed and the removal tag at once: 2), the feed alone (1), one post\'s pages (the feed at once; its own and its legacy address, its creator, the storefront, its remixes and their creators in the background; its arrival at once; every page when its remixes cannot be named: 8), every page (the feed at once, the background tag, a post\'s or a handle\'s arrival at once: 4)',
  },
  'src/lib/marketplace-resource-list-cache.ts': {
    uses: { revalidateTag: 1 },
    why: 'a sale or a free unlock: the storefront in the background',
  },

  // Removals: the feeds and every public page at once.
  'src/lib/account-deletion-route-adapter-service.ts': {
    uses: { invalidateShowcaseFeedCache: 5 },
    why: 'removal: an account deletion, when it starts (the creator page reads the account as gone), when its sweep ends, and when it was already deleted (the dependency, its default and those three calls)',
  },
  'src/lib/backend-job-executions.ts': {
    uses: { invalidateShowcaseFeedCache: 1 },
    why: 'removal: the account-deletion resweep, which can cascade posts after the request that started it',
  },
  'src/lib/generation-delete-service.ts': {
    uses: { invalidateShowcaseFeedCache: 1 },
    why: 'removal: a creation deleted, with the posts made from it (wiring: the dependency\'s default)',
  },
  'src/lib/post-delete-service.ts': {
    uses: { invalidateShowcaseFeedCache: 2 },
    why: 'removal: a post deleted, or tombstoned for its buyers',
  },
  'src/lib/showcase-feed-invalidate-route-adapter-service.ts': {
    uses: { invalidateShowcaseFeedCache: 2 },
    why: 'removal and the operator\'s lever: the moderation CLI after a take-down or a dismissal, and a refresh by hand (wiring: the dependency and its default)',
  },

  // Removals and changes, by what the write did.
  'src/lib/admin-moderation-service.ts': {
    uses: { invalidateShowcaseFeedCache: 3, invalidateShowcaseFeedAndRefreshEveryPage: 1 },
    why: 'removal: a report taken down, a post hidden or taken down, and any action that failed after it may have committed; change: a post restored (its not-found at once, every page in the background, as the console does not know its creator)',
  },
  'src/lib/post-lifecycle-service.ts': {
    uses: { invalidateShowcaseFeedCache: 1, invalidateShowcaseFeedAndRefreshPostPages: 1 },
    why: 'removal: an archive; change: a restore, with its arrival',
  },
  'src/lib/post-update-service.ts': {
    uses: { invalidateShowcaseFeedCache: 1, invalidateShowcaseFeedAndRefreshPostPages: 1 },
    why: 'removal or change, by classifyPostPageChange: private, public to unlisted or the mature cover is a removal; any other edit a change (with its arrival from private)',
  },
  'src/lib/showcase-publish-service.ts': {
    uses: { invalidateShowcaseFeedCache: 1, invalidateShowcaseFeedAndRefreshPostPages: 1 },
    why: 'removal or change, by classifyPostPageChange: a creation\'s post saved private, unlisted from public or behind the mature cover is a removal; a publish, a move to public or an edit a change',
  },

  // Changes to one post: the feeds at once, the post's pages in the background.
  'src/lib/post-publish-service.ts': {
    uses: { invalidateShowcaseFeedAndRefreshPostPages: 1 },
    why: 'change: a new public post (its page, its creator\'s, the storefront; no remix can credit it yet)',
  },

  // Changes whose pages cannot be named: every page in the background.
  'src/lib/profile-route-service.ts': {
    uses: { invalidateShowcaseFeedAndRefreshEveryPage: 1 },
    why: 'change: a profile saved, drawn on every page of the creator\'s, on remix credits and on the storefront; a handle just taken has its not-found dropped at once (the dependency\'s default, called once a save commits)',
  },
  'src/lib/media-preview-repair.ts': {
    uses: { invalidateShowcaseFeedAndRefreshEveryPage: 3 },
    why: 'change: a repaired preview, from the one-post repair, the sweep and the poster regeneration (the sweep knows media rows, not the pages that draw them)',
  },

  // The feeds alone.
  'src/lib/feed-maintenance.ts': {
    uses: { invalidateShowcaseFeedCacheOnly: 1 },
    why: 'feeds only: the hourly totals and account labels, which no public page draws',
  },
  'src/lib/moderation-service.ts': {
    uses: { invalidateShowcaseFeedCacheOnly: 1 },
    why: 'feeds only: a block, applied by the pages in the browser',
  },
  'src/lib/post-report-service.ts': {
    uses: { invalidateShowcaseFeedCacheOnly: 1 },
    why: 'feeds only: a report, which hides nothing until a moderator decides',
  },

  // A sale or a free unlock: the storefront in the background.
  'src/lib/mobile-commerce.ts': {
    uses: { invalidateMarketplaceResourceListCache: 3 },
    why: 'storefront: an in-app purchase of a recipe, by the app and by the store\'s webhook (two calls, and the hand-on from one to the other)',
  },
  'src/lib/post-resource-bundle-free-unlock-service.ts': {
    uses: { invalidateMarketplaceResourceListCache: 1 },
    why: 'storefront: a free unlock',
  },
  'src/lib/post-resource-bundle-verify-service.ts': {
    uses: { invalidateMarketplaceResourceListCache: 1 },
    why: 'storefront: a purchase verified',
  },
  'src/lib/razorpay-webhook-service.ts': {
    uses: { invalidateMarketplaceResourceListCache: 1 },
    why: 'storefront: a purchase captured by Razorpay\'s webhook',
  },
};

const ROOT = process.cwd();
const SCANNED = ['src', 'scripts'];
const TESTS = path.join(ROOT, 'src', '__tests__');

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (absolute === TESTS || entry.name === 'node_modules') continue;
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    else if (/\.(ts|tsx|mts|cts|mjs|js)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

/** Whether an identifier is a name in code, not an import, a declaration, a type or an object key. */
function isExpressionUse(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isExportSpecifier(parent)) return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)
    || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)
    || ts.isPropertyAssignment(parent) || ts.isBindingElement(parent)) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  // Inside a type: `typeof invalidateShowcaseFeedCache`, a type reference.
  for (let ancestor: ts.Node | undefined = parent; ancestor; ancestor = ancestor.parent) {
    if (ts.isTypeNode(ancestor)) return false;
  }
  return true;
}

/** Each helper's uses in one file's code, as TypeScript reads it (comments are no code). */
function usesIn(name: string, source: string): Partial<Record<Helper, number>> {
  if (!HELPERS.some((helper) => source.includes(helper))) return {};
  const kind = name.endsWith('x') ? ts.ScriptKind.TSX : /\.(ts|mts|cts)$/.test(name) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const parsed = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, kind);
  const uses: Partial<Record<Helper, number>> = {};
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && (HELPERS as readonly string[]).includes(node.text) && isExpressionUse(node)) {
      const helper = node.text as Helper;
      uses[helper] = (uses[helper] ?? 0) + 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return uses;
}

function scan(): Record<string, Partial<Record<Helper, number>>> {
  const found: Record<string, Partial<Record<Helper, number>>> = {};
  for (const directory of SCANNED) {
    for (const file of sourceFiles(path.join(ROOT, directory))) {
      const uses = usesIn(file, fs.readFileSync(file, 'utf8'));
      if (Object.keys(uses).length > 0) {
        found[path.relative(ROOT, file).split(path.sep).join('/')] = uses;
      }
    }
  }
  return found;
}

describe('every write that invalidates a cached feed or public page is classified', () => {
  it('finds each helper use the table lists, file by file, and no other', () => {
    const found = scan();
    const listed = Object.fromEntries(Object.entries(CLASSIFIED).map(([file, { uses }]) => [file, uses]));

    // A file here and not in the table invalidates without a class: add its
    // row, with what each use is for. A count that moved is a new or a gone
    // use in a file already listed: say what it is in that row's `why`.
    expect(found).toEqual(listed);
  });

  it("leaves Next's own invalidation to the two cache modules", () => {
    const direct = Object.entries(scan())
      .filter(([, uses]) => uses.revalidateTag || uses.revalidatePath || uses.updateTag)
      .map(([file]) => file)
      .sort();

    expect(direct).toEqual(['src/lib/marketplace-resource-list-cache.ts', 'src/lib/showcase-feed-cache.ts']);
  });

  it('counts calls and hand-ons, and not imports, types or comments', () => {
    const source = [
      "import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';",
      '// invalidateShowcaseFeedCache() in a comment',
      'type Dependencies = { invalidateShowcaseFeedCache?: typeof invalidateShowcaseFeedCache };',
      'export function run(dependencies: Dependencies, invalidateFeedCache = invalidateShowcaseFeedCache) {',
      '  invalidateFeedCache();',
      '  (dependencies.invalidateShowcaseFeedCache ?? invalidateShowcaseFeedCache)();',
      '  invalidateShowcaseFeedCache();',
      '  return { invalidateShowcaseFeedCache: invalidateShowcaseFeedCache };',
      '}',
    ].join('\n');

    // The default, the dependency read and its fallback, the call, and the value handed on.
    expect(usesIn('probe.ts', source)).toEqual({ invalidateShowcaseFeedCache: 5 });
  });
});
