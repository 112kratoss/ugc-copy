import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { appTheme, fieldTypeStyle } from '../lib/theme';

/**
 * A one-line field's text sits in the middle of its box. iOS puts a line
 * height's extra space above the text of a one-line `TextInput`, so `bodySm`'s
 * 14 pt type on its 21 pt line sat 4 pt below the middle of a 48 pt field, under
 * the centre of the field's own clear button: Edit profile's Display name and
 * Username, and every field drawn the same way (iPhone 17 Pro simulator,
 * 2026-11-12, measured at 3x: text 12–13 px low, then within 1 px once the line
 * height went; owner: "the texts are not aligned in the middle"). A field that
 * wraps keeps its line height.
 */

const ROOT = join(__dirname, '..');
const SCANNED = ['app', 'components'];

/** Every `<TextInput … />` element in a source file, as its source text and line. */
export function textInputElements(source: string) {
  const elements: { text: string; line: number }[] = [];
  const opening = /<TextInput(?=[\s>])/g;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(source))) {
    let depth = 0;
    let end = -1;
    for (let index = match.index + 1; index < source.length; index += 1) {
      const char = source[index];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      else if (depth === 0 && char === '/' && source[index + 1] === '>') {
        end = index + 2;
        break;
      } else if (depth === 0 && char === '>') {
        end = index + 1;
        break;
      }
    }
    if (end < 0) continue;
    elements.push({ text: source.slice(match.index, end), line: source.slice(0, match.index).split('\n').length });
  }
  return elements;
}

type LineMode = 'single' | 'multi' | 'either';

function lineMode(element: string): LineMode {
  const prop = /\bmultiline(?:=\{([^}]*)\})?(?=[\s/>])/.exec(element);
  if (!prop) return 'single';
  if (prop[1] === undefined || prop[1].trim() === 'true') return 'multi';
  if (prop[1].trim() === 'false') return 'single';
  return 'either';
}

/** What a field's style may not do for the lines it can have. */
export function centringFaults(element: string): string[] {
  const mode = lineMode(element);
  if (mode === 'multi') return [];
  const faults: string[] = [];
  if (/\.\.\.\s*(?:appTheme|staticTokens)\.type\./.test(element) || /\.\.\.\s*textRole\(/.test(element)) {
    faults.push('spreads a type role with its line height: use fieldTypeStyle(role) for one line');
  }
  for (const line of element.split('\n')) {
    if (/\blineHeight\s*:/.test(line) && !(mode === 'either' && /\bmultiline\s*\?/.test(line))) {
      faults.push(`sets a line height on a field that can be one line: ${line.trim()}`);
    }
  }
  if (mode === 'single' && /fieldTypeStyle\([^)]*,\s*(?!false\b)[^)]+\)/.test(element)) {
    faults.push('asks fieldTypeStyle for wrapped lines on a one-line field');
  }
  return faults;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx$/.test(name) ? [path] : [];
  });
}

describe('one-line field text sits in the middle of its box', () => {
  it('drops the line height for one line and keeps it for wrapped lines', () => {
    expect(appTheme.type.bodySm.lineHeight).toBe(21);
    expect(fieldTypeStyle('bodySm')).toEqual({ fontSize: 14, fontWeight: '400' });
    expect(fieldTypeStyle('bodySm')).not.toHaveProperty('lineHeight');
    expect(fieldTypeStyle('bodySm', true)).toEqual(appTheme.type.bodySm);
  });

  it('finds the faults it is looking for (positive control)', () => {
    const spread = `<TextInput value={v} style={{ minHeight: 48, ...appTheme.type.bodySm, paddingVertical: 12 }} />`;
    const raw = `<TextInput\n  value={v}\n  style={{ fontSize: 14, lineHeight: 21 }}\n/>`;
    const either = `<TextInput multiline={multiline} style={{ ...textRole('bodySm') }} />`;
    expect(centringFaults(spread)).toHaveLength(1);
    expect(centringFaults(raw)).toHaveLength(1);
    expect(centringFaults(either)).toHaveLength(1);
    expect(centringFaults(`<TextInput style={{ ...fieldTypeStyle('bodySm'), color }} />`)).toEqual([]);
    expect(centringFaults(`<TextInput multiline={multiline} style={{ ...fieldTypeStyle('bodySm', Boolean(multiline)) }} />`)).toEqual([]);
    expect(centringFaults(`<TextInput multiline style={{ fontSize: 14, lineHeight: 21 }} />`)).toEqual([]);
    expect(textInputElements(`const a = <TextInput value={x ? '{' : '}'} />; type T = TextInputProps;`)).toHaveLength(1);
  });

  it('holds every TextInput in the app to it', () => {
    const faults: string[] = [];
    let elements = 0;
    for (const directory of SCANNED) {
      for (const file of sourceFiles(join(ROOT, directory))) {
        for (const element of textInputElements(readFileSync(file, 'utf8'))) {
          elements += 1;
          for (const fault of centringFaults(element.text)) faults.push(`${relative(ROOT, file)}:${element.line} ${fault}`);
        }
      }
    }
    // The scan sees the app's fields: a parser that found none would pass anything.
    expect(elements).toBeGreaterThan(15);
    expect(faults).toEqual([]);
  });

  it('draws the shared field, the composer fields and the made-with picker with it', () => {
    const uses = (path: string) => readFileSync(join(ROOT, path), 'utf8');
    expect(uses('components/ui.tsx')).toContain("...fieldTypeStyle('bodySm', Boolean(multiline))");
    expect(uses('components/composer-fields.tsx')).toContain("...fieldTypeStyle('bodySm', Boolean(multiline))");
    expect(uses('app/post/new.tsx')).toContain("...fieldTypeStyle('bodySm')");
  });
});
