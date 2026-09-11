import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { transformSync, type PluginItem } from '@babel/core';
import { describe, expect, it, vi } from 'vitest';

// Guards the two hooks in bundler/ that keep dead weight out of the native
// bundles: lucide icons imported one module at a time, and RevenueCat's browser
// implementation replaced by a stand-in on iOS and Android. Together they took
// the Android Hermes bundle from 6.48 MB to 4.60 MB (2026-09-12).

const mobileRoot = path.resolve(__dirname, '..');
const requireFromMobile = createRequire(path.join(mobileRoot, 'package.json'));
const lucideDirectImports = requireFromMobile('./bundler/lucide-direct-imports.js') as PluginItem;
const presetTypescript = requireFromMobile.resolve('@babel/preset-typescript');

function transform(code: string, filename = path.join(mobileRoot, 'fixture.tsx')) {
  const result = transformSync(code, {
    babelrc: false,
    configFile: false,
    filename,
    plugins: [lucideDirectImports],
    presets: [presetTypescript],
  });
  return (result?.code ?? '').replaceAll("'", '"');
}

function importsOf(code: string) {
  return [...code.matchAll(/^import\s+(.+?)\s+from\s+"([^"]+)";$/gm)].map(([, what, from]) => ({ what, from }));
}

function sourceFilesImporting(specifier: string) {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.tsx?$/.test(entry) && readFileSync(full, 'utf8').includes(`from '${specifier}'`)) found.push(full);
    }
  };
  for (const dir of ['app', 'components', 'lib']) visit(path.join(mobileRoot, dir));
  return found;
}

describe('lucide direct imports', () => {
  it('imports each icon from its own module, never the barrel', () => {
    const out = transform(`
      import { Camera, X as Close, LucideProvider } from 'lucide-react-native';
      export const used = [Camera, Close, LucideProvider];
    `);

    expect(importsOf(out)).toEqual([
      { what: 'Camera', from: 'lucide-react-native/dist/esm/icons/camera.mjs' },
      { what: 'Close', from: 'lucide-react-native/dist/esm/icons/x.mjs' },
      { what: '{ LucideProvider }', from: 'lucide-react-native/dist/esm/context.mjs' },
    ]);
  });

  it("follows the package's own aliases rather than guessing file names", () => {
    // `Home` lives in house.mjs; kebab-casing the name would look for home.mjs.
    const out = transform(`import { Home } from 'lucide-react-native'; export const used = Home;`);

    expect(importsOf(out)).toEqual([{ what: 'Home', from: 'lucide-react-native/dist/esm/icons/house.mjs' }]);
  });

  it('drops type-only imports instead of importing the barrel for them', () => {
    const out = transform(`
      import { type LucideIcon, Camera } from 'lucide-react-native';
      import type { LucideProps } from 'lucide-react-native';
      export const used: LucideIcon = Camera;
      export type Props = LucideProps;
    `);

    expect(importsOf(out)).toEqual([{ what: 'Camera', from: 'lucide-react-native/dist/esm/icons/camera.mjs' }]);
  });

  it('fails the build rather than falling back to the barrel', () => {
    expect(() => transform(`import { NotAnIcon } from 'lucide-react-native'; export const used = NotAnIcon;`))
      .toThrow(/no runtime export named "NotAnIcon"/);
    expect(() => transform(`import * as Icons from 'lucide-react-native'; export const used = Icons;`))
      .toThrow(/by name/);
    expect(() => transform(`import 'lucide-react-native';`)).toThrow(/evaluates every icon/);
  });

  it('rewrites every lucide import in the app without reaching the barrel', () => {
    const files = sourceFilesImporting('lucide-react-native');
    expect(files.length).toBeGreaterThan(40);

    for (const file of files) {
      const imports = importsOf(transform(readFileSync(file, 'utf8'), file));
      const lucide = imports.filter(({ from }) => from.startsWith('lucide-react-native'));
      expect(lucide.length, file).toBeGreaterThan(0);
      for (const { from } of lucide) expect(from, file).toMatch(/^lucide-react-native\/dist\/esm\/.+\.mjs$/);
    }
  });
});

describe('metro resolution', () => {
  type Resolution = { type: string; filePath?: string };
  type Context = { originModulePath: string; resolveRequest: (...args: unknown[]) => Resolution };
  const config = requireFromMobile('./metro.config.js') as {
    resolver: { resolveRequest: (context: Context, moduleName: string, platform: string | null) => Resolution };
  };
  const purchasesEntry = path.join(mobileRoot, 'node_modules/react-native-purchases/dist/purchases.js');

  function resolve(moduleName: string, platform: string | null, originModulePath = purchasesEntry) {
    const resolveRequest = vi.fn((): Resolution => ({ type: 'default' }));
    return config.resolver.resolveRequest({ originModulePath, resolveRequest }, moduleName, platform);
  }

  it("gives native bundles a stand-in for RevenueCat's browser implementation", () => {
    for (const platform of ['ios', 'android']) {
      expect(resolve('./browser/nativeModule', platform)).toEqual({
        type: 'sourceFile',
        filePath: path.join(mobileRoot, 'bundler', 'revenuecat-browser-stub.js'),
      });
    }
  });

  it('keeps the real module on web and leaves every other request to Metro', () => {
    expect(resolve('./browser/nativeModule', 'web')).toEqual({ type: 'default' });
    expect(resolve('./browser/nativeModule', 'ios', path.join(mobileRoot, 'lib/purchases.js'))).toEqual({ type: 'default' });
    expect(resolve('react', 'ios')).toEqual({ type: 'default' });
  });

  it('resolves deep icon imports to files that exist', () => {
    const resolution = resolve('lucide-react-native/dist/esm/icons/house.mjs', 'android');

    expect(resolution.type).toBe('sourceFile');
    expect(existsSync(resolution.filePath ?? '')).toBe(true);
  });
});

describe('RevenueCat browser stand-in', () => {
  const dist = path.join(mobileRoot, 'node_modules/react-native-purchases/dist');

  it('covers everything purchases.js reads from the browser module, and only in browser mode', () => {
    const source = readFileSync(path.join(dist, 'purchases.js'), 'utf8');
    const binding = source.match(/var (\w+) = require\("\.\/browser\/nativeModule"\);/)?.[1];
    expect(binding).toBeDefined();

    // An SDK update that reads anything else from it, or reads it outside
    // browser mode, needs the stand-in revisited before it can ship.
    const reads = new Set([...source.matchAll(new RegExp(`\\b${binding}\\.(\\w+)`, 'g'))].map(([, name]) => name));
    expect([...reads]).toEqual(['browserNativeModuleRNPurchases']);
    expect(source).toMatch(new RegExp(`usingBrowserMode \\? ${binding}\\.browserNativeModuleRNPurchases :`));
    expect(requireFromMobile('./bundler/revenuecat-browser-stub.js')).toEqual({ browserNativeModuleRNPurchases: null });
  });

  it('is the only way the SDK reaches its browser code outside the browser folder', () => {
    const requirers = readdirSync(dist)
      .filter((entry) => entry.endsWith('.js'))
      .filter((entry) => /require\("\.\/browser\//.test(readFileSync(path.join(dist, entry), 'utf8')));

    expect(requirers).toEqual(['purchases.js']);
  });
});
