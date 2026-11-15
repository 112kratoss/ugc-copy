/**
 * The relevance check of Posts search (`npm run search:relevance`).
 *
 * Seeds the fixed test set (`config/search-relevance/relevance-set.json`) on a
 * LOCAL Supabase stack as real public posts, embeds posts and queries with the
 * real model through the stack's own `embed-post` Edge Function, reads the
 * word order (`search_public_posts`) and the blended order
 * (`search_blended_posts`) for every query, scores both and fails when the
 * blended order is worse (`judgeSearchRelevance`). Then it removes what it
 * seeded.
 *
 *   SEARCH_RELEVANCE_DB_URL             postgresql://…@127.0.0.1:<port>/postgres
 *   SEARCH_RELEVANCE_API_URL            http://127.0.0.1:<port>
 *   SEARCH_RELEVANCE_SERVICE_ROLE_KEY   the stack's service-role key
 *
 *   --record      also rewrite config/search-relevance/recorded-run.json
 *   --calibrate   also print the scores of other floors, weights and windows
 *   --keep        leave the seeded posts in place
 *
 * It writes posts, so it runs against a loopback database and nothing else,
 * and only one that holds no other searchable post. It reads no `.env` file:
 * the three values are passed in the environment by whoever started the stack.
 * Runbook: docs/search-ranking-operations.md.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import {
  blendSearchLists,
  judgeSearchRelevance,
  parseSearchBlendConstants,
  recordedSearchRuns,
  searchRelevancePostId,
  searchRelevanceQueryWordCount,
  type RecordedSearchQueryRun,
  type RecordedSearchRun,
  type SearchBlendConstants,
  type SearchMatchSource,
  type SearchRelevanceSet,
  type SearchRelevanceVerdict,
} from '../../src/lib/search-relevance';

const EMBEDDING_MODEL = 'gte-small';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SET_PATH = path.join(ROOT, 'config', 'search-relevance', 'relevance-set.json');
const RECORDED_PATH = path.join(ROOT, 'config', 'search-relevance', 'recorded-run.json');

/** Every id the check writes starts with this, and nothing else in a database does. */
const ID_PREFIX = '5e1e';
const creatorId = (index: number) => `${ID_PREFIX}0000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
const generationId = (index: number) => `${ID_PREFIX}1000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
const relevancePostId = searchRelevancePostId;

/** How much of each list a recorded run keeps: past both windows, so other windows can be scored from it. */
const RECORDED_WORD_ROWS = 75;
const RECORDED_MEANING_ROWS = 60;

type Options = { record: boolean; calibrate: boolean; keep: boolean };

function readOptions(argv: readonly string[]): Options {
  const known = new Set(['--record', '--calibrate', '--keep']);
  for (const argument of argv) {
    if (!known.has(argument)) throw new Error(`Unknown argument ${argument}. Known: ${[...known].join(', ')}`);
  }
  return { record: argv.includes('--record'), calibrate: argv.includes('--calibrate'), keep: argv.includes('--keep') };
}

