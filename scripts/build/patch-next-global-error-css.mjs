#!/usr/bin/env node

// With `experimental.inlineCss`, Next writes the root stylesheet into every document three times:
// the <style> tag, its copy in the RSC payload for the root layout, and a second copy in the
// payload's `G` entry, the global-error boundary's. `getGlobalErrorStyles` renders the boundary's CSS
// with an empty `injectedCSS` set, and Turbopack credits the boundary with the root layout's CSS, so
// nothing dedupes the two (vercel/next.js#98110, open; the code is unchanged through
// next@16.5.0-canary.25). The copy was 152 KB of every page's decoded HTML on 2026-10-20, and
// nothing in the app removes it: a global-error.tsx of our own is credited with the same CSS.
//
// This rewrites Next's compiled production app-page runtimes after install (the root postinstall):
// where a page's own tree renders (`getRSCPayload`), the boundary's styles leave out the CSS files the
// root layout writes. Those stay in the document when the boundary replaces the layout, because React
// keeps a stylesheet it has inserted, so the boundary is still styled. The error document
// (`getErrorRSCPayload`, drawn when the root layout itself fails on the server) has no root layout
// and keeps every style. Development never inlines CSS, so its runtimes are left alone.
//
// A runtime the patch no longer fits is reported and left as it is, and the install goes on:
// `next-global-error-css-patch.test.ts` then fails, and so does `npm run build:verify`
// (check-inline-css-copies.mjs) on the build. When Next fixes #98110, delete this file, its
// postinstall entry and its test.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PATCH_MARKER = '/*magicbooklet:global-error-css*/';

export const PATCHED_RUNTIMES = [
  'app-page-turbo.runtime.prod.js',
  'app-page.runtime.prod.js',
  'app-page-turbo-experimental.runtime.prod.js',
  'app-page-experimental.runtime.prod.js',
];

// Names the patch adds. `$` keeps them clear of the minifier's own, which are letters and digits.
const ROOT_LAYOUT_RENDERED = '$mbRootLayoutRendered';
const ROOT_LAYOUT_CSS = '$mbRootLayoutCss';

const ID = '[A-Za-z_$][\\w$]*';

function matchOnce(source, pattern, what) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`expected one ${what}, found ${matches.length}`);
  }
  return matches[0];
}

/**
 * The patched runtime, or the source unchanged with status 'already' when it carries the patch.
 * Throws, naming the piece it could not find, when the runtime no longer has the shape it patches.
 */
