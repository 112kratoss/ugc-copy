# Search ranking operations

How the Posts order of `/api/search` is ranked when a client asks for the blended order, how a
ranking change is checked before it ships, and when the vectors behind it get an index. The rest of
search (the documents, the dictionary, the typeahead, the starter, related posts, the embedding job
and its kill switch) is in `docs/production-deployment-runbook.md`, "Public Search" to "Search By
Meaning".

- Database: `search_blended_posts` (migration `20261115130046_search_blended_posts.sql`, whose header
  is the full account), on top of `search_public_posts` and `post_search_embeddings`.
- Server: `src/lib/search-blended-posts.ts` (when it is called, with which vector),
  `findSearchQueryEmbedding` in `src/lib/search-embeddings.ts` (the vector, under the allowance and
  the cap), the cursor in `src/lib/public-search.ts`.
- Shared with both clients: `ugc-mobile/lib/public-search-policy/search-blend.ts` (the parameter,
  when a client sends it, how a post says it matched).
- The check: `config/search-relevance/`, `src/lib/search-relevance.ts`,
  `scripts/search/relevance-check.ts`, `src/__tests__/search-relevance.test.ts`.

## The blended order

A request that sends `blend=1` (any other value is a 400) has its posts ordered by two lists merged
into one:

- **the word list**: the first 50 rows of `search_public_posts`, read by calling that function, so it
  is the word order a search has always had;
- **the meaning list**: the 30 posts nearest the query's `gte-small` vector at cosine similarity 0.82
  or above, measured over `post_search_embeddings`, the vectors made from a post's public search text
  and nothing else.

Both lists hold only posts the viewer may see, under the request's filters, decided in SQL before any
limit. They are merged by reciprocal rank fusion: a post scores `1 / (50 + word rank)` plus
`0.9 / (50 + meaning rank)`, each term only for a list that holds it. Posts whose title is the query
stay first. The merged lists are the *window* (80 posts at most); after it the list is the word order
again. Every post of the answer says how it matched: `matchedBy` is `words`, `meaning` or `both`.

| The request | What it gets |
|---|---|
| Top tab or Posts sorted Top, two words or more, `blend=1`, a vector for the query | the blended order |
| the same, the query's vector not in the cache | one attempt to embed it, waited on for 400 ms; then the blended order, or the word order |
| one word, a handle (`@…`), Latest, `exact=1`, Creators, Recipes | the word order; the parameter changes nothing |
| a query the word search read corrected | the corrected word order |
| a later page, cursor issued inside the window | the window after the last post shown (or from the cursor's place), from the cached vector |
| a later page, no vector any more | the word order from the cursor's floor: no word match passed over, posts already shown can come again |
| `SEARCH_SEMANTIC_DISABLED=1` | the word order, with no extra read at all |

With `blend=1` every post carries `matchedBy`, in the word order too (`words`), and the answer says
which order it is in: `blended` is true, or false when it is the word order after all. Without the
parameter the answer is what it was before the blend, field for field.

**A later page may hold a post an earlier page showed, and a client must leave those out by id**
(`withoutShownSearchPosts` in `search-blend.ts`; the contract states it under
`searchPublicContent.laterPages`). The server never skips a post where it can avoid it, and where it
must choose it repeats one: a repeat is removed by the client, a skipped post is seen by nobody. An
empty page after the removal is not the end of the list; `nextCursor` being null is. Both clients do
this for every Posts list, blended or not (`appendSearchPosts` in `src/app/search/SearchClient.tsx`
and `ugc-mobile/components/explore-search-overlay.tsx`), and when a page is made of nothing but
posts already on show and has a cursor (`isSearchPageAllRepeats`) they ask for the page after it in
the same press, once: if that one is repeats too they keep its cursor and wait for the next press,
so a press never looks empty and never loops. "Pages" below says where repeats come from.

**Related posts beside it.** A blended answer already holds, in its own order, every post the
"Related posts" group would bring, so with both `blend=1` and `related=1` a blended answer looks for
none: where the group would have been looked for it is present and empty. A post is never in `posts`
and in `related`, on the first page or a later one. An answer the blend left in the word order looks
for related posts as before.

**What a new query costs.** The same as related posts: a cached vector is free; a new one spends one
of the viewer's 40 a day (and a guest session's network's 120), one of the day's 2,000, and one
`embed-post` request. One search spends that once, however many parts of it need the vector: the
blended order and related posts read one lookup between them (`createSearchQueryVectors`), so a
thin answer that also asks for related posts joins the request already on its way. A lookup that
has started is never cut short: once an allowance is taken the request it paid for is made and its
vector kept, whether or not anybody is still waiting, so no allowance is spent for nothing and the
next search of the same words is answered from the cache. The blend asks on every settled search of two words or more, where related
posts ask only beside a thin answer, so expect more of the day's count to be used. The count is
`search_query_embedding_days` (runbook, "Search By Meaning").

**Logs.** `public_search_blend_skipped` with a `reason` (`viewer_cap_reached` and
`network_cap_reached` at info; `daily_cap_reached`, `embedding_timeout` (the 400 ms ran out),
`embedding_failed`, `lookup_failed`, `not_configured` at warn) says why a search was answered in the
word order for want of a vector. `public_search_blend_failed` is the database call failing. Neither
ever carries the query.

**The search log.** A blended answer's row in `search_query_events` has `blended = true` (the column
is false for every other row), and its counts keep their meaning: `post_count` is the posts that hold
the words (`matchedBy` words or both) and `related_count` the posts found by meaning alone, with the
related group's. So a search whose words found nothing is `post_count = 0` whichever way it was
ordered, and the report's zero-result rate does not fall because clients turned the blend on. An
opened result joins its search row, which carries the flag.

