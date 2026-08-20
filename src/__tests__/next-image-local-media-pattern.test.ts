import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Next image local media policy', () => {
  it('allows static preview art and query-bearing URLs only from the media proxy', () => {
    const config = fs.readFileSync(path.join(process.cwd(), 'next.config.ts'), 'utf8');

    expect(config).toContain('{ pathname: "/assets/images/**", search: "" }');
    expect(config).toContain('{ pathname: "/api/media" }');
    expect(config).not.toMatch(/pathname:\s*["']\/assets\/images\/\*\*["']\s*\}/);
    expect(config).not.toMatch(/pathname:\s*["']\/api\/\*\*/);
  });
});
