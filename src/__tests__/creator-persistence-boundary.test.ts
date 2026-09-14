import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();

describe('creator media persistence hooks', () => {
  it('keeps image persistence stable without hook-rule suppression', () => {
    const source = readFileSync(
      join(projectRoot, 'src/app/create-image/CreateImageClient.tsx'),
      'utf8'
    );

    expect(source).toContain('const persistUploadedImageElements = useCallback(async');
    expect(source).not.toContain('eslint-disable-line react-hooks/exhaustive-deps');
  });

  it('keeps video element persistence stable without hook-rule suppression', () => {
    const source = readFileSync(
      join(projectRoot, 'src/app/create-video/CreateVideoClient.tsx'),
      'utf8'
    );

    expect(source).toContain('const persistVideoElements = useCallback(async');
    // Capacity changes now preserve draft media; interaction tests cover that behavior.
    expect(source).not.toContain('eslint-disable-line react-hooks/exhaustive-deps');
  });
});
