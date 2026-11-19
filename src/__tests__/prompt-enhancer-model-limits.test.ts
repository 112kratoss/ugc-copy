import { existsSync, readFileSync, statSync } from 'node:fs';
import path, { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ENHANCER_PROMPT_LIMITS,
  MODEL_ALIASES,
  getEnhancerPromptLimit,
} from '@/lib/prompt-enhancer-model-limits';
import {
  ENHANCER_PLAYBOOKS,
  MODEL_ALIASES as PLAYBOOK_MODEL_ALIASES,
  getEnhancerPlaybookById,
} from '@/lib/prompt-enhancer-playbooks';

// The creators' pages warn about a prompt over its model's limit from this small
// module, so the 41 playbooks stay off the browser (63 KB on /create-video,
// speed baseline 2026-11-19). The playbooks remain the source of the numbers.

describe('prompt limits the browser reads', () => {
  it('match every playbook that has a length limit, label and number alike', () => {
    const fromPlaybooks = Object.fromEntries(
      Object.entries(ENHANCER_PLAYBOOKS)
        .filter(([, playbook]) => typeof playbook.budget?.maxChars === 'number')
        .map(([id, playbook]) => [id, { label: playbook.label, maxChars: playbook.budget.maxChars }]),
    );
    expect(ENHANCER_PROMPT_LIMITS).toEqual(fromPlaybooks);
  });

  it('resolve a catalog id through the same aliases as the playbooks', () => {
    expect(PLAYBOOK_MODEL_ALIASES).toBe(MODEL_ALIASES);
    for (const alias of Object.keys(MODEL_ALIASES)) {
      const playbook = getEnhancerPlaybookById(alias);
      const limit = getEnhancerPromptLimit(alias);
      expect(limit).toEqual(playbook?.budget.maxChars ? { label: playbook.label, maxChars: playbook.budget.maxChars } : null);
    }
    expect(getEnhancerPromptLimit('imagen-4-ultra')).toEqual({ label: 'Imagen 4', maxChars: 1800 });
    expect(getEnhancerPromptLimit('no-such-model')).toBeNull();
  });

  it('keep the playbooks out of what the creators load in the browser', () => {
    // Followed import by import, value imports only (as browser-generation-reads.test.ts
    // follows them), from the client components that warn about a prompt's length.
    const reached = browserModulesFrom([
      'src/app/create-video/CreateVideoClient.tsx',
      'src/lib/prompt-quality.ts',
    ]);
    expect(reached.has(join(SRC_ROOT, 'lib/prompt-quality.ts'))).toBe(true);
    expect([...reached].filter((file) => file.endsWith('prompt-enhancer-playbooks.ts'))).toEqual([]);
  });
});

const SRC_ROOT = join(process.cwd(), 'src');
const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx'];
// A value import or re-export, a bare import, an import(), a require(); `import type` loads nothing.
const LOADING_IMPORT = /(?:^\s*import\s+(?!type\b)[^'"]*?from\s*|^\s*export\s+(?!type\b)[^'"]*?from\s*|^\s*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gm;

function resolveLocalImport(specifier: string, importer: string): string | null {
  const unresolved = specifier.startsWith('@/')
    ? join(SRC_ROOT, specifier.slice(2))
    : specifier.startsWith('.') ? path.resolve(path.dirname(importer), specifier) : null;
  if (!unresolved) return null;
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${unresolved}${extension}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const extension of SOURCE_EXTENSIONS.slice(1)) {
    const candidate = join(unresolved, `index${extension}`);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function browserModulesFrom(entries: string[]): Set<string> {
  const pending = entries.map((entry) => join(process.cwd(), entry));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(LOADING_IMPORT)) {
      const imported = resolveLocalImport(match[1], file);
      if (imported?.startsWith(SRC_ROOT) && !visited.has(imported)) pending.push(imported);
    }
  }
  return visited;
}
