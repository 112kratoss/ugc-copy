import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PATCH_MARKER,
  PATCHED_RUNTIMES,
  patchGlobalErrorCss,
} from '../../scripts/build/patch-next-global-error-css.mjs';

// The pieces of next@16.3.3's app-page-turbo.runtime.prod.js the patch rewrites, as minified there:
// getLinkAndScriptTags (r2), createComponentStylesAndScripts (nt), getGlobalErrorStyles (s1), and the
// two payloads that call it, getRSCPayload's (the page's own tree; it carries the `P` preloads) and
// getErrorRSCPayload's. What they call is stubbed above them: the client reference manifest (rA.QJ),
// parseLoaderTree (r5), renderCssResource (ne, here the paths of the sheets it would render).
const RUNTIME_EXCERPT = [
  'const rA={QJ:()=>manifest};function r5(e){return{modules:e[2]}}function ne(s){return[...s].map(c=>c.path)}',
  'function rY(e){return e}function r7(){return""}function r9(e){return e}function se(t,p){return p}function y(){return null}const sg=null;',
  'function r2(e,t,r,n){let a=e.replace(/\\.[^.]+$/,""),i=new Set,s=new Set,{entryCSSFiles:o,entryJSFiles:l}=(0,rA.QJ)(),u=o[a],c=null==l?void 0:l[a];if(u)for(let e of u)t.has(e.path)||(n&&t.add(e.path),i.add(e));if(c)for(let e of c)r.has(e)||(n&&r.add(e),s.add(e));return{styles:i,scripts:s}}',
  'async function nt({filePath:e,getComponent:t,injectedCSS:r,injectedJS:n,ctx:a}){let{componentMod:{createElement:i}}=a,{styles:s,scripts:o}=r2(e,r,n),l=ne(s,a),u=[],c=0;for(let e of o)u.push(i("script",{src:`${a.assetPrefix}/_next/${rY(e)}${r7(a,!0)}`,async:!0,key:`script-${c}`})),c++;return[r9(await t()),l,u.length?u:null]}',
  'let s1=async(e,t)=>{let r=r5(e).modules["global-error"];if(!r)throw Object.defineProperty(Error("Invariant: global-error module is required but not found in loader tree"),"__NEXT_ERROR_CODE",{value:"E983",enumerable:!1,configurable:!0});let{componentMod:{createElement:n}}=t,[a,i]=await nt({ctx:t,filePath:r[1],getComponent:r[0],injectedCSS:new Set,injectedJS:new Set});return{GlobalError:a,styles:i}};',
  'async function page(e,t){let S={isStaticGeneration:!1},g=[],{GlobalError:D,styles:$}=await s1(e,t),N=S.isStaticGeneration&&!0===t.renderOpts.experimental.isRoutePPREnabled;return se(t,{P:y(sg,{preloadCallbacks:g}),G:[D,$]})}',
  'async function errorPage(e,t){let f={isStaticGeneration:!1},d="/",{GlobalError:S,styles:w}=await s1(e,t),_=f.isStaticGeneration&&!0===t.renderOpts.experimental.isRoutePPREnabled;return se(t,{c:d,G:[S,w]})}',
  'return{page,errorPage};',
].join('');

type Payload = { G: [unknown, string[]] };
type Excerpt = { page: (tree: unknown, ctx: unknown) => Promise<Payload>; errorPage: (tree: unknown, ctx: unknown) => Promise<Payload> };

// The root layout's sheet, which Turbopack also credits to the built-in global-error, and one that
// only a global-error.tsx of an app's own would import.
const manifest = {
  entryCSSFiles: {
    'app/layout': [{ path: 'static/chunks/root.css', inlined: true }],
    'next/dist/client/components/builtin/global-error': [
      { path: 'static/chunks/root.css', inlined: true },
      { path: 'static/chunks/global-error-own.css', inlined: true },
    ],
  },
  entryJSFiles: {},
};
const GlobalError = () => null;
const tree = (modules: Record<string, unknown>) => ['', {}, modules];
const withRootLayout = tree({
  layout: [() => null, 'app/layout.tsx'],
  'global-error': [() => GlobalError, 'next/dist/client/components/builtin/global-error.js'],
});
// Several root layouts under route groups leave the root segment without a layout.
const withoutRootLayout = tree({
  'global-error': [() => GlobalError, 'next/dist/client/components/builtin/global-error.js'],
});
const ctx = { componentMod: { createElement: () => null }, renderOpts: { experimental: {} }, assetPrefix: '' };

