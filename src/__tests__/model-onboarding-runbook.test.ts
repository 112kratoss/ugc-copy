import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * docs/model-onboarding.md is a map of where each fact about a generation model lives, and a
 * map that points at renamed code is worse than none: the model API references drifted exactly
 * that way (veo-3-1.md, kling_3.0.md). This suite fails when a file, symbol, test, npm script or
 * link the runbook names stops existing, or when the skill that loads it drifts, so the change
 * that moves the code fixes the page too.
 */

const root = process.cwd();
const RUNBOOK = 'docs/model-onboarding.md';
const runbook = fs.readFileSync(path.resolve(root, RUNBOOK), 'utf8');

function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
}

function declares(source: string, symbol: string): boolean {
  return new RegExp(`\\b(?:const|let|function|class|type|interface|enum)\\s+${symbol}\\b`).test(source);
}

function headingSlugs(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/^#{1,6} (.+)$/gm)].map((match) => (
    match[1].toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-')
  )));
}

/** Rows of the "What | File | Symbols" tables: every File cell names source files. */
const registrationRows = runbook
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('|') && line.endsWith('|') && !line.startsWith('| ---'))
  .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()))
  .filter((cells) => cells.length === 3)
  .map(([label, fileCell, symbolCell]) => ({
    label,
    files: backticked(fileCell),
    symbols: backticked(symbolCell),
  }))
  .filter((row) => row.files.length > 0 && row.files.every((file) => /^src\/.+\.tsx?$/.test(file)));

describe('model onboarding runbook', () => {
  it('finds the registration tables it checks', () => {
    // Positive control: a parser that silently matched nothing would pass every case below.
    expect(registrationRows.length).toBeGreaterThanOrEqual(15);
    expect(registrationRows.flatMap((row) => row.symbols)).toEqual(expect.arrayContaining([
      'IMAGE_MODELS',
      'getVideoCost',
      'KIE_TASK_IMAGE_ADAPTER_CONFIGS',
      'videoPricingExpression',
      'APP_SOURCE_TOOL',
    ]));
  });

  it.each(registrationRows)('$label: every named symbol is declared in every named file', ({ files, symbols }) => {
    expect(symbols.length).toBeGreaterThan(0);
    for (const file of files) {
      const absolute = path.resolve(root, file);
      expect(fs.existsSync(absolute), `${file} does not exist`).toBe(true);
      const source = fs.readFileSync(absolute, 'utf8');
      for (const symbol of symbols) {
        expect(symbol).toMatch(/^[A-Za-z_$][\w$]*$/);
        expect(declares(source, symbol), `${symbol} is not declared in ${file}`).toBe(true);
      }
    }
  });

  it('names only repository paths that exist', () => {
    const paths = [
      ...backticked(runbook),
      ...[...runbook.matchAll(/\bnode (scripts\/[\w./-]+)/g)].map((match) => match[1]),
    ]
      .filter((token) => /^(?:src|scripts|config|docs|ugc-mobile|supabase|\.agents|\.claude)\//.test(token))
      .filter((token) => !/[<>*{}]/.test(token));
    expect(paths.length).toBeGreaterThan(10);
    expect(paths.filter((token) => !fs.existsSync(path.resolve(root, token)))).toEqual([]);
  });

  it('names only tests that exist', () => {
    const tests = backticked(runbook).filter((token) => /^[\w.-]+\.test\.tsx?$/.test(token));
    expect(tests.length).toBeGreaterThan(5);
    expect(tests.filter((file) => !fs.existsSync(path.resolve(root, 'src/__tests__', file)))).toEqual([]);
  });

  it('names only npm scripts that exist', () => {
    const { scripts } = JSON.parse(
      fs.readFileSync(path.resolve(root, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    const named = [...runbook.matchAll(/\bnpm run ([\w:-]+)/g)].map((match) => match[1]);
    expect(named).toEqual(expect.arrayContaining(['ops:generation-model-catalog:emit']));
    expect(named.filter((name) => !(name in scripts))).toEqual([]);
  });

  it('links only to files and headings that exist', () => {
    const links = [...runbook.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((match) => match[1])
      .filter((target) => !/^https?:/.test(target));
    expect(links.length).toBeGreaterThan(2);
    for (const link of links) {
      const [file, anchor] = link.split('#');
      const absolute = path.resolve(root, 'docs', file);
      expect(fs.existsSync(absolute), `${link} does not resolve from docs/`).toBe(true);
      if (anchor) {
        expect(headingSlugs(fs.readFileSync(absolute, 'utf8')).has(anchor), `${link} has no such heading`).toBe(true);
      }
    }
  });

  it('is what the add-generation-model skill loads', () => {
    const skillDir = path.resolve(root, '.agents/skills/add-generation-model');
    const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: add-generation-model\ndescription: .+\n---\n/);
    expect(skill).toContain(RUNBOOK);
    // Claude Code discovers project skills in .claude/skills; the entry there is a symlink, so
    // every agent reads the one copy in .agents/skills.
    expect(fs.realpathSync(path.resolve(root, '.claude/skills/add-generation-model'))).toBe(fs.realpathSync(skillDir));
  });

  it('is linked from AGENTS.md and the docs index', () => {
    expect(fs.readFileSync(path.resolve(root, 'AGENTS.md'), 'utf8')).toContain(RUNBOOK);
    expect(fs.readFileSync(path.resolve(root, 'docs/README.md'), 'utf8')).toContain('(model-onboarding.md)');
  });
});