**Release and rollback.** The migration adds one function and one column of the search log
(`blended`, default false) and changes nothing else, so it applies ahead of the app with no effect.
A code-only rollback leaves cursors issued by the new app in clients' hands: a blended cursor is an
ordinary Top cursor with two more fields, which older code ignores, and its place is the floor, so
the list continues in the word order. The one cursor older code refuses (400) is a blended cursor
with no floor (the first row of the word order was still to come, or no post holds the words).

## Pages

The window is a function of the query, the viewer, the instant the search began, the filters and the
vector, and it is rebuilt from the posts as they are at every request. A blended cursor carries:

- `w`, the place the next page starts after, and `l`, the post shown last. The page starts after
  that post wherever it now stands, so a post published, removed or saved above it between two
  pages moves nothing; the place is used only when that post is gone.
- `s` and `i`, the *floor*: the score and id of the last row of the unbroken run of the word order,
  from its top, shown so far. Word ranks 1, 3, 2 shown in that order have the floors 1, 1, 3. A page
  whose posts all come from further down the word order (posts in both lists do: each outranks
  every post the word list alone holds) has no floor.
- `a`, the instant, and `f`, the filter mark, as every Top cursor does.

Past the window the cursor has no `w` and is a plain Top cursor at the floor. That is also what a
blended cursor is to anything that cannot blend: the word order is read from the floor, or from its
top when there is no floor. That read passes over no post that holds the words, since every word
row before the floor has been shown. It repeats the word rows already shown from further down, and
it drops the meaning-only posts not yet shown.

What can still move a post between two pages: a post whose own score changed enough to cross the
line between them (it is shown twice, or once passed over), and the last post shown being removed
(the page then starts at the place, one off). Hence the rule above: clients leave out, by id, what
they already show.

## Changing the ranking

Every number is a named constant in `search_blended_posts`' `DECLARE` block and nowhere else:

| Constant | Value | What it does |
|---|---|---|
| `c_rrf_k` | 50 | flattens the ranks; the value Supabase's hybrid search guide uses |
| `c_word_weight` | 1.0 | |
| `c_meaning_weight` | 0.9 | the nearest meaning-only post comes in after the sixth word row |
| `c_word_window` | 50 | two reads of `search_public_posts` |
| `c_meaning_window` | 30 | |
| `c_min_similarity` | 0.82 | the lowest floor at which no query about nothing is answered |
| `c_exact_title_score` | 30 | `search_post_score`'s first tier: a title that is the query |

To change one:

1. Write a new migration that re-creates `search_blended_posts` alone (`CREATE OR REPLACE`, same
   signature) with the new constant, and say in its header why.
2. Run the relevance check against a local stack with that migration applied (below), with
   `--calibrate` to see the neighbouring settings and `--record` once it passes.
3. Update what pins the constants: `search-blended-posts-migration.test.ts` reads its own migration,
   so add the new numbers in a test for the new file; `search-relevance.test.ts` reads the newest
   definition and the recorded run and will fail until both agree, and its pinned numbers change in
   the same commit. `PUBLIC_SEARCH_BLEND_MAX_PLACE` in `src/lib/public-search.ts` is the two windows
   together.

A change to the word order itself (`search_public_posts`, `search_post_score`) changes the blended
order too, since the word list is that function's rows: run the check for it as well.

