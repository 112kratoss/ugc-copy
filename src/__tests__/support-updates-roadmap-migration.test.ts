import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SUPPORT_REACTION_EMOJIS } from '../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';
import {
  SUPPORT_ROADMAP_SUMMARY_MAX_LENGTH,
  SUPPORT_ROADMAP_TITLE_MAX_LENGTH,
  SUPPORT_UPDATE_KINDS,
} from '../../ugc-mobile/lib/support-hub-policy/support-hub-policy';
import { OPERATIONAL_TABLE_ROW_BUDGETS } from '@/lib/operational-table-growth';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');
const migration = read('supabase/migrations/20261126175321_support_updates_roadmap.sql');
const previousTypeCheck = read('supabase/migrations/20261122150427_support_conversations.sql');
const previousGrowth = read('supabase/migrations/20261123070741_post_view_count_totals.sql');

/** The public tables a definition of get_operational_table_growth() reports. */
function growthTables(sql: string): string[] {
  const start = sql.lastIndexOf('stats.relname = ANY (ARRAY[');
  expect(start).toBeGreaterThanOrEqual(0);
  return [...sql.slice(start, sql.indexOf('])', start)).matchAll(/'([a-z_]+)'/g)].map((match) => match[1] ?? '');
}

/** A function's text, from its CREATE line to the end of its body. */
function functionText(header: string) {
  const start = migration.indexOf(header);
  expect(start, header).toBeGreaterThanOrEqual(0);
  return migration.slice(start, migration.indexOf('\n$$;', start) + 4);
}

/** The quoted strings of a CHECK (type IN (...)) list. */
function typeList(sql: string): string[] {
  const start = sql.lastIndexOf('ADD CONSTRAINT mobile_notifications_type_check CHECK (type IN (');
  expect(start).toBeGreaterThanOrEqual(0);
  const list = sql.slice(start, sql.indexOf('));', start));
  return [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1] ?? '');
}

const SERVICE_FUNCTIONS = [
  'support_official_account_id()',
  'set_support_update(uuid, text, boolean)',
  'support_update_reaction_counts(uuid)',
  'support_update_reactions_for(uuid[], uuid)',
  'set_support_update_reaction(uuid, uuid, text)',
  'support_roadmap_reaction_counts(uuid)',
  'support_roadmap_reactions_for(uuid[], uuid)',
  'set_support_roadmap_reaction(uuid, uuid, text)',
  'support_update_alert_batch(uuid, integer)',
  'ship_support_roadmap_item(uuid, uuid, text, text)',
];

