import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
  overrides?: Record<string, string>;
};
const packageLock = JSON.parse(readFileSync(join(projectRoot, 'package-lock.json'), 'utf8')) as {
  packages?: Record<string, { version?: string }>;
};

function versionAtLeast(packageName: string, minimum: string) {
  const version = packageLock.packages?.[`node_modules/${packageName}`]?.version;
  if (!version) return false;

  const current = version.split('.').map(Number);
  const floor = minimum.split('.').map(Number);
  for (let index = 0; index < Math.max(current.length, floor.length); index += 1) {
    if ((current[index] ?? 0) > (floor[index] ?? 0)) return true;
    if ((current[index] ?? 0) < (floor[index] ?? 0)) return false;
  }
  return true;
}

describe('mobile dependency security baseline', () => {
  it('keeps directly remediated transitive dependencies above their advisory ranges', () => {
    expect(packageJson.overrides?.['brace-expansion']).toBe('5.0.9');
    expect(versionAtLeast('brace-expansion', '5.0.9')).toBe(true);
    expect(versionAtLeast('nanoid', '3.3.18')).toBe(true);
    expect(versionAtLeast('postcss', '8.5.23')).toBe(true);
    expect(versionAtLeast('js-yaml', '3.15.1')).toBe(true);
  });
});
