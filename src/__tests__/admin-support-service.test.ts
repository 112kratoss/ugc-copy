import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { listSupportConversationsAwaitingReply } from '@/lib/admin-support-service';

import { supportPreviewText } from '../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

/** The conversations and profiles a console list reads, whatever its filters. */
function fakeClient(conversations: Array<Record<string, unknown>>) {
  const select = vi.fn();
  const client = {
    from(table: string) {
      const rows = table === 'support_conversations'
        ? conversations
        : [{ id: 'account-1', username: 'asha', display_name: 'Asha' }];
      const builder = {
        select(columns: string) {
          select(table, columns);
          return builder;
        },
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        limit: async () => ({ data: rows, error: null }),
        then: (resolve: (value: { data: unknown[]; error: null }) => void) => resolve({ data: rows, error: null }),
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, select };
}

const row = (overrides: Record<string, unknown>) => ({
  id: 'conversation-1',
  user_id: 'account-1',
  status: 'open',
  awaiting_reply: true,
  created_at: '2026-11-21T09:00:00Z',
  last_message_at: '2026-11-21T09:30:00Z',
  last_user_message_at: '2026-11-21T09:30:00Z',
  last_staff_message_at: null,
  last_message_preview: 'My video failed',
  last_message_author: 'user',
  last_message_has_photo: false,
  resolved_at: null,
  staff_unread_count: 1,
  user_last_read_at: null,
  staff_last_read_at: null,
  user_typing_until: null,
  staff_typing_until: null,
  ...overrides,
});

describe('the console\'s list of conversations', () => {
  it('says a latest message is a photo, so a photo without a caption is not read as deleted', async () => {
    const { client, select } = fakeClient([
      row({ id: 'photo', last_message_preview: null, last_message_has_photo: true }),
      row({ id: 'caption', last_message_preview: 'The error', last_message_has_photo: true }),
      row({ id: 'deleted', last_message_preview: null, last_message_has_photo: false }),
    ]);

    const [photo, caption, deleted] = await listSupportConversationsAwaitingReply(client, { now: Date.parse('2026-11-21T10:00:00Z') });

    expect(select).toHaveBeenCalledWith('support_conversations', expect.stringContaining('last_message_has_photo'));
    expect(photo).toMatchObject({ lastMessagePreview: null, lastMessageHasPhoto: true, displayName: 'Asha' });
    expect(caption).toMatchObject({ lastMessagePreview: 'The error', lastMessageHasPhoto: true });
    expect(deleted).toMatchObject({ lastMessagePreview: null, lastMessageHasPhoto: false });
    // What the list draws for each.
    expect(supportPreviewText(photo.lastMessagePreview, photo.lastMessageHasPhoto)).toBe('📷 Photo');
    expect(supportPreviewText(caption.lastMessagePreview, caption.lastMessageHasPhoto)).toBe('📷 The error');
  });
});
