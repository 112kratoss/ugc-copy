import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Next image local media policy', () => {
  it('allows query-bearing URLs from only the authenticated media proxy path', () => {
    const config = fs.readFileSync(path.join(process.cwd(), 'next.config.ts'), 'utf8');

    expect(config).toContain('localPatterns: [{ pathname: "/api/media" }]');
    expect(config).not.toMatch(/localPatterns:\s*\[\{\s*pathname:\s*["']\/api\/\*\*/);
  });
});