function load(source: string): Excerpt {
  return new Function('manifest', source)(manifest) as Excerpt;
}

describe('the Next global-error stylesheet patch (vercel/next.js#98110)', () => {
  it('reproduces the third copy: unpatched, the boundary renders the root layout\'s sheet again on every page', async () => {
    const excerpt = load(RUNTIME_EXCERPT);
    expect((await excerpt.page(withRootLayout, ctx)).G[1]).toEqual(['static/chunks/root.css', 'static/chunks/global-error-own.css']);
  });

  it('leaves the root layout\'s sheets out of a page\'s global-error styles and keeps the boundary\'s own', async () => {
    const { source, status } = patchGlobalErrorCss(RUNTIME_EXCERPT);
    expect(status).toBe('patched');
    const excerpt = load(source);
    expect((await excerpt.page(withRootLayout, ctx)).G[1]).toEqual(['static/chunks/global-error-own.css']);
    // The boundary itself still renders.
    expect((await excerpt.page(withRootLayout, ctx)).G[0]).toBe(GlobalError);
  });

  it('keeps every sheet in the error document, which has no root layout to have written them', async () => {
    const excerpt = load(patchGlobalErrorCss(RUNTIME_EXCERPT).source);
    expect((await excerpt.errorPage(withRootLayout, ctx)).G[1]).toEqual(['static/chunks/root.css', 'static/chunks/global-error-own.css']);
  });

  it('keeps every sheet when the root segment has no layout of its own', async () => {
    const excerpt = load(patchGlobalErrorCss(RUNTIME_EXCERPT).source);
    expect((await excerpt.page(withoutRootLayout, ctx)).G[1]).toEqual(['static/chunks/root.css', 'static/chunks/global-error-own.css']);
  });

  it('is applied once: a patched runtime is left as it is', () => {
    const once = patchGlobalErrorCss(RUNTIME_EXCERPT).source;
    expect(once.split(PATCH_MARKER)).toHaveLength(2);
    expect(patchGlobalErrorCss(once)).toEqual({ source: once, status: 'already' });
  });

  it('refuses a runtime of another shape rather than patching part of it', () => {
    // The boundary's styles no longer start from an empty set (as a fix upstream might do).
    expect(() => patchGlobalErrorCss(RUNTIME_EXCERPT.replace('injectedCSS:new Set,injectedJS:new Set', 'injectedCSS:e[3],injectedJS:new Set')))
      .toThrow(/getGlobalErrorStyles/);
    // getRSCPayload's call is not the one carrying the preloads.
    expect(() => patchGlobalErrorCss(RUNTIME_EXCERPT.replace('{P:y(sg', '{p:y(sg'))).toThrow(/getRSCPayload/);
    expect(() => patchGlobalErrorCss(RUNTIME_EXCERPT.replace('async function nt(', 'async function nt2('))).toThrow();
  });

  // A Next upgrade that changes these runtimes fails here, on every checkout: the postinstall only
  // warns, so that an install never stops on it.
  it('fits every production app-page runtime of the installed Next', () => {
    const next = path.dirname(createRequire(import.meta.url).resolve('next/package.json'));
    for (const runtime of PATCHED_RUNTIMES) {
      const source = readFileSync(path.join(next, 'dist', 'compiled', 'next-server', runtime), 'utf8');
      const { source: patched } = patchGlobalErrorCss(source);
      expect(patched.split(PATCH_MARKER), runtime).toHaveLength(2);
      expect(patched, runtime).toMatch(/=await [\w$]+\([\w$]+,[\w$]+,!0\),[^;]*;return [\w$]+\([\w$]+,\{P:/);
    }
  });
});
