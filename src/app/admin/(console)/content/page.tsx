import Link from 'next/link';
import clsx from 'clsx';

import { Text } from '@/app/components/DesignSystem';
import {
  collectAdminContentSnapshot,
  type AdminGenerationFilter,
  type AdminPostFilter,
} from '@/lib/admin-content-service';
import { createServiceClient } from '@/lib/server-helpers';

import { PostModerationControls } from './PostModerationControls';

import {
  DataTable,
  EmptyState,
  PageHeader,
  Pagination,
  StatCard,
  StatusBadge,
  Td,
  formatTimestamp,
  parseOffset,
  shortId,
} from '../AdminUi';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 40;

const POST_FILTERS: AdminPostFilter[] = ['all', 'public', 'hidden', 'reported'];
const GENERATION_FILTERS: AdminGenerationFilter[] = ['all', 'failed', 'processing'];

function FilterLinks<T extends string>({
  current,
  options,
  param,
  otherParams,
}: {
  current: T;
  options: readonly T[];
  param: string;
  otherParams: Record<string, string>;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const query = new URLSearchParams({ ...otherParams, [param]: option });
        return (
          <Link
            key={option}
            href={`/admin/content?${query.toString()}`}
            className={clsx(
              'ui-button ui-focus-ring capitalize',
              option === current ? 'ui-button-primary' : 'ui-button-secondary',
            )}
          >
            {option}
          </Link>
        );
      })}
    </div>
  );
}

export default async function AdminContentPage({
  searchParams,
}: {
  searchParams: Promise<{
    posts?: string;
    generations?: string;
    postPage?: string;
    generationPage?: string;
  }>;
}) {
  const {
    posts: postsParam,
    generations: generationsParam,
    postPage,
    generationPage,
  } = await searchParams;

  const postFilter = (POST_FILTERS.includes(postsParam as AdminPostFilter)
    ? postsParam
    : 'all') as AdminPostFilter;
  const generationFilter = (GENERATION_FILTERS.includes(generationsParam as AdminGenerationFilter)
    ? generationsParam
    : 'all') as AdminGenerationFilter;

  const postOffset = parseOffset(postPage, PAGE_SIZE);
  const generationOffset = parseOffset(generationPage, PAGE_SIZE);

  const snapshot = await collectAdminContentSnapshot(createServiceClient(), {
    postFilter,
    generationFilter,
    limit: PAGE_SIZE,
    postOffset,
    generationOffset,
  });

  return (
    <>
      <PageHeader
        title="Content"
        description="Published posts and the generation pipeline behind them."
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Posts" value={snapshot.totals.posts} />
        <StatCard label="Hidden posts" value={snapshot.totals.hiddenPosts} />
        <StatCard label="Generations 24h" value={snapshot.totals.generations24h} />
        <StatCard
          label="Failed 24h"
          value={snapshot.totals.failedGenerations24h}
          tone={snapshot.totals.failedGenerations24h > 0 ? 'danger' : 'ok'}
        />
      </section>

      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <Text as="h2" variant="cardTitle">Posts</Text>
          <FilterLinks
            current={postFilter}
            options={POST_FILTERS}
            param="posts"
            otherParams={{
              generations: generationFilter,
              ...(snapshot.pageOffsets.generations > 0 ? { generationPage: String(snapshot.pageOffsets.generations) } : {}),
            }}
          />
        </div>

        {snapshot.posts.length === 0 ? (
          <EmptyState message="No posts match this filter." />
        ) : (
          <DataTable columns={['Created', 'Title', 'Visibility', 'Review', 'Reports', 'Saves', 'Author', 'Moderation']}>
            {snapshot.posts.map((post) => (
              <tr key={post.id}>
                <Td>{formatTimestamp(post.createdAt)}</Td>
                <Td truncateWidth={260}>
                  <Link href={`/post/${post.id}`} target="_blank" rel="noreferrer" className="underline">
                    {post.title || 'Untitled'}
                  </Link>
                </Td>
                <Td><StatusBadge status={post.visibility} /></Td>
                <Td><StatusBadge status={post.reviewStatus} /></Td>
                <Td className={post.reportCount > 0 ? 'font-bold text-[var(--ui-accent-danger)]' : undefined}>
                  {post.reportCount}
                </Td>
                <Td>{post.saveCount}</Td>
                <Td>
                  <Link href={`/admin/users/${post.userId}`} className="font-mono text-xs underline">
                    {shortId(post.userId)}
                  </Link>
                </Td>
                <Td>
                  <PostModerationControls postId={post.id} reviewStatus={post.reviewStatus} />
                </Td>
              </tr>
            ))}
          </DataTable>
        )}

        <Pagination
          basePath="/admin/content"
          offsetParam="postPage"
          offset={snapshot.pageOffsets.posts}
          pageSize={PAGE_SIZE}
          total={snapshot.pageTotals.posts}
          otherParams={{
            posts: postFilter,
            generations: generationFilter,
            ...(snapshot.pageOffsets.generations > 0 ? { generationPage: String(snapshot.pageOffsets.generations) } : {}),
          }}
          noun="posts"
        />
      </section>

      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <Text as="h2" variant="cardTitle">Generations</Text>
          <FilterLinks
            current={generationFilter}
            options={GENERATION_FILTERS}
            param="generations"
            otherParams={{
              posts: postFilter,
              ...(snapshot.pageOffsets.posts > 0 ? { postPage: String(snapshot.pageOffsets.posts) } : {}),
            }}
          />
        </div>

        {snapshot.generations.length === 0 ? (
          <EmptyState message="No generations match this filter." />
        ) : (
          <DataTable columns={['Created', 'Status', 'Model', 'Mode', 'Cost', 'Error', 'User']}>
            {snapshot.generations.map((generation) => (
              <tr key={generation.id}>
                <Td>{formatTimestamp(generation.createdAt)}</Td>
                <Td><StatusBadge status={generation.status} /></Td>
                <Td>{generation.model ?? '—'}</Td>
                <Td>{generation.creationMode ?? '—'}</Td>
                <Td>{generation.cost?.toLocaleString() ?? '—'}</Td>
                <Td truncateWidth={240}>{generation.errorMessage ?? '—'}</Td>
                <Td>
                  <Link href={`/admin/users/${generation.userId}`} className="font-mono text-xs underline">
                    {shortId(generation.userId)}
                  </Link>
                </Td>
              </tr>
            ))}
          </DataTable>
        )}

        <Pagination
          basePath="/admin/content"
          offsetParam="generationPage"
          offset={snapshot.pageOffsets.generations}
          pageSize={PAGE_SIZE}
          total={snapshot.pageTotals.generations}
          otherParams={{
            posts: postFilter,
            generations: generationFilter,
            ...(snapshot.pageOffsets.posts > 0 ? { postPage: String(snapshot.pageOffsets.posts) } : {}),
          }}
          noun="generations"
        />
      </section>
    </>
  );
}
