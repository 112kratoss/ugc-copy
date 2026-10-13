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

  it('keeps creator storage out of the account menu until sign-out needs it', () => {
    const source = readFileSync(join(projectRoot, 'src/components/AppShellAccount.tsx'), 'utf8');

    // The account menu loads on every signed-in page; localforage would ride along.
    expect(source).toContain("import('@/lib/persisted-media')");
    expect(source).not.toMatch(/from ['"]@\/lib\/persisted-(media|creator-draft)['"]/);
    expect(source).not.toMatch(/from ['"]localforage['"]/);
  });

  it('keeps creator media in the one current database', () => {
    const source = readFileSync(join(projectRoot, 'src/lib/persisted-media.ts'), 'utf8');

    // The earlier databases held files saved for no particular account.
    expect(source.match(/createInstance\(/g)).toHaveLength(1);
    expect(source).toContain("name: 'magicbooklet-persisted-media'");
  });
});

