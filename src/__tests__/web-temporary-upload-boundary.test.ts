import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const temporaryUploadClients = [
  'src/app/create-image/CreateImageClient.tsx',
  'src/app/create-video/CreateVideoClient.tsx',
  'src/app/create-motion/CreateMotionClient.tsx',
] as const;

describe('web temporary upload boundary', () => {
  it('routes creator reference uploads through the shared signed upload helper', () => {
    for (const filePath of temporaryUploadClients) {
      const source = readFileSync(path.join(process.cwd(), filePath), 'utf8');

      expect(source).toContain("uploadMediaToTemporaryStorage");
      expect(source).not.toMatch(/storage\.from\([^)]*\)\.upload\(/);
      expect(source).not.toMatch(/storage\s*\.\s*from\([^)]*\)\s*\.\s*createSignedUrl\(/);
    }
  });
});
