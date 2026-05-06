import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { getOwnerPostDetail } from '@/lib/owner-posts';
import { getServerAuthState } from '@/lib/supabase-server';
import type { EditablePostDraft } from '@/app/post/new/post-editor-types';
import NewPostClient from '@/app/post/new/NewPostClient';

type EditPostPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function toEditablePostDraft(post: NonNullable<Awaited<ReturnType<typeof getOwnerPostDetail>>>): EditablePostDraft {
  return {
    id: post.id,
    generationId: post.generationId,
    title: post.title,
    description: post.description,
    prompt: post.prompt,
    body: post.body,
    visibility: post.visibility,
    category: post.category,
    postFormat: post.postFormat,
    sourceKind: post.sourceKind,
    sourceTool: post.sourceTool,
    sourceToolSlug: post.sourceToolSlug,
    mediaUrl: post.mediaUrl,
    mediaKind: post.mediaKind,
    archivedAt: post.archivedAt,
    resourceBundle: post.resourceBundleInput,
    hasPaidOrders: post.hasPaidOrders,
  };
}

export default async function EditPostPage({ params, searchParams }: EditPostPageProps) {
  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  const auth = await getServerAuthState();
  const returnUrlSearchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(resolvedSearchParams)) {
    if (typeof value === 'string' && value) {
      returnUrlSearchParams.set(key, value);
    }
  }

  const returnUrl = returnUrlSearchParams.size > 0
    ? `/post/${id}/edit?${returnUrlSearchParams.toString()}`
    : `/post/${id}/edit`;

  if (!auth.session?.user) {
    redirect(`/login?returnUrl=${encodeURIComponent(returnUrl)}`);
  }

  const headerStore = await headers();
  const post = await getOwnerPostDetail(id, auth.session.user.id, {
    countryCode: headerStore.get('x-vercel-ip-country'),
  });

  if (!post) {
    notFound();
  }

  return <NewPostClient initialPost={toEditablePostDraft(post)} />;
}
