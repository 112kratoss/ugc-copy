import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

  it('keep the playbooks out of what the browser loads', () => {
    for (const file of ['src/lib/prompt-enhancer-model-limits.ts', 'src/lib/prompt-quality.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source, file).not.toMatch(/from ['"]@\/lib\/prompt-enhancer-playbooks['"]/);
    }
  });
});
