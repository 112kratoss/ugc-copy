import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { transformSync, type PluginItem, type TransformOptions } from '@babel/core';
import { describe, expect, it } from 'vitest';

// React Compiler skips a component without a word when it breaks a rule the
// compiler checks: a ref read during render, a try…finally, a callback that
// reads its own binding. The screens people spend their time in are pinned here,
// so a change that knocks one of them back to uncompiled fails a test instead of
// quietly making every scroll and swipe re-render more.

const mobileRoot = path.resolve(__dirname, '..');
const requireFromMobile = createRequire(path.join(mobileRoot, 'package.json'));

const SCREENS = [
  ['components/home-dashboard.tsx', 'HomeDashboard'],
  ['app/(tabs)/showcase.tsx', 'ShowcaseScreen'],
  ['app/viewer.tsx', 'ImmersivePreviewViewerScreen'],
] as const;

const metroCaller = {
  name: 'metro',
  bundler: 'metro',
  platform: 'ios',
  engine: 'hermes',
  isDev: false,
  isServer: false,
  isNodeModule: false,
};

type CompilerEvent = { kind: string; fnName?: string | null; detail?: { reason?: string; options?: { reason?: string } } };

/** The compiler options babel.config.js gives app code, with a logger added. */
function compilerOptionsFromBabelConfig(logger: { logEvent: (filename: string | null, event: CompilerEvent) => void }) {
  const createConfig = requireFromMobile('./babel.config.js') as (api: {
    caller: (read: (caller: typeof metroCaller) => unknown) => unknown;
  }) => { plugins: PluginItem[] };
  const config = createConfig({ caller: (read) => read(metroCaller) });
  const entry = config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'babel-plugin-react-compiler');
  if (!Array.isArray(entry)) throw new Error('babel.config.js no longer adds the React Compiler for app code.');
  return { ...(entry[1] as Record<string, unknown>), logger };
}

function compilerEvents(relativePath: string) {
  const events: CompilerEvent[] = [];
  const filename = path.join(mobileRoot, relativePath);
  transformSync(readFileSync(filename, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename,
    caller: metroCaller as unknown as TransformOptions['caller'],
    presets: [requireFromMobile.resolve('babel-preset-expo')],
    plugins: [[
      requireFromMobile.resolve('babel-plugin-react-compiler'),
      compilerOptionsFromBabelConfig({ logEvent: (_filename, event) => events.push(event) }),
    ]],
    code: false,
  });
  return events;
}

describe('compiled screens', () => {
  it.each(SCREENS)('%s compiles %s', (file, screen) => {
    const events = compilerEvents(file);
    const bailOuts = events
      .filter((event) => event.kind === 'CompileError')
      .map((event) => event.detail?.reason ?? event.detail?.options?.reason ?? 'unknown');

    expect(
      events.some((event) => event.kind === 'CompileSuccess' && event.fnName === screen),
      `React Compiler skipped ${screen}. Bail-outs in ${file}: ${JSON.stringify(bailOuts)}`,
    ).toBe(true);
  }, 60_000);
});