export function patchGlobalErrorCss(source) {
  if (source.includes(PATCH_MARKER)) return { source, status: 'already' };

  // createComponentStylesAndScripts, and the getLinkAndScriptTags it calls:
  // `{styles,scripts}=getLinkAndScriptTags(filePath,injectedCSS,injectedJS)`.
  const stylesAndScripts = matchOnce(source, new RegExp(
    `async function (${ID})\\(\\{filePath:(${ID}),getComponent:${ID},injectedCSS:(${ID}),injectedJS:(${ID}),ctx:(${ID})\\}\\)`
    + `\\{let\\{componentMod:\\{createElement:${ID}\\}\\}=\\5,\\{styles:${ID},scripts:${ID}\\}=(${ID})\\(\\2,\\3,\\4\\)`,
    'g',
  ), 'createComponentStylesAndScripts');
  const [, createStyles, , , , , linkTags] = stylesAndScripts;

  // getGlobalErrorStyles(tree, ctx), up to the call that renders the boundary's styles with an
  // empty injectedCSS set.
  const definition = matchOnce(source, new RegExp(
    `(${ID})=async\\((${ID}),(${ID})\\)=>\\{let (${ID})=(${ID})\\(\\2\\)\\.modules\\["global-error"\\];`
    + `([^]{0,400}?)=await ${createStyles.replace(/\$/g, '\\$')}\\(\\{ctx:\\3,filePath:\\4\\[1\\],getComponent:\\4\\[0\\],injectedCSS:new Set,injectedJS:new Set\\}\\)`,
    'g',
  ), 'getGlobalErrorStyles');
  const [whole, globalErrorStyles, tree, ctx, module, parseLoaderTree, between] = definition;
  if (between.includes('=>') || between.includes('function')) {
    throw new Error('getGlobalErrorStyles no longer calls createComponentStylesAndScripts directly');
  }
  const rootLayout = `${parseLoaderTree}(${tree}).modules.layout`;
  const patchedDefinition = `${globalErrorStyles}=async(${tree},${ctx},${ROOT_LAYOUT_RENDERED})=>{let ${module}=${parseLoaderTree}(${tree}).modules["global-error"];`
    + `${between}=await ${createStyles}({ctx:${ctx},filePath:${module}[1],getComponent:${module}[0],`
    + `injectedCSS:${PATCH_MARKER}(${ROOT_LAYOUT_CSS}=>(${ROOT_LAYOUT_RENDERED}&&${rootLayout}&&${linkTags}(${rootLayout}[1],${ROOT_LAYOUT_CSS},new Set,!0),${ROOT_LAYOUT_CSS}))(new Set),`
    + 'injectedJS:new Set})';

  // The two calls: getRSCPayload's, whose payload is the page's own tree (it carries the `P`
  // preloads), says the root layout rendered; getErrorRSCPayload's is left as it is.
  const escapedName = globalErrorStyles.replace(/\$/g, '\\$');
  const calls = [...source.matchAll(new RegExp(`=await ${escapedName}\\((${ID}),(${ID})\\)`, 'g'))];
  if (calls.length !== 2) throw new Error(`expected two getGlobalErrorStyles calls, found ${calls.length}`);
  const pageCall = matchOnce(source, new RegExp(
    `=await ${escapedName}\\((${ID}),(${ID})\\)(?=,[^;]*;return ${ID}\\(${ID},\\{P:)`,
    'g',
  ), 'getGlobalErrorStyles call in getRSCPayload');

  const definitionAt = definition.index;
  const callAt = pageCall.index;
  const pieces = [
    { at: definitionAt, length: whole.length, text: patchedDefinition },
    { at: callAt, length: pageCall[0].length, text: `=await ${globalErrorStyles}(${pageCall[1]},${pageCall[2]},!0)` },
  ].sort((left, right) => right.at - left.at);
  let patched = source;
  for (const { at, length, text } of pieces) {
    patched = patched.slice(0, at) + text + patched.slice(at + length);
  }
  return { source: patched, status: 'patched' };
}

export function patchInstalledNext({ nextDirectory } = {}) {
  const directory = nextDirectory ?? path.dirname(createRequire(import.meta.url).resolve('next/package.json'));
  const version = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')).version;
  const results = [];
  for (const runtime of PATCHED_RUNTIMES) {
    const file = path.join(directory, 'dist', 'compiled', 'next-server', runtime);
    try {
      const { source, status } = patchGlobalErrorCss(readFileSync(file, 'utf8'));
      if (status === 'patched') writeFileSync(file, source);
      results.push({ runtime, status });
    } catch (error) {
      results.push({ runtime, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { version, results };
}

function main() {
  let outcome;
  try {
    outcome = patchInstalledNext();
  } catch (error) {
    console.warn(`patch-next-global-error-css: next is not installed here (${error instanceof Error ? error.message : error}).`);
    return;
  }
  const failed = outcome.results.filter((result) => result.status === 'failed');
  if (failed.length > 0) {
    console.warn(
      `patch-next-global-error-css: next@${outcome.version} no longer has the shape this patch rewrites:\n`
      + failed.map((result) => `  ${result.runtime}: ${result.reason}`).join('\n')
      + '\nIf vercel/next.js#98110 is fixed in this version, delete scripts/build/patch-next-global-error-css.mjs, '
      + 'its postinstall entry and its test; otherwise update the patch to the new runtime.',
    );
    return;
  }
  const patched = outcome.results.filter((result) => result.status === 'patched').length;
  console.log(
    `patch-next-global-error-css: next@${outcome.version}, the global-error boundary skips the root layout's CSS `
    + `(${patched} runtime(s) patched, ${outcome.results.length - patched} already).`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
