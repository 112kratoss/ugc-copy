import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();

function readProjectFile(relativePath: string) {
  return readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

describe('top tab performance contracts', () => {
  it('keeps first-load Studio and Showcase code off the Framer Motion bundle', () => {
    const firstLoadFiles = [
      'src/app/creations/page.tsx',
      'src/app/showcase/ShowcaseClient.tsx',
      'src/app/components/PublishToShowcaseModal.tsx',
      'src/app/components/MediaDetailsPreviewModal.tsx',
    ];

    for (const file of firstLoadFiles) {
      expect(readProjectFile(file), `${file} should use CSS transitions instead`).not.toContain('framer-motion');
    }
  });
});
