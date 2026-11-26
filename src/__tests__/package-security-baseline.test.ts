import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  overrides?: Record<string, unknown>;
};

type PackageLock = {
  packages?: Record<string, {
    version?: string;
    dev?: boolean;
    dependencies?: Record<string, string>;
  }>;
};

const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as PackageJson;
const packageLock = JSON.parse(readFileSync(join(projectRoot, 'package-lock.json'), 'utf8')) as PackageLock;

function numericVersion(version: string): number[] {
  const cleanVersion = version.replace(/^[^\d]*/, '').split('-')[0] ?? '';
  return cleanVersion.split('.').map((part) => Number(part));
}

function versionAtLeast(version: string | undefined, floor: string): boolean {
  if (!version) return false;

  const current = numericVersion(version);
  const minimum = numericVersion(floor);
  for (let index = 0; index < Math.max(current.length, minimum.length); index += 1) {
    const left = current[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }

  return true;
}

function packageLockVersion(name: string): string | undefined {
  return packageLock.packages?.[`node_modules/${name}`]?.version;
}

function packageLockPathVersion(path: string): string | undefined {
  return packageLock.packages?.[path]?.version;
}

describe('package security baseline', () => {
  it('pins the Vercel server runtime above Node 20 before Supabase drops support', () => {
    expect(packageJson.engines?.node).toBe('>=22 <25');
    expect(packageJson.devDependencies?.['@types/node']).toBe('^22');
    expect(versionAtLeast(packageLockVersion('@types/node'), '22.0.0')).toBe(true);
  });

  it('keeps Supabase clients on the ws-free client generation', () => {
    expect(packageJson.dependencies?.['@supabase/supabase-js']).toBe('2.108.2');
    expect(packageJson.dependencies?.['@supabase/ssr']).toBe('0.12.0');
    expect(packageLockVersion('@supabase/supabase-js')).toBe('2.108.2');
    expect(packageLockVersion('@supabase/realtime-js')).toBe('2.108.2');
    expect(
      packageLock.packages?.['node_modules/@supabase/realtime-js']?.dependencies?.ws
    ).toBeUndefined();

    // Developer tooling may use WebSockets without reintroducing ws into the
    // browser/production Supabase client graph.
    const hoistedWs = packageLock.packages?.['node_modules/ws'];
    if (hoistedWs) {
      expect(hoistedWs.dev).toBe(true);
    }
  });

  it('does not ship the legacy markdown front-matter parser in production dependencies', () => {
    expect(packageJson.dependencies?.['gray-matter']).toBeUndefined();
    expect(packageLockVersion('gray-matter')).toBeUndefined();
  });

  it('keeps the production Next.js runtime above audited vulnerable ranges', () => {
    expect(versionAtLeast(packageJson.dependencies?.next, '16.3.1')).toBe(true);
    expect(versionAtLeast(packageLockVersion('next'), '16.3.1')).toBe(true);
  });

  it('keeps production PostCSS above the audited source-map disclosure range', () => {
    expect(packageJson.overrides).toMatchObject({
      next: {
        postcss: '^8.5.23',
      },
    });
    const resolvedPostCss = packageLockPathVersion('node_modules/next/node_modules/postcss')
      ?? packageLockVersion('postcss');
    expect(versionAtLeast(resolvedPostCss, '8.5.23')).toBe(true);
  });

  it('keeps 2026 transitive dependency remediations in the lockfile', () => {
    // brace-expansion (security audit, 2026-11-26). One global pin at 5.0.9
    // was the last 5.x that minimatch 3 (ESLint's) can call: 5.0.10 and later
    // export `expand` by name only, and ESLint then dies with "expand is not a
    // function". But 4.0.0 to 5.0.11 carry two denial-of-service advisories.
    // So minimatch 3 gets the 1.x line it was written for, and every other
    // copy resolves to a fixed 5.x.
    expect(packageJson.overrides).not.toHaveProperty('brace-expansion');
    expect(packageJson.overrides).toMatchObject({
      'minimatch@3.1.5': { 'brace-expansion': '1.1.22' },
    });
    expect(packageLockVersion('minimatch')).toBe('3.1.5');
    const braceExpansions = Object.entries(packageLock.packages ?? {})
      .filter(([path]) => path.endsWith('node_modules/brace-expansion'))
      .map(([path, entry]) => ({ path, version: entry.version ?? '' }));
    expect(braceExpansions.length).toBeGreaterThan(0);
    for (const { path, version } of braceExpansions) {
      const [major] = numericVersion(version);
      const fixed = major === 1 ? versionAtLeast(version, '1.1.12')
        : major === 2 ? versionAtLeast(version, '2.0.2')
          : versionAtLeast(version, '5.0.12');
      expect(fixed, `${path}@${version}`).toBe(true);
    }
    expect(numericVersion(packageLockVersion('brace-expansion') ?? '')[0]).toBe(1);
    expect(versionAtLeast(packageLockVersion('nanoid'), '3.3.18')).toBe(true);
    expect(versionAtLeast(packageLockVersion('undici'), '7.29.0')).toBe(true);
    expect(versionAtLeast(packageLockVersion('ip-address'), '10.5.0')).toBe(true);
    expect(versionAtLeast(packageLockVersion('js-yaml'), '4.3.1')).toBe(true);
    expect(versionAtLeast(
      packageLockPathVersion('node_modules/@lhci/utils/node_modules/js-yaml'),
      '3.15.1',
    )).toBe(true);
  });

  it('keeps React runtime packages on the patched React 19.2 line', () => {
    expect(versionAtLeast(packageJson.dependencies?.react, '19.2.4')).toBe(true);
    expect(versionAtLeast(packageJson.dependencies?.['react-dom'], '19.2.4')).toBe(true);
    expect(versionAtLeast(packageLockVersion('react'), '19.2.4')).toBe(true);
    expect(versionAtLeast(packageLockVersion('react-dom'), '19.2.4')).toBe(true);
  });

  it('keeps Next.js lint/config tooling aligned with the runtime patch level', () => {
    expect(versionAtLeast(packageJson.devDependencies?.['eslint-config-next'], '16.3.1')).toBe(true);
    expect(versionAtLeast(packageLockVersion('eslint-config-next'), '16.3.1')).toBe(true);
  });

  it('does not ship live-looking local service-role secrets in the local development guide', () => {
    const localWorkflow = readFileSync(join(projectRoot, 'docs/local-development.md'), 'utf8');

    expect(localWorkflow).not.toMatch(/sb_secret_[A-Za-z0-9_-]{16,}/);
    expect(localWorkflow).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY=(?!your-|\[REDACTED\]|<)[^\s#]+/);
  });
});
