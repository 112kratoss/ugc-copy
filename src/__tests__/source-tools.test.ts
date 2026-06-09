import { describe, expect, it } from 'vitest';

import {
  normalizeSourceToolSelectionsWithCatalog,
  validateSourceToolSelections,
  type SourceToolOption,
} from '@/lib/source-tools';

const catalog: SourceToolOption[] = [{
  slug: 'higgsfield',
  label: 'Higgsfield',
  models: [{ slug: 'soul', label: 'Soul' }],
  supportedMediaKinds: ['image', 'video'],
}];

describe('source tool selection validation', () => {
  it('rejects overlong and reserved creation names', () => {
    expect(validateSourceToolSelections([{
      toolLabel: 'x'.repeat(81),
      createTool: true,
    }])).toMatch(/80 characters/i);

    expect(validateSourceToolSelections([{
      toolLabel: 'Custom',
      createTool: true,
    }])).toMatch(/reserved/i);
  });

  it('preserves explicit creation intent while canonicalizing catalog entries', () => {
    expect(normalizeSourceToolSelectionsWithCatalog(catalog, [{
      toolLabel: 'Higgsfield',
      toolSlug: 'higgsfield',
      modelLabel: 'Soul',
      modelSlug: 'soul',
      createTool: true,
      createModel: true,
    }])).toEqual([{
      toolLabel: 'Higgsfield',
      toolSlug: 'higgsfield',
      modelLabel: 'Soul',
      modelSlug: 'soul',
      createTool: true,
      createModel: true,
    }]);
  });
});
