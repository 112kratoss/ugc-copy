import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { STORAGE_BUCKET_IDS } from '@/lib/storage-buckets';

import {
  SUPPORT_DELETE_WINDOW_HOURS,
  SUPPORT_EDIT_WINDOW_MINUTES,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_REACTION_EMOJIS,
  SUPPORT_TYPING_SECONDS,
} from '../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

const readMigration = (name: string) => fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations', name), 'utf8');
const migration = readMigration('20261122150427_support_conversations.sql');

const DELETION_FUNCTION = 'CREATE OR REPLACE FUNCTION public.prepare_account_deletion(p_user_id uuid)';
/** A function's text, from its CREATE line to the end of its body. */
function functionText(sql: string, header: string) {
  const start = sql.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  return sql.slice(start, sql.indexOf('\n$$;', start) + 4);
}
/** The support functions alone, before the copy of the account deletion's manifest. */
const supportPart = migration.slice(0, migration.indexOf(DELETION_FUNCTION));

const FUNCTIONS = [
  'send_support_message(uuid, text, text, text, uuid, jsonb)',
  'edit_support_message(uuid, text, uuid, text)',
  'delete_support_message(uuid, text, uuid)',
  'set_support_message_reaction(uuid, text, uuid, text)',
  'mark_support_conversation_read(uuid, text)',
  'set_support_conversation_typing(uuid, text, boolean)',
  'support_message_payload(uuid)',
];

