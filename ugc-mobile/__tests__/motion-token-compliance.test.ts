import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { appTheme } from '../lib/theme';

const mobileRoot = path.resolve(__dirname, '..');

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolutePath = path.join(root, entry);
    if (statSync(absolutePath).isDirectory()) files.push(...sourceFiles(absolutePath));
    else if (/\.tsx?$/.test(entry)) files.push(absolutePath);
  }
  return files;
}

/** Everything that renders, minus the module that owns the primitives. */
const animatedSources = [
  ...sourceFiles(path.join(mobileRoot, 'app')),
  ...sourceFiles(path.join(mobileRoot, 'components')),
  ...sourceFiles(path.join(mobileRoot, 'lib')),
].filter((file) => !file.endsWith(path.join('lib', 'motion.ts')));

function relative(file: string) {
  return path.relative(mobileRoot, file);
}

function offenders(pattern: RegExp, skip: (file: string) => boolean = () => false) {
  const found: string[] = [];
  for (const file of animatedSources) {
    if (skip(file)) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      const code = line.trim();
      // Comments discuss these patterns — the sweep left explanations behind
      // that name the very literals they replaced.
      if (code.startsWith('//') || code.startsWith('*')) return;
      if (pattern.test(code)) found.push(`${relative(file)}:${index + 1}  ${code}`);
    });
  }
  return found;
}

/**
 * These guard a sweep, not a style preference.
 *
 * An audit found 23 of 26 animation call sites using hardcoded literals while a
 * full `appTheme.motion` block sat beside them — four of its five duration
 * tokens referenced exactly zero times. The drift was invisible precisely
 * because some literals *matched* the token they should have referenced, so
 * nothing looked wrong in review and no behavioural test could see it.
 */
describe('motion values come from the theme', () => {
  it('never hardcodes a press opacity', () => {
    // `appTheme.opacity.pressed` existed and 110 sites used it, while 43 others
    // spread across 16 distinct values from 0.65 to 0.99 — including one that
    // wrote 0.88, the token's own value, by hand.
    expect(offenders(/opacity[^}]*pressed \? 0\.\d+/)).toEqual([]);
  });

  it('never re-declares the theme spring as loose numbers', () => {
    // `tension: 190, friction: 13` was copied verbatim into two files. It read
    // as compliant while tracking nothing, and at a damping ratio near 0.47 it
    // also overshot every surface it moved.
    expect(offenders(
      /tension:\s*190|friction:\s*13/,
      (file) => file.endsWith(path.join('lib', 'theme.ts')),
    )).toEqual([]);
  });

  it('gives every timing an explicit easing', () => {
    // React Native falls back to a symmetric `easeInOut`, which starts slow and
    // reads as lag on anything the user just tapped for. The side menu shipped
    // that way and felt harsh next to every sprung surface around it.
    const timings: string[] = [];
    for (const file of animatedSources) {
      const source = readFileSync(file, 'utf8');
      const pattern = /(?:Animated|animatedApi|timing)\s*[.(]?\s*timing\s*\(([\s\S]{0,400}?)\)\s*(?:\.start|;)/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source))) {
        if (!/easing/.test(match[1])) {
          timings.push(`${relative(file)}  ${match[1].replace(/\s+/g, ' ').slice(0, 90)}`);
        }
      }
    }
    expect(timings).toEqual([]);
  });

  it('keeps every Modal transition behind the reduced-motion preference', () => {
    // Seven Modals gated correctly and three did not, so the same app both
    // respected and ignored the OS setting depending on which sheet you opened.
    expect(offenders(/animationType=["'](?:slide|fade)["']/)).toEqual([]);
  });
});

describe('the motion tokens are all live', () => {
  it('has no duration nobody references', () => {
    const sources = [
      ...animatedSources,
      path.join(mobileRoot, 'lib', 'motion.ts'),
    ].map((file) => readFileSync(file, 'utf8')).join('\n');
    const unused = Object.keys(appTheme.motion.duration)
      .filter((name) => !sources.includes(`motion.duration.${name}`));
    expect(unused).toEqual([]);
  });

  it('has no spring nobody references', () => {
    const sources = [
      ...animatedSources,
      path.join(mobileRoot, 'lib', 'motion.ts'),
    ].map((file) => readFileSync(file, 'utf8')).join('\n');
    const unused = Object.keys(appTheme.motion.spring)
      .filter((name) => !sources.includes(`motion.spring.${name}`));
    expect(unused).toEqual([]);
  });
});