## The relevance check

A fixed set of synthetic public posts and graded queries, scored in the word order and in the blended
order. It is the acceptance check for a ranking change: it fails when the blended order is worse.

**The set** (`config/search-relevance/relevance-set.json`): 123 posts over eleven subjects (seascapes,
portraits, food, cars, anime, buildings and rooms, product shots, pets, science fiction, fashion, a
city at night), among them posts whose title says nothing of their subject ("Take 12", "Option B"),
near-misses that carry a word of another subject ("Sea of clouds", "Hot dog stand", "Catwalk"), posts
that hold a query's words and are about something else, and four with no words of their own. 75
queries, each with the posts a person would call relevant at three grades (3 the post asked for, 2
on the subject, 1 near it; an unlisted post is wrong):

| Kind | Queries | What it tests |
|---|---|---|
| `exact` | 15 | the query is a post's title: that post must stay first |
| `model` | 4 | the query is a model's name |
| `paraphrase` | 20 | the query shares few or no words with the posts it means |
| `mixed` | 20 | words find some of it, meaning can add the rest |
| `noisy` | 2 | many posts hold the words and few are about it |
| `trap` | 7 | the words are right and one of them means another subject |
| `off` | 5 | about nothing in the set: every post returned is wrong |
| `one-word` | 2 | never blended: both orders must be the same |

**What is measured**, per order: nDCG@10 (gain 2^grade - 1), averaged over the queries with a
relevant post; the share of those queries with a post of grade 2 or 3 among the first five; the mean
number of relevant posts among the first five; the mean number of wrong posts among the first ten;
and the posts returned for the queries about nothing.

**What fails it**: a lower mean nDCG@10 than the word order; fewer queries with a relevant post in
the top five; a post whose title is the query losing first place; more posts for the queries about
nothing; a one-word query blended; pages of 1, 3 or 7 giving another list than pages of 25, or a
post twice in a list; and the second copy of the blend (`blendSearchLists`) disagreeing with the
database on any query.

### Running it

It needs a local stack with the Edge runtime, because the vectors are real: the posts and the queries
are embedded by the stack's own `embed-post` function with the real `gte-small`. It writes posts, so
it refuses any database that is not on loopback or that holds another searchable post, and it reads
no `.env` file. On the dev Mac, on a stack of its own (never the default local one):

```bash
set -euo pipefail
COPY="$(mktemp -d)/stack" && mkdir -p "$COPY" && cp -R supabase "$COPY/supabase"
# In "$COPY/supabase/config.toml": a project_id of its own and every 543xx port moved (593xx).
grep -q '^project_id = "magicbooklet-search-hybrid"$' "$COPY/supabase/config.toml"
npx --yes supabase@2.75.0 start --workdir "$COPY" -x studio,imgproxy,mailpit,logflare,vector,realtime,supavisor
# The stack's address and key go from the CLI into the environment, never onto the screen.
eval "$(npx --yes supabase@2.75.0 status --workdir "$COPY" -o env 2>/dev/null \
  | sed -n -E 's/^(DB_URL|API_URL|SERVICE_ROLE_KEY)=/export SEARCH_RELEVANCE_\1=/p')"
npm run search:relevance -- --calibrate
npx --yes supabase@2.75.0 stop --workdir "$COPY" --no-backup
```

Give every supabase command `--workdir`; a `cd` that fails leaves the command on the default stack.
Never run `status -o env` bare: it prints the stack's service-role key. The first embedding request
loads the model and can take half a minute; the run takes about two minutes. It removes what it
seeded (`--keep` leaves it).

- `--calibrate` prints the same measures for other floors, weights and windows, computed from the
  lists it read, so a setting can be compared without another migration.
- `--record` rewrites `config/search-relevance/recorded-run.json`: for every query the word order
  with its scores, the nearest posts with their similarities, and the order the database blended.

**In CI** there is no embedding model, so `search-relevance.test.ts` holds the recording instead: it
must have been made with the constants the newest `search_blended_posts` declares, the second copy
of the blend must reproduce the database's order for every query, and the verdict must pass with the
numbers the test pins. A migration that changes a constant fails that test until the check is run
and recorded again.

### The numbers (2026-11-15, real `gte-small` vectors, 119 of 123 posts embedded)

| | Words | Blended |
|---|---|---|
| nDCG@10, mean of 70 queries | 0.5410 | 0.7837 |
| a relevant post in the top 5 | 0.7286 | 0.9714 |
| relevant posts in the top 5, mean | 1.21 | 2.14 |
| wrong posts in the top 10, mean | 0.30 | 1.90 |
| posts returned for 5 queries about nothing | 0 | 0 |

