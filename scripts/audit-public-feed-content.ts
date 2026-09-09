/**
 * Read-only sweep of everything a logged-out visitor can see, rendered as one
 * contact sheet so a person can actually look at it.
 * npx tsx --env-file-if-exists=.env.local scripts/audit-public-feed-content.ts
 * --limit=200 bounds posts; --out=<dir> chooses the output directory.
 *
 * Why this exists, and why it renders images rather than reporting metadata:
 *
 * On 2026-09-09 App Review rejected iOS 0.1.4 under guideline 5.2.1 for content
 * resembling Marvel material. The post they attached was captioned "tryingg
 * new" and carried no title, prompt, or tag naming any franchise — the
 * resemblance lived entirely in the pixels. A text scan of the same feed that
 * day returned four posts; looking at the covers returned seven, including a
 * Venom symbiote and a Flash emblem that no keyword list would ever catch.
 *
 * So the keyword hits below are a convenience, not the check. The check is a
 * human looking at the sheet. This script exists to make that cheap: it is the
 * difference between an afternoon of clicking through a feed and one command.
 *
 * `posts.review_status` defaults to 'visible', so publishing is immediate and
 * nothing screens a post before strangers — and App Review — can reach it.
 * Until that changes, a periodic sweep is the control, and it should be run
 * before every store submission.
 *
 * Nothing is mutated and nothing private is fetched. Covers come from the
 * public `showcase_media` bucket over unsigned URLs, so the sheet can only ever
 * contain bytes that are already served to anonymous visitors. Prompts are read
 * for keyword matching but only ever printed truncated, never written to disk.
 */
import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const SHOWCASE_BUCKET = 'showcase_media';

/**
 * A deliberately blunt list: it exists to catch the post that names its source
 * in the title, which is the one class of infringement that is obvious in text.
 * Extend it freely — a false positive costs one glance at the sheet, and the
 * sheet is being looked at anyway.
 */
const THIRD_PARTY_TERMS = [
  'marvel', 'ms. marvel', 'spider-man', 'spiderman', 'iron man', 'avenger', 'venom',
  'hulk', 'thor', 'captain america', 'deadpool', 'wolverine', 'x-men',
  'batman', 'superman', 'wonder woman', 'joker', 'flash', 'aquaman', 'dc comics',
  'disney', 'pixar', 'mickey', 'elsa', 'frozen', 'moana', 'shrek', 'minion',
  'star wars', 'jedi', 'darth', 'harry potter', 'hogwarts', 'lord of the rings',
  'one piece', 'zoro', 'luffy', 'naruto', 'goku', 'dragon ball', 'jujutsu',
  'demon slayer', 'attack on titan', 'doraemon', 'pokemon', 'pikachu',
  'minnal murali', 'mario', 'sonic', 'barbie', 'hello kitty',
];

const args = process.argv.slice(2);
const limit = Number(args.find((arg) => arg.startsWith('--limit='))?.slice(8) ?? 200);
const outDir = args.find((arg) => arg.startsWith('--out='))?.slice(6) ?? 'out/public-feed-audit';
if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
  throw new Error('--limit must be an integer between 1 and 500.');
}
if (args.some((arg) => !arg.startsWith('--limit=') && !arg.startsWith('--out='))) {
  throw new Error('Only --limit and --out are supported. This audit never mutates data.');
}

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Missing Supabase URL or service-role key.');
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

type FeedRow = {
  id: string;
  user_id: string;
  created_at: string;
  title: string | null;
  description: string | null;
  prompt: string | null;
  body: string | null;
  post_media: Array<{ preview_storage_path: string | null; created_at: string }> | null;
};

type Entry = {
  id: string;
  username: string;
  label: string;
  created: string;
  hits: string[];
  previewPath: string | null;
};

