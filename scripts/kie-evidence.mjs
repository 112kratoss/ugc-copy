#!/usr/bin/env node
/**
 * Fetch provider evidence for Kie.ai models: the exact `model` enum values,
 * input field names, and market-page pricing that model onboarding requires.
 *
 * Kie serves pricing only on its marketing pages (no API carries it) and blocks
 * non-browser user agents with Cloudflare, so every fetch here sends a browser
 * UA. Docs paths do NOT equal model ids (market/qwen3-pro/* is really
 * qwen3/pro-*) — always read the enum out of the spec body this script prints.
 *
 * Usage:
 *   node scripts/kie-evidence.mjs slugs                 # all market slugs from the sitemap
 *   node scripts/kie-evidence.mjs price <market-slug>   # credit lines from kie.ai/<slug>
 *   node scripts/kie-evidence.mjs spec <docs-path>      # model enum + input fields from docs.kie.ai/market/<path>.md
 *
 * Examples:
 *   node scripts/kie-evidence.mjs price kling-o3
 *   node scripts/kie-evidence.mjs spec bytedance/seedance-2-5
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'user-agent': UA } });
  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`);
  }
  return response.text();
}

async function slugs() {
  const xml = await fetchText('https://kie.ai/sitemaps/models-0.xml');
  const matches = [...xml.matchAll(/<loc>https:\/\/kie\.ai\/([^<]+)<\/loc>/g)]
    .map((match) => match[1])
    .sort();
  for (const slug of matches) console.log(slug);
  console.error(`\n${matches.length} market slugs.`);
}

/**
 * Lines that change what a published price MEANS without themselves quoting one.
 * Seedance 2.5's 1080p tier listed 114 / 68.5 credits/s under "Limited-Time 1080P Offer:
 * 28% OFF until Sep 17, 2026 06:00 UTC (prices above already reflect the discount)" — no
 * digit-plus-"credits" anywhere in it, so the credit scan below never printed it and the
 * figures read as permanent. A catalog release does not reprice itself on a date, so
 * pinning a discounted rate silently under-bills the moment the offer lapses.
 */
const QUALIFIER_PATTERN = /[^"\n]{0,80}(?:limited[- ]time|% off|discount|promotion|promotional|offer ends|until \w+ \d|\d+% of the official)[^"\n]{0,160}/gi;

async function price(slug) {
  const html = (await fetchText(`https://kie.ai/${slug}`)).replaceAll('\\n', '\n');
  const seen = new Set();
  const pattern = /[^"\n]{0,60}\d[\d.]* credits?(?:\/s|\/second| per [a-z0-9 ]+)?[^"\n]{0,120}/g;
  for (const match of html.matchAll(pattern)) {
    const line = match[0].trim();
    if (!seen.has(line) && !/threshold|bonus/i.test(line)) {
      seen.add(line);
      console.log(line);
    }
  }
  if (seen.size === 0) {
    console.error('No credit lines found — the model may be unpriced (see PixVerse precedent).');
    process.exitCode = 2;
  }

  // Scan only this model's own pricingDesc. Scanning the whole page drowns the signal in
  // the site's i18n bundle, which is full of unrelated discount strings.
  const qualifiers = new Set();
  for (const block of html.matchAll(/"pricingDesc":"((?:[^"\\]|\\.)*)"/g)) {
    const desc = block[1].replaceAll('\\n', '\n').replaceAll('\\"', '"');
    for (const line of desc.split('\n')) {
      if (QUALIFIER_PATTERN.test(line.trim())) qualifiers.add(line.trim());
      QUALIFIER_PATTERN.lastIndex = 0;
    }
  }
  if (qualifiers.size > 0) {
    console.error('\n!! This model\'s price carries a qualifier. Do NOT pin the figures as-is:');
    for (const line of qualifiers) console.error(`   ${line}`);
    console.error('   Work out the undiscounted rate, or confirm the intent, before shipping.');
  }
}

/**
 * Collect the lines indented deeper than a `key:` line — i.e. that key's block.
 * Written as a line scan rather than a regex: the previous lookahead had an empty
 * alternative that always matched, so the lazy quantifier stopped after one line and the
 * enum scan silently returned nothing on exactly the multi-variant models this exists to
 * inspect.
 */
function blockFor(md, key) {
  const lines = md.split('\n');
  const startIndex = lines.findIndex((line) => new RegExp(`^\\s+${key}:\\s*$`).test(line));
  if (startIndex === -1) return null;
  const indent = lines[startIndex].search(/\S/);
  const block = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    block.push(line);
  }
  return block.join('\n');
}

async function spec(docsPath) {
  const md = await fetchText(`https://docs.kie.ai/market/${docsPath}.md`);
  const enums = new Set();
  const enumBlock = blockFor(md, 'model');
  const searchSpace = enumBlock ?? md;
  for (const match of searchSpace.matchAll(/-\s*['"]?([a-z0-9][a-z0-9./_-]{3,})['"]?\s*$/gm)) {
    enums.add(match[1]);
  }
  console.log('# model enum candidates (verify against the enum block, not the docs path):');
  for (const value of [...enums].slice(0, 8)) console.log(`  ${value}`);

  const inputBlock = md.match(/^(\s+)input:\s*$\n((?:\1\s.*\n|\s*\n)+)/m);
  if (inputBlock) {
    const properties = inputBlock[2].match(/^(\s+)properties:\s*$\n((?:\1\s.*\n|\s*\n)+)/m);
    if (properties) {
      const indent = properties[1].length + 2;
      const fieldPattern = new RegExp(`^(\\s{${indent}})([a-z_][a-z0-9_]*):\\s*$`, 'gm');
      console.log('# input fields:');
      for (const match of properties[2].matchAll(fieldPattern)) {
        console.log(`  ${match[2]}`);
      }
    }
    const required = inputBlock[2].match(/^\s+required:\s*\n((?:\s+-\s+\w+\n)+)/m);
    if (required) {
      console.log(`# required: ${[...required[1].matchAll(/-\s+(\w+)/g)].map((m) => m[1]).join(', ')}`);
    }
  }
}

const [command, argument] = process.argv.slice(2);
const run = command === 'slugs'
  ? slugs()
  : command === 'price' && argument
    ? price(argument)
    : command === 'spec' && argument
      ? spec(argument)
      : Promise.reject(new Error('Usage: kie-evidence.mjs slugs | price <slug> | spec <docs-path>'));

run.catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