nDCG@10 by kind: exact 0.7394 to 0.8190, model 0.9315 to 0.9743, paraphrase 0.0596 to 0.6978, mixed
0.6687 to 0.7951, noisy 0.3545 to 0.4841, trap 0.9477 to 0.9588, one-word unchanged. No query scores
lower blended, and all 15 title matches keep first place.

By similarity floor, at meaning weight 0.9:

| Floor | nDCG@10 | Relevant in top 5 | Wrong in top 10 | Posts for queries about nothing |
|---|---|---|---|---|
| 0.80 | 0.8536 | 0.9857 | 3.74 | 1 |
| 0.81 | 0.8264 | 0.9857 | 2.64 | 0 |
| **0.82** | **0.7837** | **0.9714** | **1.90** | **0** |
| 0.83 | 0.7558 | 0.9714 | 1.11 | 0 |
| 0.84 | 0.6700 | 0.8857 | 0.60 | 0 |

What the blend costs is in that table: `gte-small` scores short texts that share vocabulary high,
whatever their subject, so at 0.82 almost two of the first ten posts are wrong for the query ("Sea
of clouds" brings seascapes behind the post of that name). They rank behind the word matches and say
`matchedBy: "meaning"`. 0.83 is the cautious setting (one wrong post in ten, 0.028 less nDCG); 0.81
leaves a margin of 0.005 over the nearest post to a query about nothing (0.805), which is none.

The weight barely moves the result on this set (at 0.82, weights 0.5 to 0.95 score 0.7836 to 0.7841;
1.0 scores 0.7833): word lists of several words are short on a small corpus. 0.9 is set by a rule
instead: a meaning-only post at rank *m* outranks a word-only post at rank *r* when
*r* > 5.56 + 1.11 *m*, so the first six word matches, the number under which the product already
calls an answer thin, are never displaced by a post that holds no word of the query. The meaning
window (10 to 30) moves nothing: no list at 0.82 is longer than 30.

### Adding to the set

Add posts at the end of `posts` (a post's id is its place, and the recording names posts by key) and
queries anywhere, with the grades written by hand from the posts' text, not from what search
returns. Then run the check with `--record`. A new subject wants its near-misses too: a post that
carries its words and is about something else is what keeps a floor honest.

## Latency

On 4,000 synthetic posts with 3,900 real vectors (local replay, 2026-11-15, load average about 2), a
first page of 21 rows, median of 25 calls in one connection:

| Query | Posts holding the words | `search_public_posts` | Blended, vector cached | Blended, no cached vector |
|---|---|---|---|---|
| quiet harbour evening | 2 | 20.3 ms | 24.4 ms | 20.5 ms |
| neon alley in heavy rain | 59 | 21.8 ms | 53.1 ms | 22.0 ms |
| golden sunset | 65 | 17.6 ms | 43.3 ms | 17.9 ms |
| dramatic city skyline | 85 | 20.2 ms | 46.7 ms | 20.4 ms |
| ocean waves | 149 | 17.5 ms | 40.4 ms | 17.6 ms |
| cinematic portrait of a woman | 172 | 24.9 ms | 57.5 ms | 25.2 ms |
| studio light | 479 | 19.7 ms | 48.6 ms | 19.9 ms |
| kling 2.6 | 634 | 21.6 ms | 53.7 ms | 21.8 ms |

- **Vector cached** (one database call): about 4 ms more than the word order when fewer than 25 posts
  hold the words, and about one more word read (20 to 33 ms here) when 25 or more do, because the
  second 25 rows of the word list are a second call of `search_public_posts`. A later page costs the
  same as the first. The scan of every vector is 0.9 ms of it; reading the cache 0.2 ms.
- **No cached vector**: the first call is the word order at the word order's cost. Then the vector
  is asked for: three or four short calls (the cache, the allowances, the day's place), the
  `embed-post` request (63 ms warm on the local runtime, the request included) and the blended read.
  A warm miss therefore answers about 150 ms later than the word order would have.
- **The wait is bounded at 400 ms** (`SEARCH_BLEND_QUERY_EMBEDDING_TIMEOUT_MS`), from the moment the
  vector is asked for to the moment it is in hand. Past it the word-order page already read is the
  answer, the request goes on behind it for up to ten seconds, and the next search of the same words
  finds the vector cached. 400 ms passes every warm answer with room and is a third of what related
  posts wait (1,200 ms), because here the wait holds the search's own posts. A cold function takes
  seconds (30 s for the first request on the local runtime); no bound worth waiting covers that.

Not measured: production. The function's warm and cold times there, and the word read on real data,
are the numbers to look at first after release (`Server-Timing` under
`SCALING_CERTIFICATION_TIMINGS=1`, and the `public_search_blend_skipped` reason
`embedding_timeout`).

If the second word read becomes the cost that matters, the word list can be read in one pass inside
`search_blended_posts`. That means a second copy of `search_public_posts`'s match and score, kept
equal by a test, which is why it was not done first.

## No vector index, and the day one is needed

`post_search_embeddings` has no vector index and both readers (`search_related_posts`,
`search_blended_posts`) measure every vector. That is deliberate:

- **It is exact.** The answer is a function of the rows the viewer may see and of nothing else. An
  index scan returns its nearest rows and the rules are applied after: without care, a labelled,
  blocked or stale row costs the viewer a result (the header of `20261112215420` has the case that
  went wrong on this stack).
- **It is fast enough.** 0.9 ms for 3,900 vectors, so about 0.23 ms per thousand: 23 ms at 100,000.
  Supabase's own guide says the same of small tables ("Going to production", "Do you need indexes?").
- **An index would be slower here.** Tried on the 3,900 vectors (pgvector 0.8.0, 2026-11-15) with
  a hard filter (videos by 3 of 40 creators), 20 queries of 30 rows each: the exact scan took 12 ms
  for all twenty; an HNSW index with `hnsw.iterative_scan = strict_order` took 62 ms and returned 599
  of the exact scan's 600 rows; with iterative scan off it returned 21 of 600. Building it took 0.7 s.

**When to build one.** At either of:

- `post_search_embeddings` passing **250,000 rows**: about 55 ms a read. The growth accounting
  already warns there (`OPERATIONAL_TABLE_ROW_BUDGETS` in `src/lib/operational-table-growth.ts`, over
  `get_operational_table_growth`, read by the backend cost report at `/api/ops/backend-costs`), so
  nothing new has to watch for it.
- the scan itself measured at **25 ms or more** on production, whichever comes first:

  ```sql
  EXPLAIN (ANALYZE, BUFFERS)
  SELECT count(*) FROM public.post_search_embeddings AS embeddings
  WHERE embeddings.embedding_model = 'gte-small'
    AND (embeddings.embedding OPERATOR(extensions.<=>)
         (SELECT embedding FROM public.search_query_embeddings LIMIT 1)) <= 0.18;
  ```

**How.** One migration, in this order:

1. The index, built without blocking writes (its own migration file, outside a transaction):

   ```sql
   CREATE INDEX CONCURRENTLY post_search_embeddings_embedding_hnsw_idx
     ON public.post_search_embeddings USING hnsw (embedding extensions.vector_cosine_ops);
   ```

2. Re-create both readers so the meaning list is something an index can answer: the distance in an
   `ORDER BY … LIMIT` over `post_search_embeddings` joined to the documents and posts, with every rule
   and filter in that same query's `WHERE` (never a `MATERIALIZED` step with the distance in its
   `WHERE`, which no index reads, and never the rules applied to the scan's output afterwards). The
   similarity floor moves to an outer query over that one, as pgvector advises for a distance
   filter beside an iterative scan.
3. In both functions, as `SET` clauses on the function: `hnsw.iterative_scan = strict_order` (the
   scan goes on past its first batch until the limit is filled, in exact distance order, which is
   what keeps a filtered page full and the ranks true), `hnsw.max_scan_tuples` at the table's size
   (the default 20,000 would stop a heavily filtered scan early), and `hnsw.ef_search` at 100 or
   more. Iterative scans need pgvector 0.8.0 or later: the local stack has 0.8.0; read
   production's first (`select extversion from pg_extension where extname = 'vector'`).
4. Superseded vectors leave dead entries in an HNSW index until a vacuum, and a scan spends its
   budget on them. Check that autovacuum keeps up with the embedding job, or vacuum the table after
   a bulk re-embed (a model change).

**Verifying recall before it ships**, on a replay stack seeded to the production size with real
vectors: for at least 20 query vectors and three viewers (a visitor, a viewer with blocks, a hard
filter), read the meaning list both ways, exact (`SET enable_indexscan = off`) and indexed, and
compare. Ship only if the indexed read returns as many rows as the exact one for every case and at
least 99 in 100 of the same posts, and if `search_blended_posts.test.sql` and the relevance check
still pass. The exact scan stays one `SET` away as the fallback.