/** The exact predicate every public surface uses, so this sees what they serve. */
async function readPublicFeed(): Promise<FeedRow[]> {
  const { data, error } = await client
    .from('posts')
    // `posts.user_id` references auth.users, not public.profiles, so PostgREST
    // has no relationship to embed; handles are resolved in a second read.
    .select(
      'id, user_id, created_at, title, description, prompt, body,'
      + ' post_media(preview_storage_path, created_at)',
    )
    .eq('visibility', 'public')
    .eq('review_status', 'visible')
    .is('archived_at', null)
    .is('tombstoned_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Unable to read the public feed: ${error.message}`);
  return (data ?? []) as unknown as FeedRow[];
}

function scanText(row: FeedRow): string[] {
  const haystack = [row.title, row.description, row.prompt, row.body]
    .filter(Boolean).join(' ').toLowerCase();
  return THIRD_PARTY_TERMS.filter((term) => haystack.includes(term));
}

async function readHandles(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const { data, error } = await client
    .from('profiles')
    .select('id, username')
    .in('id', userIds);
  if (error) throw new Error(`Unable to read handles: ${error.message}`);
  return new Map((data ?? []).map((row) => [row.id as string, (row.username as string) ?? '(unknown)']));
}

function toEntry(row: FeedRow, handles: Map<string, string>): Entry {
  const preview = (row.post_media ?? [])
    .filter((media) => media.preview_storage_path)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  const title = row.title?.trim() || row.prompt?.trim().slice(0, 32) || '(untitled)';
  return {
    id: row.id,
    username: handles.get(row.user_id) ?? '(unknown)',
    label: title.slice(0, 32),
    created: row.created_at.slice(0, 10),
    hits: scanText(row),
    previewPath: preview?.preview_storage_path ?? null,
  };
}

const CELL = 300;
const LABEL_BAND = 34;
const COLUMNS = 5;

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * One cell per post: the cover as the grid renders it, captioned with the
 * handle and title so anything worth pulling can be found again by name.
 */
async function renderCell(entry: Entry, cover: Buffer) {
  const image = await sharp(cover)
    .resize(CELL, CELL, { fit: 'contain', background: '#000' })
    .toBuffer();
  const caption = escapeXml(`${entry.username} · ${entry.label}`);
  const flag = entry.hits.length > 0 ? '#f2b705' : '#e8e8e8';
  const band = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL}" height="${LABEL_BAND}">`
    + `<rect width="${CELL}" height="${LABEL_BAND}" fill="#111"/>`
    + `<text x="6" y="23" font-family="monospace" font-size="15" fill="${flag}">${caption}</text>`
    + '</svg>',
  );
  return sharp({ create: { width: CELL, height: CELL + LABEL_BAND, channels: 3, background: '#000' } })
    .composite([{ input: image, top: 0, left: 0 }, { input: band, top: CELL, left: 0 }])
    .png()
    .toBuffer();
}

async function main() {
  const rows = await readPublicFeed();
  const handles = await readHandles([...new Set(rows.map((row) => row.user_id))]);
  const entries = rows.map((row) => toEntry(row, handles));
  console.log(`Public and visible: ${entries.length} post(s).`);

  const cells: Buffer[] = [];
  let missing = 0;
  for (const entry of entries) {
    if (!entry.previewPath) {
      // Text posts and resource bundles carry no media; there is nothing to look at.
      missing += 1;
      continue;
    }
    const publicUrl = client.storage.from(SHOWCASE_BUCKET).getPublicUrl(entry.previewPath).data.publicUrl;
    const response = await fetch(publicUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      missing += 1;
      console.warn(`  no cover for ${entry.id} (${response.status})`);
      continue;
    }
    cells.push(await renderCell(entry, Buffer.from(await response.arrayBuffer())));
  }

  const flagged = entries.filter((entry) => entry.hits.length > 0);
  if (flagged.length > 0) {
    console.log(`\nNamed a third party in text (${flagged.length}); the sheet is still the real check:`);
    for (const entry of flagged) {
      console.log(`  ${entry.created}  @${entry.username}  ${entry.label}  [${entry.hits.join(', ')}]  ${entry.id}`);
    }
  } else {
    console.log('\nNo post names a third party in its text. That is weak evidence: the post that');
    console.log('caused the 5.2.1 rejection would not have appeared here either. Read the sheet.');
  }

  if (cells.length === 0) {
    console.log('\nNo covers to render.');
    return;
  }

  const rowCount = Math.ceil(cells.length / COLUMNS);
  const sheet = await sharp({
    create: {
      width: COLUMNS * CELL,
      height: rowCount * (CELL + LABEL_BAND),
      channels: 3,
      background: '#000',
    },
  })
    .composite(cells.map((input, index) => ({
      input,
      top: Math.floor(index / COLUMNS) * (CELL + LABEL_BAND),
      left: (index % COLUMNS) * CELL,
    })))
    .png()
    .toBuffer();

  await mkdir(outDir, { recursive: true });
  const sheetPath = path.join(outDir, `public-feed-${new Date().toISOString().slice(0, 10)}.png`);
  await writeFile(sheetPath, sheet);

  console.log(`\nWrote ${sheetPath} — ${cells.length} cover(s), ${COLUMNS}x${rowCount}.`);
  if (missing > 0) console.log(`${missing} post(s) had no cover to render.`);
  console.log('\nOpen it and look. Anything resembling a recognisable character comes down with:');
  console.log("  update posts set review_status='hidden', reviewed_at=now() where id in (...);");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
