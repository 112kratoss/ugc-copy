import clsx from 'clsx';
import { Ban, Check, CheckCheck } from 'lucide-react';
import Link from 'next/link';

import { Surface, Text } from '@/components/DesignSystem';
import { requireAdminIdentity } from '@/lib/admin-auth';
import {
  listAnsweredOpenSupportConversations,
  listResolvedSupportConversations,
  listSupportConversationsAwaitingReply,
  type AdminSupportConversation,
} from '@/lib/admin-support-service';
import { createServiceClient } from '@/lib/server-helpers';

import { SUPPORT_WORDS, supportPreviewText } from '../../../../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';
import {
  EmptyState,
  PageHeader,
  Pagination,
  StatCard,
  formatRelative,
  parseOffset,
  shortId,
} from '../AdminUi';
import { AdminSupportInboxRefresh } from './AdminSupportInboxRefresh';

export const dynamic = 'force-dynamic';

const RESOLVED_PAGE_SIZE = 25;

function accountName(conversation: AdminSupportConversation) {
  return conversation.displayName
    || (conversation.username ? `@${conversation.username}` : shortId(conversation.userId));
}

function initials(name: string) {
  const letters = name.replace(/^@/, '').trim().split(/\s+/).map((part) => part[0] ?? '').join('');
  return (letters || '?').slice(0, 2).toUpperCase();
}

/** One conversation, as a chat app's list draws one: who, the latest message with its ticks, when, and the unread count. */
function ConversationRow({ conversation, waitingSince }: { conversation: AdminSupportConversation; waitingSince?: boolean }) {
  const name = accountName(conversation);
  const unread = conversation.unreadCount > 0;
  const deleted = conversation.lastMessageAuthor !== null
    && conversation.lastMessagePreview === null
    && !conversation.lastMessageHasPhoto;

  return (
    <li>
      <Link
        href={`/admin/support/${conversation.id}`}
        className="ui-focus-ring flex items-center gap-3 rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-4 py-3 transition-colors hover:border-[var(--ui-border-default)] hover:bg-[var(--ui-surface-2)]"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--ui-surface-3)] text-sm font-semibold text-[var(--ui-text-secondary)]">
          {initials(name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={clsx('truncate text-sm', unread ? 'font-bold text-[var(--ui-text-primary)]' : 'font-semibold text-[var(--ui-text-primary)]')}>
              {name}
            </span>
            <span className={clsx('shrink-0 text-xs', unread ? 'font-semibold text-[var(--ui-primary)]' : 'text-[var(--ui-text-faint)]')}>
              {waitingSince
                ? `Waiting ${formatRelative(conversation.lastUserMessageAt)}`
                : formatRelative(conversation.lastMessageAt)}
            </span>
          </span>
          <span className="mt-0.5 flex items-center justify-between gap-2">
            {conversation.userTyping ? (
              <span className="truncate text-sm font-medium text-[var(--ui-primary)]">{SUPPORT_WORDS.typing}</span>
            ) : (
              <span className="flex min-w-0 items-center gap-1 text-sm text-[var(--ui-text-secondary)]">
                {conversation.lastMessageAuthor === 'staff' && !deleted ? (
                  conversation.lastStaffMessageRead
                    ? <CheckCheck className="h-4 w-4 shrink-0 text-[var(--ui-accent-image)]" aria-label="Read" />
                    : <Check className="h-4 w-4 shrink-0 text-[var(--ui-text-faint)]" aria-label="Sent" />
                ) : null}
                {deleted ? (
                  <span className="flex min-w-0 items-center gap-1 italic text-[var(--ui-text-faint)]">
                    <Ban className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">
                      {conversation.lastMessageAuthor === 'staff' ? SUPPORT_WORDS.youDeleted : SUPPORT_WORDS.deleted}
                    </span>
                  </span>
                ) : (
                  <span className="truncate">
                    {conversation.lastMessageAuthor === 'staff' ? <span className="text-[var(--ui-text-faint)]">You: </span> : null}
                    {conversation.lastMessageHasPhoto
                      ? supportPreviewText(conversation.lastMessagePreview, true)
                      : conversation.lastMessagePreview ?? '—'}
                  </span>
                )}
              </span>
            )}
            {unread ? (
              <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[var(--ui-primary)] px-1.5 text-[11px] font-semibold text-[var(--ui-primary-on)]">
                {conversation.unreadCount}
              </span>
            ) : null}
          </span>
        </span>
      </Link>
    </li>
  );
}

function ConversationList({
  conversations,
  empty,
  waitingSince,
}: {
  conversations: AdminSupportConversation[];
  empty: string;
  waitingSince?: boolean;
}) {
  if (conversations.length === 0) return <EmptyState message={empty} />;
  return (
    <ul className="space-y-2">
      {conversations.map((conversation) => (
        <ConversationRow key={conversation.id} conversation={conversation} waitingSince={waitingSince} />
      ))}
    </ul>
  );
}

export default async function AdminSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ resolved?: string }>;
}) {
  await requireAdminIdentity();
  const { resolved: resolvedParam } = await searchParams;
  const resolvedOffset = parseOffset(resolvedParam, RESOLVED_PAGE_SIZE);

  const client = createServiceClient();
  const [waiting, answered, resolved] = await Promise.all([
    listSupportConversationsAwaitingReply(client),
    listAnsweredOpenSupportConversations(client),
    listResolvedSupportConversations(client, { limit: RESOLVED_PAGE_SIZE, offset: resolvedOffset }),
  ]);

  return (
    <>
      <AdminSupportInboxRefresh />
      <PageHeader
        title="Support"
        description="Conversations accounts started from Help & support in the app or on the web. New messages show here as they come; a reply reaches the account as a notification, and the account writing again reopens a resolved conversation."
      />

      <section className="grid gap-3 sm:grid-cols-2">
        <StatCard label="Waiting on us" value={waiting.length} tone={waiting.length > 0 ? 'warning' : 'neutral'} />
        <StatCard label="Waiting on them" value={answered.length} />
      </section>

      <section className="mt-6">
        <Text as="h2" variant="cardTitle" className="mb-3">Waiting on us</Text>
        <ConversationList conversations={waiting} empty="Nobody is waiting on a reply." waitingSince />
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">Answered, still open</Text>
        <ConversationList conversations={answered} empty="No open conversations are waiting on an account." />
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">Resolved</Text>
        <Surface variant="ghost" padding="none">
          <ConversationList conversations={resolved.conversations} empty="No conversations have been resolved yet." />
        </Surface>
        <Pagination
          basePath="/admin/support"
          offsetParam="resolved"
          offset={resolved.offset}
          pageSize={RESOLVED_PAGE_SIZE}
          total={resolved.total}
          noun="resolved conversations"
        />
      </section>
    </>
  );
}
