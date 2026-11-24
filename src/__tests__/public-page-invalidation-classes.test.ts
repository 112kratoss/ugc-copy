import fs from 'node:fs';
import { createRequire } from 'node:module';
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
 *   removes nothing, the feeds and the pages that draw the post in the
 *   background (the feeds at once when it deleted media their cards draw or
 *   edited words they draw of a listed post);
 * - `invalidateShowcaseFeedAndRefreshEveryPage`: a change whose pages cannot
 *   be named, the feeds, the storefront and every public page in the
 *   background (the feeds at once when it took a profile photo or a poster
 *   out, or changed a creator's name or handle);
 * - `invalidateShowcaseFeedCacheOnly`: the feeds alone;
 * - `refreshShowcaseFeedsInBackground`: the feeds alone, in the background
 *   (their hourly maintenance, which reorders and removes nothing);
 * - `invalidateMarketplaceResourceListCache`: the storefront in the
 *   background (a sale, a free unlock).
 *
 * Next's own `revalidateTag`, `revalidatePath` and `updateTag` are imported
 * by those two modules alone, where each tag keeps one profile
 * (`PUBLIC_PAGE_CACHE_TAG` says why): no other file may import them from
 * `next/cache`, or from any path that resolves to it or to the module behind
 * it, by name, renamed, as the whole module or through `require`.
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
 * A key named after a helper holds that helper (review, 2026-11-17): a
 * property, a default, an assignment or a function of that name whose value
 * is anything else (`{ invalidateShowcaseFeedCache: () => {} }`) would turn a
 * write's invalidation off unseen, and fails outright. A member read by a
 * string key (`options['invalidateShowcaseFeedCache']`) counts as one by name.
 *
 * And a helper's name comes from the helper's own module (review, 2026-11-17):
 * an import, a re-export or a destructured binding under a helper's name (or
 * a Next invalidator's) must be that same name, from its cache module (or
 * Next's), and a member read of one off a whole-module import must be off
 * that module. A default or a whole module imported under a helper's name, an
 * export that gives anything else one, and a binding renamed to one all fail.
 *
 * A helper is never reached through an optional chain (`deps.helper?.()`,
 * `deps?.helper()`), which skips the invalidation when the dependency is
 * absent, unless the chain falls back to the helper itself
 * (`deps?.helper ?? helper`). Nor is it taken as a positional parameter
 * (`function finish(invalidateShowcaseFeedCache = …)`), which any argument can
 * fill by position; an option destructured under its name is checked where
 * the option is given.
 *
 * A file whose uses change fails until its row is brought up to date, with
 * what the new use is for; a hand-on under another name fails outright.
 */

const HELPERS = [
  'invalidateShowcaseFeedCache',
  'invalidateShowcaseFeedAndRefreshPostPages',
  'invalidateShowcaseFeedAndRefreshEveryPage',
  'invalidateShowcaseFeedCacheOnly',
  'refreshShowcaseFeedsInBackground',
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
    uses: { revalidateTag: 17 },
    why: 'the five kinds: a removal (the feed and the removal tag at once: 2), the feed alone (1), the feed in the background (its refresh tag: 1), the feeds after a change that removes nothing (their refresh tag in the background, or the feed tag at once when media a card draws was deleted: 2), one post\'s pages (its own and its legacy address, its creator, the storefront, its remixes and their creators in the background; its own page at once on an arrival or deleted media; every page when its remixes cannot be named: 7), every page (the background tag, the storefront in the background, a post\'s or a handle\'s arrival at once: 4)',
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
    uses: { invalidateShowcaseFeedCache: 1, invalidateShowcaseFeedAndRefreshPostPages: 1 },
    why: 'removal: the account-deletion resweep, which can cascade posts after the request that started it; change: a post whose uploaded media gained public copies (the revocations job), its pages in the background so they name the copies',
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
    why: 'removal or change, by classifyPostPageChange on where the save leaves the post: anywhere but public, visible and uncovered is a removal; otherwise a change (with its arrival, its own page at once when the save deleted media, and the feeds at once when it edited words a card draws of a listed post)',
  },
  'src/lib/showcase-publish-service.ts': {
    uses: { invalidateShowcaseFeedCache: 1, invalidateShowcaseFeedAndRefreshPostPages: 1 },
    why: 'removal or change, by classifyPostPageChange on where the publish leaves the creation\'s post: anywhere but public, visible and uncovered is a removal; otherwise a change (the feeds at once when the post was already listed, whose words the publish rewrites)',
  },

  // Changes to one post: the feeds and the post's pages in the background.
  'src/lib/post-publish-service.ts': {
    uses: { invalidateShowcaseFeedAndRefreshPostPages: 1 },
    why: 'change: a new public post (its page, its creator\'s, the storefront; no remix can credit it yet)',
  },

  // Changes whose pages cannot be named: every page in the background.
  'src/lib/profile-route-service.ts': {
    uses: { invalidateShowcaseFeedAndRefreshEveryPage: 3 },
    why: 'change: a profile saved, drawn on every page of the creator\'s, on remix credits and on the storefront; a handle just taken has its not-found dropped at once, and a photo replaced or taken off, or a display name or handle changed, has the feeds expired at once (the default under its alias, the import of it, the call)',
  },
  'src/lib/media-preview-repair.ts': {
    uses: { invalidateShowcaseFeedAndRefreshEveryPage: 5 },
    why: 'change: a repaired preview, from the one-post repair and the sweep (each the option or its default, called) and the poster regeneration, whose old poster is pruned at once and so expires the feeds at once (the sweep knows media rows, not the pages that draw them)',
  },

  // The feeds alone.
  'src/lib/feed-maintenance.ts': {
    uses: { refreshShowcaseFeedsInBackground: 2 },
    why: 'feeds only, in the background: the hourly totals and account labels, which reorder the feeds, remove nothing and no public page draws (the option or its default, called)',
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
type Helper = typeof HELPERS[number];
const isHelper = (text: string): text is Helper => (HELPERS as readonly string[]).includes(text);

function resolveFrom(file: string, specifier: string): string | null {
  try {
    return fs.realpathSync(createRequire(file).resolve(specifier));
  } catch {
    return null;
  }
}

/** The files Next's invalidators come from: `next/cache` and the module it requires them from. */
const NEXT_INVALIDATION_MODULES = new Set(
  ['next/cache', 'next/dist/server/web/spec-extension/revalidate', 'next/dist/esm/server/web/spec-extension/revalidate']
    .map((specifier) => resolveFrom(path.join(ROOT, 'package.json'), specifier))
    .filter((resolved): resolved is string => resolved !== null),
);

/** Whether a module specifier reaches Next's invalidators: `next/cache`, or a path resolving to one of their files. */
function isNextInvalidationModule(specifier: string, file: string): boolean {
  if (specifier === 'next/cache') return true;
  if (!/(^|[\\/])next([\\/]|$)/.test(specifier)) return false;
  const resolved = resolveFrom(path.join(ROOT, file), specifier);
  return resolved !== null && NEXT_INVALIDATION_MODULES.has(resolved);
}

/** The module each helper is declared in. */
const HELPER_MODULES: Record<Helper, string> = {
  invalidateShowcaseFeedCache: 'src/lib/showcase-feed-cache.ts',
  invalidateShowcaseFeedAndRefreshPostPages: 'src/lib/showcase-feed-cache.ts',
  invalidateShowcaseFeedAndRefreshEveryPage: 'src/lib/showcase-feed-cache.ts',
  invalidateShowcaseFeedCacheOnly: 'src/lib/showcase-feed-cache.ts',
  refreshShowcaseFeedsInBackground: 'src/lib/showcase-feed-cache.ts',
  invalidateMarketplaceResourceListCache: 'src/lib/marketplace-resource-list-cache.ts',
};

/** The repository file a module specifier names (`@/…` or a relative path, with or without its extension), or null. */
function sourceModule(specifier: string, file: string): string | null {
  const base = specifier.startsWith('@/')
    ? path.join(ROOT, 'src', specifier.slice(2))
    : specifier.startsWith('.') ? path.resolve(path.dirname(path.join(ROOT, file)), specifier) : null;
  if (!base) return null;
  const stem = base.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, '');
  for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(ROOT, candidate).split(path.sep).join('/');
    }
  }
  return null;
}

