import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const generationClients = [
  'src/app/create-image/CreateImageClient.tsx',
  'src/app/create-motion/CreateMotionClient.tsx',
  'src/app/create-video/CreateVideoClient.tsx',
];

describe('web generation status polling boundary', () => {
  it.each(generationClients)('%s uses the validated shared status client', (filePath) => {
    const source = readFileSync(join(projectRoot, filePath), 'utf8');

    expect(source).toContain("from '@/lib/generation-status-client'");
    expect(source).toContain('fetchGenerationStatus');
    expect(source).not.toMatch(/const response = await fetch\(`\/api\/generate(?:-image|-video)?\?id=/);
  });
});