function loopbackUrl(name: string): URL {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. The check needs a local stack: see docs/search-ranking-operations.md`);
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`${name} names ${url.hostname}: the relevance check writes posts and runs against a loopback stack only`);
  }
  return url;
}

function vectorLiteral(embedding: readonly number[]) {
  return `[${embedding.join(',')}]`;
}

async function embedPost(apiUrl: URL, serviceRoleKey: string, body: Record<string, unknown>) {
  // A worker that is still loading the model, or was retired mid-request, answers 5xx (546 on the
  // local runtime): asked again a moment later, it answers.
  let status = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    const response = await fetch(new URL('/functions/v1/embed-post', apiUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (response.ok) return await response.json() as Record<string, unknown>;
    status = response.status;
    if (status < 500) break;
  }
  throw new Error(`embed-post answered ${status}`);
}

async function removeSeed(db: Client) {
  // Out of whatever a failed step left open.
  await db.query('rollback');
  await db.query('begin');
  await db.query(`delete from public.posts where id::text like $1`, [`${ID_PREFIX}2000-%`]);
  await db.query(`delete from public.generations where id::text like $1`, [`${ID_PREFIX}1000-%`]);
  await db.query(`delete from auth.users where id::text like $1`, [`${ID_PREFIX}0000-%`]);
  await db.query('commit');
}

async function seed(db: Client, set: SearchRelevanceSet, now: Date) {
  await db.query('begin');
  for (const [index, creator] of set.creators.entries()) {
    await db.query(
      `insert into auth.users (id, email, aud, role, created_at, raw_app_meta_data, raw_user_meta_data)
       values ($1, $2, 'authenticated', 'authenticated', now(), '{}'::jsonb, '{}'::jsonb)`,
      [creatorId(index), `search-relevance-${creator}@example.invalid`],
    );
  }
  for (const [index, post] of set.posts.entries()) {
    const made = set.made[post.made];
    const creator = creatorId(set.creators.indexOf(post.creator));
    if (!made || set.creators.indexOf(post.creator) < 0) throw new Error(`${post.key}: unknown creator or made-with`);
    if (made.model) {
      await db.query(
        `insert into public.generations (id, user_id, model, status, is_public) values ($1, $2, $3, 'succeeded', true)`,
        [generationId(index), creator, made.model],
      );
    }
    await db.query(
      `insert into public.posts (
         id, user_id, visibility, category, source_kind, post_format, review_status,
         title, body, prompt, source_tool, source_tool_slug, generation_id, showcase_asset_path,
         is_nsfw, created_at, updated_at
       ) values ($1, $2, 'public', $3, $4, 'media', 'visible', $5, $6, $7, $8, $9, $10, $11, false, $12, $12)`,
      [
        relevancePostId(index), creator, post.kind, made.model ? 'magicbooklet' : 'external',
        post.title, post.caption ?? null, post.prompt ?? null, made.tool, made.tool.toLowerCase(),
        made.model ? generationId(index) : null, `showcase/search-relevance-${post.key}.png`,
        new Date(now.getTime() - post.ageDays * 86_400_000).toISOString(),
      ],
    );
    if (made.modelLabel && made.modelSlug) {
      await db.query(
        `insert into public.post_source_tools (post_id, tool_label, tool_slug, model_label, model_slug, sort_order)
         values ($1, $2, $3, $4, $5, 0)`,
        [relevancePostId(index), made.tool, made.tool.toLowerCase(), made.modelLabel, made.modelSlug],
      );
    }
  }
  await db.query('commit');
}

/** Sends every post still waiting for its vector to the function, eight at a time, until none waits. */
async function embedPosts(db: Client, apiUrl: URL, serviceRoleKey: string) {
  for (let round = 0; round < 200; round += 1) {
    const pending = await db.query<{ post_id: string }>(
      `select post_id from public.list_posts_pending_search_embedding($1, 96)`, [EMBEDDING_MODEL],
    );
    if (pending.rows.length === 0) return;
    for (let offset = 0; offset < pending.rows.length; offset += 8) {
      const answer = await embedPost(apiUrl, serviceRoleKey, {
        mode: 'search',
        postIds: pending.rows.slice(offset, offset + 8).map((row) => row.post_id),
      });
      if (answer.mode !== 'search') throw new Error('embed-post does not know the search mode');
      if (Array.isArray(answer.failed) && answer.failed.length > 0) {
        throw new Error(`embed-post failed ${answer.failed.length} post(s): ${JSON.stringify(answer.failed[0])}`);
      }
    }
  }
  throw new Error('Posts are still waiting for a vector after 200 rounds');
}

async function embedQuery(apiUrl: URL, serviceRoleKey: string, query: string): Promise<number[]> {
  const answer = await embedPost(apiUrl, serviceRoleKey, { mode: 'query', query });
  if (answer.mode !== 'query' || answer.model !== EMBEDDING_MODEL || !Array.isArray(answer.embedding)) {
    throw new Error('embed-post answered an unreadable query embedding');
  }
  return answer.embedding as number[];
}

type WordRow = { post_id: string; search_score: number };

/** The word order from its top, a page of search_public_posts at a time. */
async function wordOrder(db: Client, query: string, asOf: string, rows: number): Promise<WordRow[]> {
  const order: WordRow[] = [];
  while (order.length < rows) {
    const last = order.at(-1);
    const page = await db.query<WordRow>(
      `select post_id, search_score from public.search_public_posts($1, null, $2, $3, 25, $4::timestamptz, 'top')`,
      [query, last?.search_score ?? null, last?.post_id ?? null, asOf],
    );
    order.push(...page.rows.map((row) => ({ post_id: row.post_id, search_score: Number(row.search_score) })));
    if (page.rows.length < 25) break;
  }
  return order.slice(0, rows);
}

type BlendedDbRow = { post_id: string; matched_by: SearchMatchSource; blend_position: number; in_window: boolean };

/** The blended order from its top, paged as a client pages it: by the place each page ended at. */
async function blendedOrder(
  db: Client, query: string, vector: string, asOf: string, pageSize: number, rows: number,
): Promise<BlendedDbRow[]> {
  const order: BlendedDbRow[] = [];
  let after = 0;
  let afterFloor: { score: number; id: string } | null = null;
  while (order.length < rows) {
    if (afterFloor) {
      // Past the window: the word order, from the floor the window ended on.
      const page: { rows: Array<{ post_id: string; search_score: number }> } = await db.query(
        `select post_id, search_score from public.search_public_posts($1, null, $2, $3, $4, $5::timestamptz, 'top')`,
        [query, afterFloor.score, afterFloor.id, pageSize, asOf],
      );
      order.push(...page.rows.map((row, index) => ({
        post_id: row.post_id, matched_by: 'words' as const, blend_position: after + index + 1, in_window: false,
      })));
      after += page.rows.length;
      const last = page.rows.at(-1);
      if (page.rows.length < pageSize || !last) break;
      afterFloor = { score: Number(last.search_score), id: last.post_id };
      continue;
    }
    const page = await db.query<BlendedDbRow & { floor_score: number | null; floor_post_id: string | null }>(
      `select post_id, matched_by, blend_position, in_window, floor_score, floor_post_id
       from public.search_blended_posts($1, null, $2::extensions.vector, null, $3::timestamptz, $4, $5)`,
      [query, vector, asOf, after, pageSize],
    );
    order.push(...page.rows);
    const last = page.rows.at(-1);
    if (page.rows.length < pageSize || !last) break;
    after = last.blend_position;
    if (!last.in_window) {
      if (last.floor_score === null || last.floor_post_id === null) break;
      afterFloor = { score: Number(last.floor_score), id: last.floor_post_id };
    }
  }
  return order.slice(0, rows);
}

function printVerdict(title: string, verdict: SearchRelevanceVerdict) {
  const row = (label: string, words: string, blended: string) => console.log(`  ${label.padEnd(44)} ${words.padStart(8)} ${blended.padStart(8)}`);
  console.log(`\n${title}: ${verdict.queries} queries, ${verdict.judged} with a relevant post`);
  row('', 'words', 'blended');
  row('nDCG@10 (mean)', verdict.words.ndcg.toFixed(4), verdict.blended.ndcg.toFixed(4));
  row('a relevant post in the top 5 (share)', verdict.words.topHitRate.toFixed(4), verdict.blended.topHitRate.toFixed(4));
  row('relevant posts in the top 5 (mean)', verdict.words.relevantInTop.toFixed(2), verdict.blended.relevantInTop.toFixed(2));
  row('wrong posts in the top 10 (mean)', verdict.words.wrongInDepth.toFixed(2), verdict.blended.wrongInDepth.toFixed(2));
  row('posts returned for queries about nothing', String(verdict.words.offCorpusPosts), String(verdict.blended.offCorpusPosts));
  for (const [kind, entry] of Object.entries(verdict.byKind)) {
    row(`nDCG@10, ${kind} (${entry.queries})`, entry.words.toFixed(4), entry.blended.toFixed(4));
  }
  if (verdict.worse.length > 0) {
    console.log('  queries the blend scores lower:');
    for (const entry of verdict.worse) {
      console.log(`    ${entry.id} "${entry.text}": ${entry.words.toFixed(4)} -> ${entry.blended.toFixed(4)}`);
    }
  }
}

function printCalibration(set: SearchRelevanceSet, recorded: RecordedSearchRun, tieBreak: (key: string) => string) {
  console.log('\nOther settings, scored on the same lists (floor, meaning weight, meaning window, word window):');
  console.log('  floor  weight  S   L    nDCG@10  top5    rel@5  wrong@10  off  worse  exact-lost');
  const score = (constants: SearchBlendConstants) => {
    const runs = recorded.queries.map((query) => {
      const words = query.words.map(([key]) => key);
      const blended = searchRelevanceQueryWordCount(set.queries.find((entry) => entry.id === query.id)?.text ?? '') < 2
        ? words
        : blendSearchLists(
          query.words.map(([key, value]) => ({ key, score: value })),
          query.meaning.map(([key, similarity]) => ({ key, similarity })),
          constants,
          tieBreak,
        ).map((row) => row.key);
      return { id: query.id, words, blended };
    });
    return judgeSearchRelevance(set, runs);
  };
  for (const minSimilarity of [0.78, 0.8, 0.81, 0.82, 0.83, 0.84]) {
    for (const meaningWeight of [0.5, 0.7, 0.8, 0.9, 0.95, 1.0]) {
      for (const meaningWindow of [10, 30]) {
        const verdict = score({ ...recorded.constants, minSimilarity, meaningWeight, meaningWindow });
        console.log(
          `  ${minSimilarity.toFixed(2)}   ${meaningWeight.toFixed(2)}    ${String(meaningWindow).padEnd(3)} ${String(recorded.constants.wordWindow).padEnd(4)}`
          + ` ${verdict.blended.ndcg.toFixed(4)}   ${verdict.blended.topHitRate.toFixed(4)}  ${verdict.blended.relevantInTop.toFixed(2)}`
          + `   ${verdict.blended.wrongInDepth.toFixed(2).padEnd(9)} ${String(verdict.blended.offCorpusPosts).padEnd(4)} ${String(verdict.worse.length).padEnd(6)}`
          + ` ${verdict.failures.filter((failure) => failure.includes('lost first place')).length}`,
        );
      }
    }
  }
}

async function main() {
  const options = readOptions(process.argv.slice(2));
  const dbUrl = loopbackUrl('SEARCH_RELEVANCE_DB_URL');
  const apiUrl = loopbackUrl('SEARCH_RELEVANCE_API_URL');
  const serviceRoleKey = process.env.SEARCH_RELEVANCE_SERVICE_ROLE_KEY?.trim();
  if (!serviceRoleKey) throw new Error('SEARCH_RELEVANCE_SERVICE_ROLE_KEY is not set');

  const set = JSON.parse(readFileSync(SET_PATH, 'utf8')) as SearchRelevanceSet;
  const keyOfPost = new Map(set.posts.map((post, index) => [relevancePostId(index), post.key]));
  const idOfKey = new Map(set.posts.map((post, index) => [post.key, relevancePostId(index)]));
  const keyOf = (postId: string) => {
    const key = keyOfPost.get(postId);
    if (!key) throw new Error(`A search returned ${postId}, which is not a post of the set`);
    return key;
  };

  const db = new Client({ connectionString: dbUrl.toString() });
  await db.connect();
  try {
    await removeSeed(db);
    const others = await db.query<{ count: string }>('select count(*) from public.post_search_documents');
    if (Number(others.rows[0]?.count) > 0) {
      throw new Error(`This database holds ${others.rows[0]?.count} other searchable post(s): the check needs a stack with none, since every post changes every rank`);
    }

    const now = new Date();
    const asOf = now.toISOString();
    await seed(db, set, now);
    console.log(`Seeded ${set.posts.length} posts. Embedding them with ${EMBEDDING_MODEL} (the first request loads the model)...`);
    await embedPosts(db, apiUrl, serviceRoleKey);
    const embedded = await db.query<{ count: string }>('select count(*) from public.post_search_embeddings');
    console.log(`${embedded.rows[0]?.count} posts have a vector; the rest have no words of their own.`);

    const definition = await db.query<{ definition: string }>(
      `select pg_get_functiondef(oid) as definition from pg_proc where proname = 'search_blended_posts' and pronamespace = 'public'::regnamespace`,
    );
    if (definition.rows.length !== 1) throw new Error('This database has no public.search_blended_posts');
    const constants = parseSearchBlendConstants(definition.rows[0].definition);

    const recordedQueries: RecordedSearchQueryRun[] = [];
    const pagingFailures: string[] = [];
    for (const query of set.queries) {
      const embedding = vectorLiteral(await embedQuery(apiUrl, serviceRoleKey, query.text.toLowerCase()));
      const words = await wordOrder(db, query.text, asOf, RECORDED_WORD_ROWS);
      const meaning = await db.query<{ post_id: string; similarity: number }>(
        `select documents.post_id, 1 - (embeddings.embedding operator(extensions.<=>) $1::extensions.vector) as similarity
         from public.post_search_embeddings as embeddings
         join public.post_search_documents as documents on documents.post_id = embeddings.post_id
         join public.posts as posts on posts.id = documents.post_id
         where embeddings.embedding_model = $2 and posts.is_nsfw = false
           and embeddings.content_hash = encode(sha256(convert_to(documents.search_text, 'UTF8')), 'hex')
         order by embeddings.embedding operator(extensions.<=>) $1::extensions.vector, documents.post_id
         limit $3`,
        [embedding, EMBEDDING_MODEL, RECORDED_MEANING_ROWS],
      );
      // A one-word query is never blended (searchBlendApplies): its blended order is the word order.
      const blends = searchRelevanceQueryWordCount(query.text) >= 2;
      const depth = RECORDED_WORD_ROWS + RECORDED_MEANING_ROWS;
      const blended = blends
        ? await blendedOrder(db, query.text, embedding, asOf, 25, depth)
        : words.map((row, index) => ({ post_id: row.post_id, matched_by: 'words' as const, blend_position: index + 1, in_window: false }));

      if (blends) {
        // Paged a few posts at a time, the list is the same list: nothing repeated, nothing skipped.
        for (const pageSize of [1, 3, 7]) {
          const paged = await blendedOrder(db, query.text, embedding, asOf, pageSize, depth);
          if (paged.map((row) => row.post_id).join(' ') !== blended.map((row) => row.post_id).join(' ')) {
            pagingFailures.push(`${query.id} "${query.text}": pages of ${pageSize} give another list than pages of 25`);
          }
        }
        if (new Set(blended.map((row) => row.post_id)).size !== blended.length) {
          pagingFailures.push(`${query.id} "${query.text}": a post is in the blended list twice`);
        }
      }

      recordedQueries.push({
        id: query.id,
        words: words.map((row) => [keyOf(row.post_id), row.search_score]),
        meaning: meaning.rows.map((row) => [keyOf(row.post_id), Math.round(Number(row.similarity) * 1e6) / 1e6]),
        blended: blended.map((row) => [keyOf(row.post_id), row.matched_by]),
      });
    }

    const recorded: RecordedSearchRun = {
      version: 1, recordedAt: now.toISOString(), embeddingModel: EMBEDDING_MODEL, constants, queries: recordedQueries,
    };
    const verdict = judgeSearchRelevance(set, recordedSearchRuns(recorded));
    verdict.failures.push(...pagingFailures);

    // The second copy of the blend (blendSearchLists) is held to the database's on every query.
    const tieBreak = (key: string) => idOfKey.get(key) ?? key;
    for (const query of recorded.queries) {
      const text = set.queries.find((entry) => entry.id === query.id)?.text ?? '';
      if (searchRelevanceQueryWordCount(text) < 2) continue;
      const again = blendSearchLists(
        query.words.map(([key, value]) => ({ key, score: value })),
        query.meaning.map(([key, similarity]) => ({ key, similarity })),
        constants,
        tieBreak,
      );
      if (again.map((row) => `${row.key}:${row.matchedBy}`).join(' ') !== query.blended.map(([key, by]) => `${key}:${by}`).join(' ')) {
        verdict.failures.push(`${query.id} "${text}": blendSearchLists and search_blended_posts disagree`);
      }
    }

    console.log(`\nConstants: ${JSON.stringify(constants)}`);
    printVerdict('Relevance', verdict);
    if (options.calibrate) printCalibration(set, recorded, tieBreak);

    if (options.record) {
      const lines = [
        '{',
        '  "version": 1,',
        `  "recordedAt": ${JSON.stringify(recorded.recordedAt)},`,
        `  "embeddingModel": ${JSON.stringify(recorded.embeddingModel)},`,
        `  "constants": ${JSON.stringify(recorded.constants)},`,
        '  "queries": [',
        ...recorded.queries.map((query, index) => `    ${JSON.stringify(query)}${index < recorded.queries.length - 1 ? ',' : ''}`),
        '  ]',
        '}',
        '',
      ];
      writeFileSync(RECORDED_PATH, lines.join('\n'));
      console.log(`\nRecorded to ${path.relative(ROOT, RECORDED_PATH)} (sha256 ${createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12)})`);
    }

    if (verdict.failures.length > 0) {
      console.error(`\nFAILED:\n${verdict.failures.map((failure) => `  - ${failure}`).join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log('\nPASSED: the blended order is no worse than the word order, and every title match kept first place.');
    }
  } finally {
    if (!options.keep) await removeSeed(db).catch((error) => console.error('Could not remove the seeded posts:', error));
    await db.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
