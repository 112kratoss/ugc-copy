import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { requireAdminIdentity } from '@/lib/admin-auth';
import { getAdminSupportConversation } from '@/lib/admin-support-service';
import { createServiceClient } from '@/lib/server-helpers';

import { formatTimestamp, shortId } from '../../AdminUi';
import { AdminSupportThread } from '../AdminSupportThread';

export const dynamic = 'force-dynamic';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdminSupportConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  await requireAdminIdentity();
  const { conversationId } = await params;
  if (!UUID_PATTERN.test(conversationId)) notFound();

  const thread = await getAdminSupportConversation(createServiceClient(), conversationId);
  if (!thread) notFound();

  const { conversation } = thread;
  const name = conversation.displayName
    || (conversation.username ? `@${conversation.username}` : shortId(conversation.userId));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link href="/admin/support" className="ui-focus-ring inline-flex items-center gap-1.5 rounded-lg text-sm text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)]">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          All conversations
        </Link>
        <span className="text-xs text-[var(--ui-text-faint)]">Started {formatTimestamp(conversation.createdAt)}</span>
      </div>

      <AdminSupportThread
        conversationId={conversation.id}
        accountName={name}
        accountHandle={conversation.username}
        userId={conversation.userId}
      />
    </>
  );
}
