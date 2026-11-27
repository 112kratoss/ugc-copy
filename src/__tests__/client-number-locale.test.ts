import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// A number formatted with the browser's own locale hydrates other text than the server's (en-US):
// "1.000" in a German browser against the server's "1,000" (audit 2026-11-27). These client files
// draw on the server too, so each pins 'en-US', as `src/lib/pricing.ts` does.
const FILES = [
  'src/app/pricing/PricingClient.tsx',
  'src/components/templates/TemplatePrimitives.tsx',
  'src/components/templates/TemplateDetailClient.tsx',
];

describe('numbers the server and the browser both draw', () => {
  it.each(FILES)('%s formats with a pinned locale', (file) => {
    const source = readFileSync(path.join(process.cwd(), file), 'utf8');
    expect(source).not.toMatch(/\.toLocaleString\(\)/);
  });
});