describe('support updates and roadmap migration', () => {
  it('marks updates on posts and lets the console lock a post\'s comments', () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS support_update_kind text\n    CHECK (support_update_kind IN ('announcement', 'shipped'))");
    expect([...SUPPORT_UPDATE_KINDS]).toEqual(['announcement', 'shipped']);
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS comments_locked boolean NOT NULL DEFAULT false');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS posts_support_updates_idx');
    expect(migration).toContain('WHERE support_update_kind IS NOT NULL;');
  });

  it('refuses a comment on a locked post in words the comment service reads', () => {
    expect(migration).toContain('BEFORE INSERT ON public.post_comments');
    expect(migration).toContain("RAISE EXCEPTION 'Comments are locked on this post';");
    expect(read('src/lib/post-comments-service.ts')).toContain('/Comments are locked on this post/');
  });

  it('makes only a public post of the official account an update', () => {
    expect(functionText('CREATE OR REPLACE FUNCTION public.support_official_account_id()')).toContain("WHERE profile.username = 'magicbooklet'");
    const mark = functionText('CREATE OR REPLACE FUNCTION public.set_support_update(');
    expect(mark).toContain("RETURN jsonb_build_object('status', 'not_official');");
    expect(mark).toContain("IF p_kind IS NOT NULL AND v_post.visibility <> 'public' THEN");
  });

  it('grants nothing to a client role: the API is the only door', () => {
    for (const table of ['support_update_reactions', 'support_roadmap_items', 'support_roadmap_reactions', 'support_update_broadcasts']) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`REVOKE ALL PRIVILEGES ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`);
    }
    expect(migration).not.toMatch(/GRANT [^;]* TO (anon|authenticated)/);
    expect(migration).not.toMatch(/CREATE POLICY/i);
  });

  it('lets the service role change reactions and a broadcast\'s progress only through the functions', () => {
    expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.support_update_reactions FROM service_role;');
    expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.support_roadmap_reactions FROM service_role;');
    expect(migration).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.support_update_broadcasts FROM service_role;');
  });

  it('keeps every function the service role\'s alone, with a fixed search path', () => {
    for (const signature of SERVICE_FUNCTIONS) {
      expect(migration, signature).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`);
      expect(migration, signature).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`);
    }
    const definers = migration.split('SECURITY DEFINER').length - 1;
    // The growth report keeps its own definition's STABLE and pg_catalog.
    const pinned = migration.match(/SECURITY DEFINER\n(?:STABLE\n)?SET search_path = public, (?:pg_catalog, )?pg_temp/g)?.length ?? 0;
    expect(pinned).toBe(definers);
  });

  it('takes the support chat\'s six quick reactions, one per account', () => {
    const quoted = SUPPORT_REACTION_EMOJIS.map((emoji) => `'${emoji}'`).join(', ');
    expect(migration.split(`emoji text NOT NULL CHECK (emoji IN (${quoted}))`).length - 1).toBe(2);
    expect(migration.split(`p_emoji NOT IN (${quoted})`).length - 1).toBe(2);
    expect(migration).toContain('PRIMARY KEY (post_id, user_id)');
    expect(migration).toContain('PRIMARY KEY (item_id, user_id)');
  });

  it('holds the roadmap to the console\'s limits and a shipped item to its date', () => {
    expect(migration).toContain(`CHECK (char_length(btrim(title)) BETWEEN 1 AND ${SUPPORT_ROADMAP_TITLE_MAX_LENGTH})`);
    expect(migration).toContain(`CHECK (char_length(summary) <= ${SUPPORT_ROADMAP_SUMMARY_MAX_LENGTH})`);
    expect(migration).toContain("CHECK ((status = 'shipped') = (shipped_at IS NOT NULL))");
  });

  it('alerts registered, active accounts once each, linking the update\'s post page', () => {
    const batch = functionText('CREATE OR REPLACE FUNCTION public.support_update_alert_batch(');
    expect(batch).toContain('WHERE u.is_anonymous IS NOT TRUE');
    expect(batch).toContain("AND profile.identity_state = 'active'");
    expect(batch).toContain('AND u.id IS DISTINCT FROM (SELECT post.user_id FROM public.posts post WHERE post.id = p_post_id)');
    expect(batch).toContain("'support_update:' || p_post_id::text");
    expect(batch).toContain('ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING');
    expect(batch).toContain("'/showcase/' || p_post_id::text");
    expect(batch).toContain('FOR UPDATE SKIP LOCKED');
    // A take-down pauses a broadcast rather than ending it: once the update is
    // back up, Continue sending reaches everyone after the cursor.
    expect(batch).toContain("RETURN jsonb_build_object('status', 'paused'");
    expect(batch).not.toMatch(/'withdrawn'/);

    const ship = functionText('CREATE OR REPLACE FUNCTION public.ship_support_roadmap_item(');
    expect(ship).toContain("'support_roadmap_shipped:' || p_item_id::text");
    expect(ship).toContain('IF v_item.shipped_alerts_sent_at IS NULL THEN');
    expect(ship).toContain('ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING');
  });

  it('alerts in the app only: no broadcast or alert answers for a push to follow', () => {
    // A push of news needs an opt-in of its own (App Store guideline 4.5.4).
    const broadcasts = migration.slice(
      migration.indexOf('CREATE TABLE public.support_update_broadcasts ('),
      migration.indexOf(');', migration.indexOf('CREATE TABLE public.support_update_broadcasts (')),
    );
    expect(broadcasts).toContain('post_id uuid PRIMARY KEY');
    expect(broadcasts).not.toMatch(/\bpush\b/);
    for (const name of ['support_update_alert_batch(', 'ship_support_roadmap_item(']) {
      const body = functionText(`CREATE OR REPLACE FUNCTION public.${name}`);
      expect(body).toContain("'told'");
      expect(body).not.toContain("'written'");
    }
  });

  it('has the growth report read the reactions, held to their budgets, and everything it read before', () => {
    const before = growthTables(previousGrowth);
    const after = growthTables(migration);
    expect(after).toEqual([...before, 'support_roadmap_reactions', 'support_update_reactions'].sort());
    expect(OPERATIONAL_TABLE_ROW_BUDGETS.support_update_reactions).toBeDefined();
    expect(OPERATIONAL_TABLE_ROW_BUDGETS.support_roadmap_reactions).toBeDefined();
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.get_operational_table_growth()\n  FROM PUBLIC, anon, authenticated;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.get_operational_table_growth()\n  TO service_role;');
  });

  it('says what it locks and for how long', () => {
    expect(migration).toContain('-- Locks:');
    expect(migration).toMatch(/SET lock_timeout = '5s'/);
  });

  it('widens the alert types with the two new ones and keeps every earlier type', () => {
    const before = typeList(previousTypeCheck);
    const after = typeList(migration);
    expect(after).toEqual([...before, 'support_update', 'support_roadmap_shipped']);
    const types = read('src/lib/mobile-notifications.ts');
    expect(types).toContain("| 'support_update'");
    expect(types).toContain("| 'support_roadmap_shipped'");
  });
});
