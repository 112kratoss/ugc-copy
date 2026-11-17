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
 * Next's own `revalidateTag`, `revalidatePath` and `updateTag` are imported
 * by those two modules alone, where each tag keeps one profile
 * (`PUBLIC_PAGE_CACHE_TAG` says why): no other file may import them from
 * `next/cache`, by name, renamed, as the whole module or through `require`.
 *
 * A use is a reference in code, read with the TypeScript parser (comments,
 * types and plain imports are not uses): a call, a member read named after the
 * helper, a renamed import or binding (whose local name is then followed as
 * the helper), a re-export, or the helper handed on. A helper is handed on
 * only under its own name: as the default of a dependency or an option of
 * that name (`invalidateShowcaseFeedCache = defaultInvalidateShowcaseFeedCache`,
 * `(options.invalidateShowcaseFeedCacheOnly ?? invalidateShowcaseFeedCacheOnly)()`),
 * or as a property of that name, so every call through it is counted here.
 *
 * A file whose uses change fails until its row is brought up to date, with
 * what the new use is for; a hand-on under another name fails outright.
 */

const HELPERS = [
  'invalidateShowcaseFeedCache',
  'invalidateShowcaseFeedAndRefreshPostPages',
  'invalidateShowcaseFeedAndRefreshEveryPage',
  'invalidateShowcaseFeedCacheOnly',
  'invalidateMarketplaceResourceListCache',
] as const;
const NEXT_INVALIDATORS = ['revalidateTag', 'revalidatePath', 'updateTag'] as const;
const NAMES = [...NEXT_INVALIDATORS, ...HELPERS] as const;
type Name = typeof NAMES[number];
const CACHE_MODULES = ['src/lib/showcase-feed-cache.ts', 'src/lib/marketplace-resource-list-cache.ts'];

type Classified = {
  uses: Partial<Record<Name, number>>;
  /** What each use is: the change it follows and the class it is in. */
  why: string;
};