/** Whether a name comes from where it is declared: a helper from its cache module, Next's own from Next's. */
function isOwnModule(name: Name, specifier: string, file: string): boolean {
  return isHelper(name) ? sourceModule(specifier, file) === HELPER_MODULES[name] : isNextInvalidationModule(specifier, file);
}

/** The text of a member read's string key: `options['invalidateShowcaseFeedCache']`. */
function elementKey(node: ts.Node): string | null {
  return ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
    ? node.argumentExpression.text
    : null;
}

/** The name an expression is read by: an identifier's, or a member read's last name, by name or by string key. */
function nameOf(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return elementKey(node);
}

/** The name a key is written under: an identifier, a string, or a computed string. */
function keyOf(name: ts.Node | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
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
  // Local names bound to a whole module (`import * as`, `require`, `await import`), with its specifier.
  const namespaces = new Map<string, string>();
  /** The module an expression is: a whole-module binding, `require('…')` or `await import('…')`. */
  const moduleOf = (expression: ts.Expression | undefined): string | null => {
    let inner = expression;
    while (inner && (ts.isParenthesizedExpression(inner) || ts.isAwaitExpression(inner))) inner = inner.expression;
    if (!inner) return null;
    if (ts.isIdentifier(inner)) return namespaces.get(inner.text) ?? null;
    if (ts.isCallExpression(inner) && inner.arguments.length > 0 && ts.isStringLiteral(inner.arguments[0])
      && ((ts.isIdentifier(inner.expression) && inner.expression.text === 'require') || inner.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      return inner.arguments[0].text;
    }
    return null;
  };

  const refuseNextCache = (node: ts.Node, how: string, specifier: string) => {
    if (!isCacheModule) violations.push(`${at(node)} ${how} '${specifier}' outside the two cache modules`);
  };

  const declarations = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const fromNextCache = isNextInvalidationModule(specifier, file);
      const clause = node.importClause;
      if (fromNextCache && clause?.name) refuseNextCache(node, 'imports the default of', specifier);
      if (fromNextCache && clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        refuseNextCache(node, 'imports the whole of', specifier);
      }
      // A helper's name comes from its own module, under its own name.
      if (clause?.name && isName(clause.name.text)) {
        violations.push(`${at(clause.name)} imports the default of '${specifier}' as ${clause.name.text}`);
      }
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        const local = clause.namedBindings.name.text;
        if (isName(local)) violations.push(`${at(clause.namedBindings)} imports the whole of '${specifier}' as ${local}`);
        namespaces.set(local, specifier);
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          const local = element.name.text;
          if (isName(local) && imported !== local) {
            violations.push(`${at(element)} imports ${imported} as ${local}`);
          } else if (isName(imported) && !isOwnModule(imported, specifier, file)) {
            violations.push(`${at(element)} imports ${imported} from '${specifier}', not from its own module`);
          }
        }
        for (const element of clause.namedBindings.elements) {
          const original = (element.propertyName ?? element.name).text;
          if (!isName(original)) continue;
          if (fromNextCache && (NEXT_INVALIDATORS as readonly string[]).includes(original)) {
            refuseNextCache(element, `imports ${original} from`, specifier);
          }
          if (element.propertyName && element.propertyName.text !== element.name.text) {
            aliases.set(element.name.text, original);
            count(original);
          }
        }
      }
    }
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        && isNextInvalidationModule(node.moduleSpecifier.text, file)) {
        refuseNextCache(node, 're-exports from', node.moduleSpecifier.text);
      }
      const from = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
      if (node.exportClause && ts.isNamespaceExport(node.exportClause) && isName(node.exportClause.name.text)) {
        violations.push(`${at(node)} exports the whole of '${from}' as ${node.exportClause.name.text}`);
      }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const original = (element.propertyName ?? element.name).text;
          const exported = element.name.text;
          // An export under a helper's name must be that helper: no other binding, no other module's.
          if (isName(exported)) {
            if (from && original === exported && !isOwnModule(exported, from, file)) {
              violations.push(`${at(element)} exports ${exported} from '${from}', not from its own module`);
            } else if (original !== exported && (from || aliases.get(original) !== exported)) {
              violations.push(`${at(element)} exports ${original} as ${exported}`);
            }
          }
        }
        for (const element of node.exportClause.elements) {
          const original = (element.propertyName ?? element.name).text;
          const helper = isName(original) ? original : aliases.get(original);
          if (!helper) continue;
          count(helper);
          if (element.name.text !== helper) violations.push(`${at(element)} re-exports ${helper} as ${element.name.text}`);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const whole = moduleOf(node.initializer);
      if (whole) namespaces.set(node.name.text, whole);
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const local = node.name.text;
      const pattern = node.parent;
      const source = ts.isArrayBindingPattern(pattern) ? null : keyOf(node.propertyName ?? node.name);
      if (isName(local) && source !== local) {
        violations.push(`${at(node)} binds ${source ?? 'a list item'} as ${local}`);
      } else if (source && isName(source) && ts.isObjectBindingPattern(pattern)) {
        const declaration = pattern.parent;
        const whole = ts.isVariableDeclaration(declaration) ? moduleOf(declaration.initializer) : null;
        if (whole && !isOwnModule(source, whole, file)) {
          violations.push(`${at(node)} takes ${source} from '${whole}', not from its own module`);
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
      && ((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword)
      && isNextInvalidationModule(node.arguments[0].text, file)) {
      refuseNextCache(node, ts.isIdentifier(node.expression) ? 'requires' : 'imports at run time', node.arguments[0].text);
    }
    ts.forEachChild(node, declarations);
  };
  declarations(parsed);

  /** Whether an expression is the helper itself: its import, a renamed one, a member read of its name, or a fallback between those. */
  const isTheHelper = (expression: ts.Expression, helper: Helper): boolean => {
    let inner: ts.Expression = expression;
    while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
    if (ts.isIdentifier(inner)) return inner.text === helper || aliases.get(inner.text) === helper;
    if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) return nameOf(inner) === helper;
    if (ts.isBinaryExpression(inner)
      && (inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || inner.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      return isTheHelper(inner.left, helper) && isTheHelper(inner.right, helper);
    }
    return false;
  };

  /** Whether a node is part of a type, where nothing runs. */
  const inType = (node: ts.Node): boolean => {
    for (let ancestor: ts.Node | undefined = node.parent; ancestor; ancestor = ancestor.parent) {
      if (ts.isTypeNode(ancestor)) return true;
    }
    return false;
  };

  /**
   * A helper reached through an optional chain, as a read in one or the callee
   * of an optional call: absent, the chain skips the invalidation. Allowed only
   * when the chain falls back to the helper itself (`deps?.helper ?? helper`).
   */
  const checkOptionalChain = (reference: ts.Node, helper: Name) => {
    if (!isHelper(helper)) return;
    const target = outermost(reference);
    const parent = target.parent;
    const optionalCall = ts.isCallExpression(parent) && parent.expression === target && Boolean(parent.questionDotToken);
    if (!ts.isOptionalChain(reference) && !optionalCall) return;
    if (!optionalCall && ts.isBinaryExpression(parent) && parent.left === target
      && (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      && isTheHelper(parent.right, helper)) return;
    violations.push(`${at(reference)} reaches ${helper} through an optional chain`);
  };

  // Keys named after a helper must hold it: anything else would turn the
  // invalidation of whatever reads that key off. The cache modules declare them.
  const keys = (node: ts.Node) => {
    const holds = (key: string | null, value: ts.Expression | undefined, what: (key: string) => string) => {
      if (key && isHelper(key) && value && !isTheHelper(value, key)) {
        violations.push(`${at(node)} ${what(key)} a value that is not ${key}`);
      }
    };
    if (ts.isPropertyAssignment(node)) holds(keyOf(node.name), node.initializer, (key) => `gives the property ${key}`);
    if (ts.isShorthandPropertyAssignment(node)) holds(node.name.text, node.objectAssignmentInitializer, (key) => `defaults ${key} to`);
    if (ts.isBindingElement(node)) holds(keyOf(node.propertyName ?? node.name), node.initializer, (key) => `defaults ${key} to`);
    const positional = ts.isParameter(node) && ts.isIdentifier(node.name) && isHelper(node.name.text) ? node.name.text : null;
    if (positional && !inType(node)) {
      violations.push(`${at(node)} takes ${positional} by position`);
    } else if (ts.isParameter(node) || ts.isPropertyDeclaration(node)) {
      holds(keyOf(node.name), node.initializer, (key) => `defaults ${key} to`);
    }
    if (ts.isVariableDeclaration(node)) holds(keyOf(node.name), node.initializer, (key) => `binds ${key} to`);
    if (ts.isBinaryExpression(node) && [
      ts.SyntaxKind.EqualsToken,
      ts.SyntaxKind.QuestionQuestionEqualsToken,
      ts.SyntaxKind.BarBarEqualsToken,
      ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ].includes(node.operatorToken.kind)) {
      holds(nameOf(node.left), node.right, (key) => `assigns ${key}`);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.name) {
      const key = keyOf(node.name);
      if (key && isHelper(key)) violations.push(`${at(node)} declares its own ${key}`);
    }
    ts.forEachChild(node, keys);
  };
  if (!isCacheModule) keys(parsed);

  /** Whether a reference is a declaration, an import or export name, a type or an object key. */
  const isDeclarationName = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)
      || ts.isExportSpecifier(parent) || ts.isNamespaceExport(parent)) return true;
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
    if ((ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) && ts.isPropertyAccessExpression(parent) === false) {
      // `dependencies.invalidateShowcaseFeedCache` read on its own, outside a call or a fallback.
      violations.push(`${at(reference)} reads ${helper} outside a call`);
      return;
    }
    violations.push(`${at(reference)} hands ${helper} on (${ts.SyntaxKind[parent.kind]})`);
  };

  /** A member read of a name off a whole-module binding of another module: not that name. */
  const checkNamespaceRead = (read: ts.PropertyAccessExpression | ts.ElementAccessExpression, name: Name) => {
    const whole = ts.isIdentifier(read.expression) ? namespaces.get(read.expression.text) : undefined;
    if (whole && !isOwnModule(name, whole, file)) {
      violations.push(`${at(read)} reads ${name} from '${whole}', not from its own module`);
    }
  };

  const references = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && isName(node.name.text)) checkNamespaceRead(node, node.name.text);
    if (ts.isElementAccessExpression(node)) {
      const key = elementKey(node);
      if (key && isName(key)) checkNamespaceRead(node, key);
    }
    // `options['invalidateShowcaseFeedCache']`, read as the member read by name it is.
    const keyed = elementKey(node);
    if (keyed && isName(keyed)) {
      count(keyed);
      if (!isCacheModule || !(NEXT_INVALIDATORS as readonly string[]).includes(keyed)) checkHandOn(node, keyed);
      if (!isCacheModule) checkOptionalChain(node, keyed);
    }
    if (ts.isIdentifier(node)) {
      const helper = isName(node.text) ? node.text : aliases.get(node.text);
      const parent = node.parent;
      const memberName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (helper && (memberName ? isName(node.text) : !isDeclarationName(node))) {
        count(helper);
        if (!isCacheModule || !(NEXT_INVALIDATORS as readonly string[]).includes(helper)) {
          checkHandOn(memberName ? parent : node, helper);
        }
        if (!isCacheModule) checkOptionalChain(memberName ? parent : node, helper);
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
      // Every helper's name and every path to Next's invalidators has one of these in it.
      if (!NAMES.some((name) => source.includes(name)) && !source.includes('next/cache') && !source.includes('revalidate')) continue;
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
      // Review, 2026-11-17: what a write path reads under a helper's name must be that helper.
      ['a non-helper under a helper’s key', "import { deleteOwnerGenerationForRoute } from '@/lib/generation-delete-service';\nexport const f = () => deleteOwnerGenerationForRoute({ invalidateShowcaseFeedCache: () => {} } as never);", /gives the property invalidateShowcaseFeedCache a value that is not invalidateShowcaseFeedCache/],
      ['a non-helper under a helper’s string key', "export const f = (run: (options: object) => void) => run({ 'invalidateShowcaseFeedCacheOnly': () => {} });", /gives the property invalidateShowcaseFeedCacheOnly a value/],
      ['a non-helper as a helper’s default', "export function f({ invalidateShowcaseFeedCache = () => {} }: { invalidateShowcaseFeedCache?: () => void } = {}) { invalidateShowcaseFeedCache(); }", /defaults invalidateShowcaseFeedCache to a value that is not/],
      ['a variable of a helper’s name bound to a non-helper', "const invalidateShowcaseFeedCacheOnly = () => {};\nexport const f = (run: (options: object) => void) => run({ invalidateShowcaseFeedCacheOnly });", /binds invalidateShowcaseFeedCacheOnly to a value that is not/],
      ['a function of a helper’s name', "export function invalidateShowcaseFeedAndRefreshEveryPage() {}", /declares its own invalidateShowcaseFeedAndRefreshEveryPage/],
      ['a helper read by a string key and kept', "export const f = (dependencies: Record<string, () => void>) => { const wipe = dependencies['invalidateShowcaseFeedCache']; wipe(); };", /hands invalidateShowcaseFeedCache on as wipe/],
      ['revalidateTag from the module behind next/cache', "import { revalidateTag } from 'next/dist/server/web/spec-extension/revalidate';\nexport const f = () => revalidateTag('x', 'max');", /imports revalidateTag from 'next\/dist\/server\/web\/spec-extension\/revalidate'/],
      ['next/cache by its file name', "import { updateTag } from 'next/cache.js';\nexport const f = () => updateTag('x');", /imports updateTag from 'next\/cache\.js'/],
      ['the ESM module behind next/cache through require', "const { revalidatePath } = require('next/dist/esm/server/web/spec-extension/revalidate');\nexports.f = () => revalidatePath('/');", /requires 'next\/dist\/esm\/server\/web\/spec-extension\/revalidate'/],
    ])('refuses %s', (_name, source, refusal) => {
      expect(analyse('src/lib/probe.ts', source).violations).toEqual([expect.stringMatching(refusal)]);
    });

    // Review, 2026-11-17: a helper's name must come from its own module, as that same name.
    it.each([
      ['another module’s export imported under a helper’s name', "import { noop as invalidateShowcaseFeedCache } from '@/lib/backend-logger';\nexport const f = () => invalidateShowcaseFeedCache();", /imports noop as invalidateShowcaseFeedCache/],
      ['one helper imported under another’s name', "import { invalidateShowcaseFeedCacheOnly as invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';\nexport const f = () => invalidateShowcaseFeedCache();", /imports invalidateShowcaseFeedCacheOnly as invalidateShowcaseFeedCache/],
      ['a helper’s name imported from another module', "import { invalidateShowcaseFeedCache } from '@/lib/backend-logger';\nexport const f = () => invalidateShowcaseFeedCache();", /imports invalidateShowcaseFeedCache from '@\/lib\/backend-logger', not from its own module/],
      ['a helper renamed from another module', "import { invalidateShowcaseFeedCache as wipe } from '@/lib/backend-logger';\nexport const f = () => wipe();", /imports invalidateShowcaseFeedCache from '@\/lib\/backend-logger', not from its own module/],
      ['a Next invalidator’s name from another module', "import { revalidateTag } from 'some-cache-library';\nexport const f = () => revalidateTag('x');", /imports revalidateTag from 'some-cache-library', not from its own module/],
      ['a default imported under a helper’s name', "import invalidateShowcaseFeedCache from '@/lib/backend-logger';\nexport const f = () => invalidateShowcaseFeedCache();", /imports the default of '@\/lib\/backend-logger' as invalidateShowcaseFeedCache/],
      ['a whole module imported under a helper’s name', "import * as invalidateShowcaseFeedCacheOnly from '@/lib/backend-logger';", /imports the whole of '@\/lib\/backend-logger' as invalidateShowcaseFeedCacheOnly/],
      ['a helper’s name read off another module', "import * as logger from '@/lib/backend-logger';\nexport const f = () => logger.invalidateShowcaseFeedCache();", /reads invalidateShowcaseFeedCache from '@\/lib\/backend-logger', not from its own module/],
      ['a helper’s name read off another module by a string key', "import * as logger from '@/lib/backend-logger';\nexport const f = () => logger['invalidateShowcaseFeedCacheOnly']();", /reads invalidateShowcaseFeedCacheOnly from '@\/lib\/backend-logger', not from its own module/],
      ['another binding exported under a helper’s name', "const noop = () => {};\nexport { noop as invalidateShowcaseFeedCache };", /exports noop as invalidateShowcaseFeedCache/],
      ['another module’s export re-exported under a helper’s name', "export { noop as invalidateShowcaseFeedAndRefreshEveryPage } from '@/lib/backend-logger';", /exports noop as invalidateShowcaseFeedAndRefreshEveryPage/],
      ['a helper’s name re-exported from another module', "export { invalidateShowcaseFeedCache } from '@/lib/backend-logger';", /exports invalidateShowcaseFeedCache from '@\/lib\/backend-logger', not from its own module/],
      ['a whole module exported under a helper’s name', "export * as invalidateMarketplaceResourceListCache from '@/lib/backend-logger';", /exports the whole of '@\/lib\/backend-logger' as invalidateMarketplaceResourceListCache/],
      ['a key destructured under a helper’s name', "export function f(dependencies: { noop: () => void }) { const { noop: invalidateShowcaseFeedCache } = dependencies; invalidateShowcaseFeedCache(); }", /binds noop as invalidateShowcaseFeedCache/],
      ['a helper’s name destructured from another module', "const { invalidateShowcaseFeedCache } = require('./backend-logger');\nexports.f = () => invalidateShowcaseFeedCache();", /takes invalidateShowcaseFeedCache from '\.\/backend-logger', not from its own module/],
      ['a list item bound under a helper’s name', "export function f(list: Array<() => void>) { const [invalidateShowcaseFeedCache] = list; invalidateShowcaseFeedCache(); }", /binds a list item as invalidateShowcaseFeedCache/],
    ])('refuses %s', (_name, source, refusal) => {
      expect(analyse('src/lib/probe.ts', source).violations).toEqual([expect.stringMatching(refusal)]);
    });

    it('takes a helper from its own module by any path to it, whole or by name', () => {
      expect(analyse('src/lib/probe.ts', lines(
        "import { invalidateShowcaseFeedCache } from './showcase-feed-cache';",
        "import { invalidateMarketplaceResourceListCache as defaultInvalidateMarketplaceResourceListCache } from '@/lib/marketplace-resource-list-cache';",
        "import * as cacheModule from '@/lib/showcase-feed-cache';",
        'export async function f() {',
        '  invalidateShowcaseFeedCache();',
        '  defaultInvalidateMarketplaceResourceListCache();',
        '  cacheModule.invalidateShowcaseFeedCacheOnly();',
        "  const { invalidateShowcaseFeedAndRefreshEveryPage } = await import('@/lib/showcase-feed-cache');",
        '  invalidateShowcaseFeedAndRefreshEveryPage();',
        '}',
      ))).toEqual({
        uses: {
          invalidateShowcaseFeedCache: 1,
          invalidateMarketplaceResourceListCache: 2,
          invalidateShowcaseFeedCacheOnly: 1,
          invalidateShowcaseFeedAndRefreshEveryPage: 1,
        },
        violations: [],
      });
    });

    // Review, 2026-11-17: an optional chain skips the wipe when the dependency
    // is absent, and a positional parameter takes any argument.
    it.each([
      ['a helper called by an optional call', "export function f(dependencies: { invalidateShowcaseFeedCache?: () => void }) { dependencies.invalidateShowcaseFeedCache?.(); }", /reaches invalidateShowcaseFeedCache through an optional chain/],
      ['a helper read off an optional chain', "export function f(dependencies?: { invalidateShowcaseFeedCache: () => void }) { dependencies?.invalidateShowcaseFeedCache(); }", /reaches invalidateShowcaseFeedCache through an optional chain/],
      ['a helper read by a string key off an optional chain', "export function f(dependencies?: Record<string, () => void>) { dependencies?.['invalidateShowcaseFeedCacheOnly'](); }", /reaches invalidateShowcaseFeedCacheOnly through an optional chain/],
      ['a helper itself called optionally', "import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';\nexport const f = () => invalidateShowcaseFeedCache?.();", /reaches invalidateShowcaseFeedCache through an optional chain/],
      ['a positional parameter spelled like a helper, with a default', "export function finish(invalidateShowcaseFeedCache = () => {}) { invalidateShowcaseFeedCache(); }", /takes invalidateShowcaseFeedCache by position/],
      ['a positional parameter spelled like a helper', "export function finish(invalidateShowcaseFeedCacheOnly: () => void) { invalidateShowcaseFeedCacheOnly(); }", /takes invalidateShowcaseFeedCacheOnly by position/],
    ])('refuses %s', (_name, source, refusal) => {
      expect(analyse('src/lib/probe.ts', source).violations).toEqual([expect.stringMatching(refusal)]);
    });

    it('lets an optional chain fall back to the helper, and a type name a parameter after one', () => {
      expect(analyse('src/lib/probe.ts', lines(
        "import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';",
        'type Finish = (invalidateShowcaseFeedCache: () => void) => void;',
        'export const f = (dependencies?: { invalidateShowcaseFeedCache?: () => void }) =>',
        '  (dependencies?.invalidateShowcaseFeedCache ?? invalidateShowcaseFeedCache)();',
      ))).toEqual({ uses: { invalidateShowcaseFeedCache: 2 }, violations: [] });
    });

    it('refuses a non-helper assigned to a helper’s key, and the read that makes it', () => {
      expect(analyse('src/lib/probe.ts', lines(
        'export function f(options: { invalidateShowcaseFeedCache?: () => void }) {',
        '  options.invalidateShowcaseFeedCache = () => {};',
        '}',
      )).violations).toEqual([
        expect.stringMatching(/assigns invalidateShowcaseFeedCache a value that is not invalidateShowcaseFeedCache/),
        expect.stringMatching(/reads invalidateShowcaseFeedCache outside a call/),
      ]);
    });

    it('counts a member read by a string key as one by name', () => {
      expect(analyse('src/lib/probe.ts', lines(
        "import * as cacheModule from '@/lib/showcase-feed-cache';",
        'export const f = (dependencies: { invalidateShowcaseFeedCache?: () => void }) =>',
        "  (dependencies['invalidateShowcaseFeedCache'] ?? cacheModule.invalidateShowcaseFeedCache)();",
      ))).toEqual({ uses: { invalidateShowcaseFeedCache: 2 }, violations: [] });
    });

    it("finds the files Next's invalidators come from, so a path to them is refused", () => {
      const found = [...NEXT_INVALIDATION_MODULES].map((file) => file.split(path.sep).join('/'));
      expect(found).toEqual([
        expect.stringMatching(/\/next\/cache\.js$/),
        expect.stringMatching(/\/next\/dist\/server\/web\/spec-extension\/revalidate\.js$/),
        expect.stringMatching(/\/next\/dist\/esm\/server\/web\/spec-extension\/revalidate\.js$/),
      ]);
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
