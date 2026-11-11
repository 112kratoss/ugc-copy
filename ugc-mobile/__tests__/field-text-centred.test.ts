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

/**
 * Every `<TextInput … />` element in a source file (an `Animated.TextInput` too),
 * as its source text and line. A type argument (`useRef<TextInput>`) is not one.
 */
export function textInputElements(source: string) {
  const elements: { text: string; line: number }[] = [];
  const opening = /(?<![\w$.])<(?:Animated\.)?TextInput(?=[\s>])/g;
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

/** The element's own `multiline` prop: bare, `={true}`, `={false}` or an expression; a ternary on it is not the prop. */
function lineMode(element: string): LineMode {
  const prop = /(?:^|\s)multiline(?:=\{([^}]*)\}|(?=\s*\/?>)|(?=\s+[A-Za-z{]))/.exec(element);
  if (!prop) return 'single';
  if (prop[1] === undefined || prop[1].trim() === 'true') return 'multi';
  if (prop[1].trim() === 'false') return 'single';
  return 'either';
}

/** The object literal a style constant or `StyleSheet` entry is written as, when the file defines it. */
function styleDefinition(source: string, name: string): string | null {
  const start = new RegExp(`(?:\\bconst\\s+${name}\\b[^=]*=|(?:^|[\\s{,])${name}\\s*:)\\s*(?:\\{|StyleSheet\\.create\\(\\{)`, 'm').exec(source);
  if (!start) return null;
  let depth = 0;
  for (let index = start.index + start[0].length - 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start.index, index + 1);
    }
  }
  return null;
}

/** What a field's style may not do for the lines it can have. `source` is its file, to read the style constants it names. */
export function centringFaults(element: string, source = ''): string[] {
  const mode = lineMode(element);
  if (mode === 'multi') return [];
  const faults: string[] = [];
  if (/\b(?:appTheme|staticTokens|theme)\.type\.\w+/.test(element) || /\btextRole\(/.test(element)) {
    faults.push('takes a type role with its line height: use fieldTypeStyle(role) for one line');
  }
  for (const line of element.split('\n')) {
    if (/\blineHeight\s*:/.test(line) && !(mode === 'either' && /\bmultiline\s*\?/.test(line))) {
      faults.push(`sets a line height on a field that can be one line: ${line.trim()}`);
    }
  }
  for (const call of element.match(/fieldTypeStyle\([^)]*\)/g) ?? []) {
    const flagged = /,\s*(?!false\b)[^)\s]/.test(call);
    if (mode === 'single' && flagged) faults.push(`asks for wrapped lines on a one-line field: ${call}`);
    if (mode === 'either' && !flagged) faults.push(`drops the line height of a field that can wrap: ${call} needs its multiline flag`);
  }
  const names = new Set([...(element.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? []), ...[...element.matchAll(/\bstyles\.(\w+)/g)].map((found) => found[1])]);
  for (const name of names) {
    const definition = source ? styleDefinition(source, name) : null;
    if (definition && /\blineHeight\s*:/.test(definition)) faults.push(`styled by ${name}, which sets a line height`);
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
    expect(textInputElements(`const r = useRef<TextInput>(null); let o: RefObject<TextInput | null>;`)).toHaveLength(0);
    expect(textInputElements(`<Animated.TextInput style={{ ...theme.type.bodySm }} />`)).toHaveLength(1);
    // Every way a type role reaches a one-line field.
    expect(centringFaults(`<TextInput style={{ ...theme.type.bodySm }} />`)).toHaveLength(1);
    expect(centringFaults(`<TextInput style={[appTheme.type.bodySm, { color }]} />`)).toHaveLength(1);
    const constant = `const FIELD_TEXT = { fontSize: 14, lineHeight: 21 };`;
    expect(centringFaults(`<TextInput style={FIELD_TEXT} />`, constant)).toHaveLength(1);
    const sheet = `const styles = StyleSheet.create({ input: { fontSize: 14, lineHeight: 21 } });`;
    expect(centringFaults(`<TextInput style={styles.input} />`, sheet)).toHaveLength(1);
    // A ternary on multiline before the prop does not make the field one that wraps.
    expect(centringFaults(`<TextInput textAlignVertical={multiline ? 'top' : 'center'} multiline={multiline} style={{ ...fieldTypeStyle('bodySm') }} />`)).toHaveLength(1);
    expect(centringFaults(`<TextInput textAlignVertical={multiline ? 'top' : 'center'} multiline={multiline} style={{ ...appTheme.type.bodySm }} />`)).toHaveLength(1);
  });

  it('holds every TextInput in the app to it', () => {
    const faults: string[] = [];
    let elements = 0;
    for (const directory of SCANNED) {
      for (const file of sourceFiles(join(ROOT, directory))) {
        const source = readFileSync(file, 'utf8');
        for (const element of textInputElements(source)) {
          elements += 1;
          for (const fault of centringFaults(element.text, source)) faults.push(`${relative(ROOT, file)}:${element.line} ${fault}`);
        }
      }
    }
    // The scan sees the app's fields (13 on 2026-11-12, type arguments not
    // counted): a parser that found none would pass anything.
    expect(elements).toBeGreaterThanOrEqual(13);
    expect(faults).toEqual([]);
  });

  it('draws the shared field, the composer fields and the made-with picker with it', () => {
    const uses = (path: string) => readFileSync(join(ROOT, path), 'utf8');
    expect(uses('components/ui.tsx')).toContain("...fieldTypeStyle('bodySm', Boolean(multiline))");
    expect(uses('components/composer-fields.tsx')).toContain("...fieldTypeStyle('bodySm', Boolean(multiline))");
    expect(uses('app/post/new.tsx')).toContain("...fieldTypeStyle('bodySm')");
  });
});