const CLASSIFIED: Record<string, Classified> = {
  // The helpers themselves.
  'src/lib/showcase-feed-cache.ts': {
    uses: { revalidateTag: 15 },
    why: 'the four kinds: a removal (the feed and the removal tag at once: 2), the feed alone (1), one post\'s pages (the feed at once; its own and its legacy address, its creator, the storefront, its remixes and their creators in the background; its own page at once on an arrival or deleted media; every page when its remixes cannot be named: 8), every page (the feed at once, the background tag, a post\'s or a handle\'s arrival at once: 4)',
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
    uses: { invalidateShowcaseFeedCache: 3 },
    why: 'removal: a creation deleted, with the posts made from it (the default under its alias, the import of it, the call)',
  },
  'src/lib/post-delete-service.ts': {
    uses: { invalidateShowcaseFeedCache: 2 },
    why: 'removal: a post deleted, or tombstoned for its buyers',
  },
  'src/lib/showcase-feed-invalidate-route-adapter-service.ts': {
    uses: { invalidateShowcaseFeedCache: 2 },
    why: 'removal and the operator\'s lever: the moderation CLI after a take-down or a dismissal, and a refresh by hand (the dependency or its default, called)',
  },

  // Removals and changes, by what the write did.
  'src/lib/admin-moderation-service.ts': {
    uses: { invalidateShowcaseFeedCache: 3, invalidateShowcaseFeedAndRefreshEveryPage: 1 },
    why: 'removal: a report taken down, a post hidden or taken down, and any action that failed after it may have committed; change: a post restored (its not-found and its creation address\'s at once, every page in the background, as the console does not know its creator)',
  },
  'src/lib/post-lifecycle-service.ts': {
    uses: { invalidateShowcaseFeedCache: 1, invalidateShowcaseFeedAndRefreshPostPages: 1 },
    why: 'removal: an archive; change: a restore, with its arrival',
  },
  'src/lib/post-update-service.ts': {
    uses: { invalidateShowcaseFeedCache: 1, invalidateShowcaseFeedAndRefreshPostPages: 1 },
    why: 'removal or change, by classifyPostPageChange on where the save leaves the post: anywhere but public, visible and uncovered is a removal; otherwise a change (with its arrival, and its own page at once when the save deleted media)',
  },
  'src/lib/showcase-publish-service.ts': {
    uses: { invalidateShowcaseFeedCache: 1, invalidateShowcaseFeedAndRefreshPostPages: 1 },
    why: 'removal or change, by classifyPostPageChange on where the publish leaves the creation\'s post: anywhere but public, visible and uncovered is a removal; otherwise a change',
  },

  // Changes to one post: the feeds at once, the post's pages in the background.
  'src/lib/post-publish-service.ts': {
    uses: { invalidateShowcaseFeedAndRefreshPostPages: 1 },
    why: 'change: a new public post (its page, its creator\'s, the storefront; no remix can credit it yet)',
  },

  // Changes whose pages cannot be named: every page in the background.
  'src/lib/profile-route-service.ts': {
    uses: { invalidateShowcaseFeedAndRefreshEveryPage: 3 },
    why: 'change: a profile saved, drawn on every page of the creator\'s, on remix credits and on the storefront; a handle just taken has its not-found dropped at once (the default under its alias, the import of it, the call)',
  },
  'src/lib/media-preview-repair.ts': {
    uses: { invalidateShowcaseFeedAndRefreshEveryPage: 5 },
    why: 'change: a repaired preview, from the one-post repair and the sweep (each the option or its default, called) and the poster regeneration (the sweep knows media rows, not the pages that draw them)',
  },

  // The feeds alone.
  'src/lib/feed-maintenance.ts': {
    uses: { invalidateShowcaseFeedCacheOnly: 2 },
    why: 'feeds only: the hourly totals and account labels, which no public page draws (the option or its default, called)',
  },
  'src/lib/moderation-service.ts': {
    uses: { invalidateShowcaseFeedCacheOnly: 3 },
    why: 'feeds only: a block, applied by the pages in the browser (the default under its alias, the import of it, the call)',
  },
  'src/lib/post-report-service.ts': {
    uses: { invalidateShowcaseFeedCacheOnly: 3 },
    why: 'feeds only: a report, which hides nothing until a moderator decides (the default under its alias, the import of it, the call)',
  },

  // A sale or a free unlock: the storefront in the background.
  'src/lib/mobile-commerce.ts': {
    uses: { invalidateMarketplaceResourceListCache: 6 },
    why: 'storefront: an in-app purchase of a recipe, by the app and by the store\'s webhook (the import under its alias, the two defaults, the two calls, and the hand-on from one to the other)',
  },
  'src/lib/post-resource-bundle-free-unlock-service.ts': {
    uses: { invalidateMarketplaceResourceListCache: 3 },
    why: 'storefront: a free unlock (the import under its alias, the default, the call)',
  },
  'src/lib/post-resource-bundle-verify-service.ts': {
    uses: { invalidateMarketplaceResourceListCache: 3 },
    why: 'storefront: a purchase verified (the import under its alias, the default, the call)',
  },
  'src/lib/razorpay-webhook-service.ts': {
    uses: { invalidateMarketplaceResourceListCache: 3 },
    why: 'storefront: a purchase captured by Razorpay\'s webhook (the import under its alias, the default, the call)',
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
    else if (/\.(ts|tsx|mts|cts|mjs|cjs|js)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

const isName = (text: string): text is Name => (NAMES as readonly string[]).includes(text);

/** The name an expression is read by: an identifier's, or a member read's last name. */
function nameOf(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
}

function outermost(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return current;
}

type Analysis = { uses: Partial<Record<Name, number>>; violations: string[] };

/** Each helper's uses in one file's code, and every way it reaches one that this test refuses. */
function analyse(file: string, source: string): Analysis {
  const uses: Partial<Record<Name, number>> = {};
  const violations: string[] = [];
  const isCacheModule = CACHE_MODULES.includes(file);
  const count = (name: Name) => { uses[name] = (uses[name] ?? 0) + 1; };
  const at = (node: ts.Node) => `${file}:${parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.(ts|mts|cts)$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  // Local names that stand for a helper under another name: renamed imports and bindings.
  const aliases = new Map<string, Name>();

  const refuseNextCache = (node: ts.Node, how: string) => {
    if (!isCacheModule) violations.push(`${at(node)} ${how} 'next/cache' outside the two cache modules`);
  };

  const declarations = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const fromNextCache = node.moduleSpecifier.text === 'next/cache';
      const clause = node.importClause;
      if (fromNextCache && clause?.name) refuseNextCache(node, 'imports the default of');
      if (fromNextCache && clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        refuseNextCache(node, 'imports the whole of');
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const original = (element.propertyName ?? element.name).text;
          if (!isName(original)) continue;
          if (fromNextCache && (NEXT_INVALIDATORS as readonly string[]).includes(original)) {
            refuseNextCache(element, `imports ${original} from`);
          }
          if (element.propertyName && element.propertyName.text !== element.name.text) {
            aliases.set(element.name.text, original);
            count(original);
          }
        }
      }
    }
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'next/cache') {
        refuseNextCache(node, 're-exports from');
      }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const original = (element.propertyName ?? element.name).text;
          const helper = isName(original) ? original : aliases.get(original);
          if (!helper) continue;
          count(helper);
          if (element.name.text !== helper) violations.push(`${at(element)} re-exports ${helper} as ${element.name.text}`);
        }
      }
    }
    if (ts.isBindingElement(node) && node.propertyName && ts.isIdentifier(node.propertyName) && ts.isIdentifier(node.name)) {
      const original = node.propertyName.text;
      if (isName(original) && original !== node.name.text) {
        aliases.set(node.name.text, original);
        count(original);
      }
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === 'next/cache'
      && ((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      refuseNextCache(node, ts.isIdentifier(node.expression) ? 'requires' : 'imports at run time');
    }
    ts.forEachChild(node, declarations);
  };
  declarations(parsed);

  /** Whether a reference is a declaration, an import or export name, a type or an object key. */
  const isDeclarationName = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent)) return true;
    if ((ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)
      || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)
      || ts.isPropertyAssignment(parent) || ts.isBindingElement(parent)) && parent.name === node) return true;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
    for (let ancestor: ts.Node | undefined = parent; ancestor; ancestor = ancestor.parent) {
      if (ts.isTypeNode(ancestor)) return true;
    }
    return false;
  };

  /** A reference used anywhere but a call, a same-named default or property, or a member read of its name. */
  const checkHandOn = (reference: ts.Node, helper: Name) => {
    let target = outermost(reference);
    let parent = target.parent;
    if (ts.isBinaryExpression(parent)
      && (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      // `dependency ?? helper`: checked from the fallback, whose dependency must carry its name.
      if (parent.left === target) return;
      if (nameOf(parent.left) !== helper) {
        violations.push(`${at(reference)} hands ${helper} on as ${nameOf(parent.left) ?? 'an expression'}`);
        return;
      }
      target = outermost(parent);
      parent = target.parent;
    }
    if (ts.isCallExpression(parent) && parent.expression === target) return;
    if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) && parent.initializer === target) {
      const bound = ts.isIdentifier(parent.name) ? parent.name.text : null;
      if (bound !== helper) violations.push(`${at(reference)} hands ${helper} on as ${bound ?? 'a pattern'}`);
      return;
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === target) {
      const key = ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name) ? parent.name.text : null;
      if (key !== helper) violations.push(`${at(reference)} hands ${helper} on as the property ${key ?? '(computed)'}`);
      return;
    }
    if (ts.isShorthandPropertyAssignment(parent)) {
      if (parent.name.text !== helper) violations.push(`${at(reference)} hands ${helper} on as the property ${parent.name.text}`);
      return;
    }
    if (ts.isPropertyAccessExpression(target) && ts.isPropertyAccessExpression(parent) === false) {
      // `dependencies.invalidateShowcaseFeedCache` read on its own, outside a call or a fallback.
      violations.push(`${at(reference)} reads ${helper} outside a call`);
      return;
    }
    violations.push(`${at(reference)} hands ${helper} on (${ts.SyntaxKind[parent.kind]})`);
  };

  const references = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const helper = isName(node.text) ? node.text : aliases.get(node.text);
      const parent = node.parent;
      const memberName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (helper && (memberName ? isName(node.text) : !isDeclarationName(node))) {
        count(helper);
        if (!isCacheModule || !(NEXT_INVALIDATORS as readonly string[]).includes(helper)) {
          checkHandOn(memberName ? parent : node, helper);
        }
      }
    }
    ts.forEachChild(node, references);
  };
  references(parsed);

  return { uses, violations };
}

function scan(): { found: Record<string, Partial<Record<Name, number>>>; violations: string[] } {
  const found: Record<string, Partial<Record<Name, number>>> = {};
  const violations: string[] = [];
  for (const directory of SCANNED) {
    for (const absolute of sourceFiles(path.join(ROOT, directory))) {
      const source = fs.readFileSync(absolute, 'utf8');
      if (!NAMES.some((name) => source.includes(name)) && !source.includes('next/cache')) continue;
      const file = path.relative(ROOT, absolute).split(path.sep).join('/');
      const analysis = analyse(file, source);
      if (Object.keys(analysis.uses).length > 0) found[file] = analysis.uses;
      violations.push(...analysis.violations);
    }
  }
  return { found, violations };
}

describe('every write that invalidates a cached feed or public page is classified', () => {
  const { found, violations } = scan();

  it('finds each helper use the table lists, file by file, and no other', () => {
    const listed = Object.fromEntries(Object.entries(CLASSIFIED).map(([file, { uses }]) => [file, uses]));

    // A file here and not in the table invalidates without a class: add its
    // row, with what each use is for. A count that moved is a new or a gone
    // use in a file already listed: say what it is in that row's `why`.
    expect(found).toEqual(listed);
  });

  it("leaves Next's own invalidation to the two cache modules, and every helper to its own name", () => {
    expect(violations).toEqual([]);
    const direct = Object.entries(found)
      .filter(([, uses]) => NEXT_INVALIDATORS.some((name) => uses[name]))
      .map(([file]) => file)
      .sort();
    expect(direct).toEqual([...CACHE_MODULES].sort());
  });

  describe('reads what it guards against', () => {
    const lines = (...code: string[]) => code.join('\n');

    it('counts calls, defaults under their own name and member reads; not imports, types or comments', () => {
      expect(analyse('src/lib/probe.ts', lines(
        "import { invalidateShowcaseFeedCache as defaultInvalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';",
        '// invalidateShowcaseFeedCache() in a comment',
        'type Dependencies = { invalidateShowcaseFeedCache?: typeof defaultInvalidateShowcaseFeedCache };',
        'export function run({ invalidateShowcaseFeedCache = defaultInvalidateShowcaseFeedCache }: Dependencies, dependencies: Dependencies) {',
        '  invalidateShowcaseFeedCache();',
        '  (dependencies.invalidateShowcaseFeedCache ?? defaultInvalidateShowcaseFeedCache)();',
        '  return { invalidateShowcaseFeedCache: dependencies.invalidateShowcaseFeedCache ?? defaultInvalidateShowcaseFeedCache };',
        '}',
      ))).toEqual({
        // The renamed import, the default, the call, the member read and its fallback, twice.
        uses: { invalidateShowcaseFeedCache: 7 },
        violations: [],
      });
    });

    it.each([
      ['a renamed import of revalidateTag', "import { revalidateTag as expire } from 'next/cache';\nexport const f = () => expire('x', { expire: 0 });", /imports revalidateTag from 'next\/cache'/],
      ['revalidatePath by name', "import { revalidatePath } from 'next/cache';\nexport const f = () => revalidatePath('/');", /imports revalidatePath from 'next\/cache'/],
      ['the whole of next/cache', "import * as cache from 'next/cache';\nexport const f = () => cache.revalidateTag('x', 'max');", /imports the whole of 'next\/cache'/],
      ['next/cache through require', "const { updateTag } = require('next/cache');\nexports.f = () => updateTag('x');", /requires 'next\/cache'/],
      ['next/cache at run time', "export const f = async () => (await import('next/cache')).revalidateTag('x', 'max');", /imports at run time 'next\/cache'/],
      ['a helper handed on under another name', "import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';\nexport function f({ wipe = invalidateShowcaseFeedCache } = {}) { wipe(); }", /hands invalidateShowcaseFeedCache on as wipe/],
      ['an option under another name', "import { invalidateShowcaseFeedCacheOnly } from '@/lib/showcase-feed-cache';\nexport function f(options: { invalidateFeedCache?: () => void }) { (options.invalidateFeedCache ?? invalidateShowcaseFeedCacheOnly)(); }", /hands invalidateShowcaseFeedCacheOnly on as invalidateFeedCache/],
      ['a helper kept in a variable', "import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';\nconst wipe = invalidateShowcaseFeedCache;\nexport const f = () => wipe();", /hands invalidateShowcaseFeedCache on as wipe/],
      ['a helper passed as an argument', "import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';\nexport const f = (later: (task: () => void) => void) => later(invalidateShowcaseFeedCache);", /hands invalidateShowcaseFeedCache on \(CallExpression\)/],
      ['a helper re-exported under another name', "export { invalidateShowcaseFeedCache as wipe } from '@/lib/showcase-feed-cache';", /re-exports invalidateShowcaseFeedCache as wipe/],
    ])('refuses %s', (_name, source, refusal) => {
      expect(analyse('src/lib/probe.ts', source).violations).toEqual([expect.stringMatching(refusal)]);
    });

    it('follows a renamed import and a renamed binding as the helper', () => {
      expect(analyse('src/lib/probe.ts', lines(
        "import { invalidateShowcaseFeedCache as wipe } from '@/lib/showcase-feed-cache';",
        "import * as cacheModule from '@/lib/showcase-feed-cache';",
        'const { invalidateShowcaseFeedCacheOnly: feedOnly } = cacheModule;',
        'export const f = () => { wipe(); feedOnly(); };',
      )).uses).toEqual({ invalidateShowcaseFeedCache: 2, invalidateShowcaseFeedCacheOnly: 2 });
    });
  });
});