describe('support conversations migration', () => {
  it('keeps one conversation per account, deleted with the account', () => {
    expect(migration).toContain('CREATE TABLE public.support_conversations (');
    expect(migration).toContain('user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE');
    expect(migration).toContain('conversation_id uuid NOT NULL REFERENCES public.support_conversations(id) ON DELETE CASCADE');
    expect(migration).toContain('message_id uuid NOT NULL REFERENCES public.support_messages(id) ON DELETE CASCADE');
  });

  it('grants nothing to a client role: the API is the only door', () => {
    for (const table of ['support_conversations', 'support_messages', 'support_message_reactions']) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`REVOKE ALL PRIVILEGES ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`);
    }
    expect(migration).not.toMatch(/GRANT [^;]* TO (anon|authenticated)/);
    expect(migration).not.toMatch(/CREATE POLICY/i);
  });

  it('lets the service role add messages but change them only through the functions', () => {
    expect(migration).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.support_messages FROM service_role;');
    expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.support_message_reactions FROM service_role;');
    expect(migration).toContain('REVOKE DELETE, TRUNCATE ON TABLE public.support_conversations FROM service_role;');
    expect(migration).toContain('GRANT SELECT, INSERT ON TABLE public.support_messages TO service_role;');
    expect(migration).toContain('GRANT SELECT ON TABLE public.support_message_reactions TO service_role;');
  });

  it('holds a message to text, a photo or both while it stands, the text to the shared rule, and keeps nothing once deleted', () => {
    expect(migration).toContain('AND (body IS NOT NULL OR attachment_kind IS NOT NULL)');
    expect(migration).toContain(`AND (body IS NULL OR char_length(body) BETWEEN 1 AND ${SUPPORT_MESSAGE_MAX_LENGTH}))`);
    expect(migration).toContain('OR (deleted_at IS NOT NULL AND body IS NULL AND attachment_kind IS NULL)');
    // The send's text and caption, and the edit's text.
    expect(migration.match(new RegExp(`char_length\\(v_body\\) > ${SUPPORT_MESSAGE_MAX_LENGTH}`, 'g'))).toHaveLength(3);
  });

  it('keeps a photo whole on its message, in the account\'s own folder, its sizes bounded', () => {
    for (const column of ['attachment_kind', 'attachment_path', 'attachment_preview_path', 'attachment_width', 'attachment_height', 'attachment_bytes', 'attachment_thumbhash']) {
      expect(migration).toContain(`  ${column} `);
    }
    expect(migration).toContain("attachment_kind IS NULL OR attachment_kind = 'image'");
    expect(migration).toContain('CONSTRAINT support_messages_attachment_whole CHECK (');
    expect(migration).toContain('AND attachment_width BETWEEN 1 AND 20000');
    expect(migration).toContain('AND attachment_bytes BETWEEN 1 AND 10485760');
    // The send takes paths only inside the conversation owner's folder, never one that climbs out.
    expect(migration).toContain("v_folder text := p_user_id::text || '/';");
    expect(migration).toContain('OR left(v_attachment_path, char_length(v_folder)) <> v_folder');
    expect(migration).toContain('OR left(v_attachment_preview_path, char_length(v_folder)) <> v_folder');
    expect(migration).toContain("OR v_attachment_path LIKE '%..%'");
    expect(migration).toContain('last_message_has_photo = v_attachment IS NOT NULL,');
  });

  it('keeps the photos in a private bucket the server writes WebP to, listed with every other', () => {
    expect(migration).toMatch(/VALUES \(\s+'support_attachments',\s+'support_attachments',\s+false,\s+10485760,\s+ARRAY\['image\/webp'\]::text\[\]\s+\)/);
    expect(STORAGE_BUCKET_IDS).toContain('support_attachments');
    // No client role gets a policy or a grant on the objects: only the service role signs links.
    expect(migration).not.toMatch(/(CREATE POLICY|GRANT)[^;]*storage\.objects/i);
  });

  it('answers a photo\'s paths to the server only, and a deleted one\'s for Storage to remove', () => {
    expect(migration).toContain("'preview_path', m.attachment_preview_path,");
    expect(migration).toContain("'attachment_kind', r.attachment_kind");
    const deletion = functionText(migration, 'CREATE OR REPLACE FUNCTION public.delete_support_message(');
    expect(deletion).toContain('attachment_path = NULL,');
    expect(deletion).toContain("'removed_paths', CASE");
    expect(deletion).toContain('jsonb_build_array(v_message.attachment_path, v_message.attachment_preview_path)');
    expect(deletion).toContain('last_message_has_photo = false');
  });

  it('lets a support send claim a staged upload, keeping every earlier consumer', () => {
    expect(migration).toContain('ALTER TABLE public.media_upload_intents DROP CONSTRAINT IF EXISTS media_upload_intents_consumed_by_check;');
    for (const consumer of ['post_publish', 'post_update', 'generation_input', 'generation_restore', 'support_message']) {
      expect(migration).toContain(`  '${consumer}'`);
    }
  });

  it('erases an account\'s support photos with its folder, changing nothing else in the manifest', () => {
    const replaced = functionText(migration, DELETION_FUNCTION);
    const previous = functionText(readMigration('20261030151942_post_keeps_its_deleted_creation_folder.sql'), DELETION_FUNCTION);
    const before = "      'template_inputs'\n    ),";
    const after = "      'template_inputs',\n      'support_attachments'\n    ),";
    expect(previous).toContain(before);
    expect(replaced.replace(after, before)).toBe(previous);
  });

  it('keeps the windows and the reactions the clients offer', () => {
    expect(migration).toContain(`v_message.created_at < v_now - interval '${SUPPORT_EDIT_WINDOW_MINUTES} minutes'`);
    expect(migration).toContain(`v_message.created_at < v_now - interval '${SUPPORT_DELETE_WINDOW_HOURS} hours'`);
    expect(migration).toContain(`clock_timestamp() + interval '${SUPPORT_TYPING_SECONDS} seconds'`);
    const quickSet = SUPPORT_REACTION_EMOJIS.map((emoji) => `'${emoji}'`).join(', ');
    // The table's check and the function's refusal both name exactly the quick set.
    expect(migration.split(`IN (${quickSet})`).length - 1).toBe(2);
  });

  it('writes through service-role functions only, each in one transaction behind the conversation\'s lock', () => {
    for (const signature of FUNCTIONS) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature}`);
      expect(migration).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature.replace(/[()]/g, '\\$&')}\\s+TO service_role;`));
    }
    expect(supportPart.match(/SECURITY DEFINER/g)).toHaveLength(6);
    expect(supportPart.match(/SET search_path = public, pg_temp/g)).toHaveLength(7);
    expect(supportPart.match(/FOR UPDATE;/g)).toHaveLength(4);
  });

  it('says which conversations wait on support from the row itself', () => {
    expect(migration).toContain('awaiting_reply boolean GENERATED ALWAYS AS (');
    expect(migration).toContain('WHERE awaiting_reply;');
  });

  it('keeps read receipts, unread counts and typing on the conversation, moved by a send', () => {
    for (const column of ['user_last_read_at', 'staff_last_read_at', 'user_unread_count', 'staff_unread_count', 'user_typing_until', 'staff_typing_until']) {
      expect(migration).toContain(`  ${column} `);
    }
    expect(migration).toContain("user_unread_count = CASE WHEN p_author = 'user' THEN 0 ELSE user_unread_count + 1 END");
    expect(migration).toContain("staff_typing_until = CASE WHEN p_author = 'staff' THEN NULL ELSE staff_typing_until END");
  });

  it('re-creates the notification type check with support_reply and every earlier type', () => {
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS mobile_notifications_type_check');
    expect(migration).toContain('ADD CONSTRAINT mobile_notifications_type_check CHECK (type IN (');
    for (const type of [
      'generation_succeeded', 'generation_failed', 'credits_purchased', 'purchases_restored',
      'marketplace_unlocked', 'post_resource_unlocked', 'creator_followed', 'post_saved', 'post_remixed',
      'post_shared', 'referral_reward_earned', 'referral_reward_reversed',
      'creator_payout_paid', 'creator_payout_rejected', 'support_reply',
    ]) {
      expect(migration).toContain(`'${type}'`);
    }
    expect(migration).toContain('notifySupportReplied');
  });
});
