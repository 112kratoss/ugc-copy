import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeRetrievalConfig } from '@/lib/showcase-feed-personalization';
import {
  FOR_YOU_RULES_V3_DIVERSITY_CONFIG,
  FOR_YOU_RULES_V3_RETRIEVAL_CONFIG,
  FOR_YOU_RULES_V3_WEIGHTS,
  normalizeRankedFeedDiversityConfig,
  normalizeRankedFeedScoreWeights,
} from '@/lib/showcase-feed-ranking';

// The seeded for-you-rules v3 row and the TypeScript that reads it must agree
// key for key: a value the normalizers clamp or drop would serve something
// other than what the migration says v3 is
// (docs/plans/feed-algorithm-v3-x-adoption-2026-10-11.md §2.7 and §5).

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs.readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_feed_ranking_v3_x_adoption.sql'));

/** The SQL with `--` comments blanked out; quoted strings are left alone. */
function withoutLineComments(sql: string) {
  let result = '';
  let quoted = false;
  for (let index = 0; index < sql.length; index += 1) {
    if (!quoted && sql.startsWith('--', index)) {
      while (index < sql.length && sql[index] !== '\n') index += 1;
      result += '\n';
      continue;
    }
    // An escaped quote ('') toggles twice and leaves the state as it was.
    if (sql[index] === "'") quoted = !quoted;
    result += sql[index];
  }
  return result;
}

/** The text inside the parenthesis that opens at `open`. */
function parenthesized(sql: string, open: number) {
  let depth = 0;
  let quoted = false;
  for (let index = open; index < sql.length; index += 1) {
    if (sql[index] === "'") quoted = !quoted;
    if (quoted) continue;
    if (sql[index] === '(') depth += 1;
    if (sql[index] === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, index);
    }
  }
  throw new Error(`Unbalanced parenthesis at ${open} in the v3 seed`);
}

/** A SQL list split at its top-level commas. */
function topLevelItems(list: string) {
  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    const character = list[index];
    if (character === "'") quoted = !quoted;
    if (quoted) continue;
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      items.push(list.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(list.slice(start).trim());
  return items;
}

/**
 * A seeded value as the app reads it back through PostgREST:
 * `jsonb_build_object(...)` and `'{...}'::jsonb` both become plain JSON.
 */
function sqlValue(expression: string): unknown {
  const text = expression.trim();
  if (/^jsonb_build_object\s*\(/i.test(text)) {
    const args = topLevelItems(parenthesized(text, text.indexOf('(')));
    expect(args.length % 2, `jsonb_build_object needs key/value pairs: ${text}`).toBe(0);
    const object: Record<string, unknown> = {};
    for (let index = 0; index < args.length; index += 2) {
      object[String(sqlValue(args[index]))] = sqlValue(args[index + 1]);
    }
    return object;
  }
  const jsonLiteral = /^'([\s\S]*)'\s*::\s*jsonb$/i.exec(text);
  if (jsonLiteral) return JSON.parse(jsonLiteral[1].replace(/''/g, "'"));
  const cast = /^([\s\S]+?)\s*::\s*[a-z][a-z0-9_ ]*$/i.exec(text);
  if (cast) return sqlValue(cast[1]);
  const stringLiteral = /^'([\s\S]*)'$/.exec(text);
  if (stringLiteral) return stringLiteral[1].replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  if (/^null$/i.test(text)) return null;
  throw new Error(`Unreadable value in the v3 seed: ${text}`);
}

/** Every `INSERT INTO public.feed_algorithm_versions` row, column by column. */
function seededAlgorithmRows(sql: string) {
  const rows: Array<Record<string, unknown>> = [];
  const statement = 'INSERT INTO public.feed_algorithm_versions';
  for (let start = sql.indexOf(statement); start >= 0; start = sql.indexOf(statement, start + 1)) {
    const columnsOpen = sql.indexOf('(', start);
    const columns = topLevelItems(parenthesized(sql, columnsOpen));
    const valuesOpen = sql.indexOf('(', sql.indexOf('VALUES', columnsOpen));
    const values = topLevelItems(parenthesized(sql, valuesOpen));
    expect(values, 'one value per seeded column').toHaveLength(columns.length);
    rows.push(Object.fromEntries(columns.map((column, index) => [column, sqlValue(values[index])])));
  }
  return rows;
}

function seededV3Row() {
  expect(migrationName, 'the v3 migration is missing').toBeDefined();
  const sql = withoutLineComments(
    fs.readFileSync(path.join(migrationsDirectory, migrationName as string), 'utf8'),
  );
  const rows = seededAlgorithmRows(sql)
    .filter((row) => row.algorithm_key === 'for-you-rules' && row.version === 3);
  expect(rows, 'for-you-rules v3 is seeded exactly once').toHaveLength(1);
  return rows[0];
}

/** `max_creator_per_20` → `maxCreatorPer20`: the stored key as the normalizers name it. */
function camelCaseKeys(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key.replace(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase()),
    entry,
  ]));
}

describe('for-you-rules v3: the seeded row equals the TypeScript exports', () => {
  const seeded = seededV3Row();

  it('seeds v3 as shadow, so nothing serves it until an operator says so', () => {
    expect(seeded.status).toBe('shadow');
  });

  it('seeds exactly FOR_YOU_RULES_V3_WEIGHTS', () => {
    expect(seeded.weights).toEqual(FOR_YOU_RULES_V3_WEIGHTS);
  });

  it('seeds exactly FOR_YOU_RULES_V3_RETRIEVAL_CONFIG', () => {
    expect(seeded.retrieval_config).toEqual(FOR_YOU_RULES_V3_RETRIEVAL_CONFIG);
  });

  it('seeds exactly FOR_YOU_RULES_V3_DIVERSITY_CONFIG', () => {
    expect(seeded.diversity_config).toEqual(FOR_YOU_RULES_V3_DIVERSITY_CONFIG);
  });
});

describe('for-you-rules v3: every seeded key round-trips through its normalizer', () => {
  // toEqual in both directions: no key is clamped or dropped, and the
  // normalizer reads nothing the seeded row leaves to a default.
  it('reads every retrieval_config key at its seeded value', () => {
    const { visibilityThresholds, ...retrieval } = normalizeRetrievalConfig(FOR_YOU_RULES_V3_RETRIEVAL_CONFIG);
    expect({ ...retrieval, ...visibilityThresholds })
      .toEqual(camelCaseKeys(FOR_YOU_RULES_V3_RETRIEVAL_CONFIG));
  });

  it('reads every diversity_config key at its seeded value', () => {
    expect(normalizeRankedFeedDiversityConfig(FOR_YOU_RULES_V3_DIVERSITY_CONFIG))
      .toEqual(camelCaseKeys(FOR_YOU_RULES_V3_DIVERSITY_CONFIG));
  });

  it('reads every weight at its seeded value', () => {
    expect(normalizeRankedFeedScoreWeights(FOR_YOU_RULES_V3_WEIGHTS))
      .toEqual(camelCaseKeys(FOR_YOU_RULES_V3_WEIGHTS));
  });
});
