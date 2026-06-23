import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('workflow asset upload boundary', () => {
  it('routes workflow node uploads through the signed upload helper', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/app/create-workflow/CreateWorkflowClient.tsx'),
      'utf8'
    );

    expect(source).toContain('uploadWorkflowAssetWithSignedIntent');
    expect(source).not.toMatch(/storage\.from\([^)]*\)\.upload\(/);
    expect(source).not.toMatch(/storage\s*\.\s*from\([^)]*\)\s*\.\s*createSignedUrl\(/);
  });
});
