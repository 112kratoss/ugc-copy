import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowRight,
  CalendarDays,
  Film,
  Globe,
  Heart,
  ImageIcon,
  Instagram,
  Layers3,
  MapPin,
  ShoppingBag,
  Twitter,
  Wand2,
} from 'lucide-react';

import TextPostPreviewCard from '@/app/components/TextPostPreviewCard';
import { getCreatorProfilePageData, type CreatorProfilePageData } from '@/lib/creator-profile';
import { buildCreatorProfilePath } from '@/lib/profile';
import {
  describePostResourceKinds,
  getBundleAccessLabel,
  getPostResourceKindLabel,
  isPostResourceKind,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';
import { formatBundleAccessLabel } from '@/lib/marketplace-trust';
import { buildShowcaseDetailPath } from '@/lib/share';
import { createMetadata } from '@/lib/seo';
import { CreatorContentTabs } from './CreatorContentTabs';
import { ProfileActions } from './ProfileActions';

type CreatorPageProps = {
  params: Promise<{ username: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type CreatorItem = CreatorProfilePageData['items'][number];

const categoryLabels: Record<CreatorItem['category'], string> = {
  image: 'Image',
  video: 'Video',
  motion: 'Motion',
  'ugc-ad': 'UGC ad',
  text: 'Tip',
};

function getCategoryLabel(category: CreatorItem['category']) {
  return categoryLabels[category] ?? 'Creation';
}

function getItemSourceLabel(item: CreatorItem) {
  return item.sourceTool || item.model || null;
}

function getItemResourceKinds(item: CreatorItem): PostResourceKind[] {
  return (item.asset?.resourceKinds ?? []).filter(isPostResourceKind);
}

function getAssetAccessLabel(asset: NonNullable<CreatorItem['asset']>): string {
  if (asset.priceQuote) {
    return formatBundleAccessLabel({
      accessMode: asset.accessMode,
      priceQuote: asset.priceQuote,
    });
  }

  return getBundleAccessLabel(asset.accessMode, asset.priceUsdCents);
}

function getItemSummary(item: CreatorItem) {
  const publicText = item.body?.trim() || item.prompt?.trim();
  if (publicText) {
    return publicText;
  }

  const source = getItemSourceLabel(item);
  const resourceKinds = getItemResourceKinds(item);
  const unlockSummary = item.asset
    ? resourceKinds.length > 0
      ? describePostResourceKinds(resourceKinds)
      : `${getAssetAccessLabel(item.asset)} attached.`
    : 'Public portfolio piece.';

  return [
    source ? `Made with ${source}` : null,
    `${getCategoryLabel(item.category)} creation`,
    unlockSummary,
  ].filter(Boolean).join(' / ');
}

function formatPortfolioDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

function FeaturedPreview({ item }: { item: CreatorItem }) {
  if (item.postFormat === 'text') {
    const resourceKinds = getItemResourceKinds(item);

    return (
      <TextPostPreviewCard
        title={item.title}
        summary={getItemSummary(item)}
        sourceLabel={getItemSourceLabel(item)}
        dateLabel={formatPortfolioDate(item.createdAt)}
        saveCount={item.saveCount}
        remixCount={item.remixCount}
        unlockLabel={item.asset ? getAssetAccessLabel(item.asset) : null}
        resourceKinds={resourceKinds}
        className="border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.16),transparent_38%),linear-gradient(180deg,rgba(12,12,17,0.98),rgba(5,5,8,0.98))] shadow-none"
        titleClassName="text-xl sm:text-2xl"
        summaryClassName="line-clamp-8 text-base leading-7 text-zinc-200"
      />
    );
  }

  if (item.mediaKind === 'video' && item.mediaUrl) {
    return (
      <video
        src={item.mediaUrl}
        muted
        loop
        playsInline
        autoPlay
        className="h-full min-h-[320px] w-full object-cover sm:min-h-[420px]"
      />
    );
  }

  if (item.mediaUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={item.mediaUrl}
        alt={item.title}
        className="h-full min-h-[320px] w-full object-cover transition duration-500 group-hover:scale-[1.02] sm:min-h-[420px]"
      />
    );
  }

  return (
    <div className="flex h-full min-h-[320px] items-center justify-center bg-zinc-950 text-zinc-500 sm:min-h-[420px]">
      <ImageIcon className="h-12 w-12" />
    </div>
  );
}

export async function generateMetadata({ params }: CreatorPageProps): Promise<Metadata> {
  const { username } = await params;
  const data = await getCreatorProfilePageData(username);

  if (!data) {
    return {
      title: 'Creator Not Found',
    };
  }

  const description =
    data.profile.bio ||
    `Browse the public creator portfolio from @${data.profile.username} on magicbooklet.`;

  return createMetadata({
    title: `${data.profile.displayName} (@${data.profile.username})`,
    description,
    path: buildCreatorProfilePath(data.profile.username),
    image: data.profile.coverUrl || data.profile.avatarUrl || undefined,
  });
}

function getParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeProfileLimit(value: string | undefined): number {
  const parsed = value ? Number.parseInt(value, 10) : 24;
  return Number.isFinite(parsed) ? Math.min(96, Math.max(24, parsed)) : 24;
}

export default async function CreatorPage({ params, searchParams }: CreatorPageProps) {
  const { username } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const headerStore = await headers();
  const data = await getCreatorProfilePageData(username, {
    limit: normalizeProfileLimit(getParam(resolvedSearchParams.limit)),
    countryCode: headerStore.get('x-vercel-ip-country'),
  });

  if (!data) {
    notFound();
  }

  const featuredItem = data.items[0] ?? null;
  const featuredIsText = featuredItem?.postFormat === 'text';
  const featuredResourceKinds = featuredItem ? getItemResourceKinds(featuredItem) : [];
  const profilePath = buildCreatorProfilePath(data.profile.username);
  const portfolioStats = [
    { label: 'Creations', value: data.stats.publicCreations, icon: Film, tone: 'text-violet-200' },
    { label: 'Unlocks', value: data.stats.unlocks, icon: ShoppingBag, tone: 'text-emerald-200' },
    { label: 'Saves', value: data.stats.totalSaves, icon: Heart, tone: 'text-rose-200' },
    { label: 'Remixes', value: data.stats.totalRemixes, icon: Wand2, tone: 'text-sky-200' },
    { label: 'Tools', value: data.stats.toolsUsed.length, icon: Layers3, tone: 'text-amber-200' },
  ];

  return (
    <div className="min-h-screen bg-black py-6 text-white sm:py-10">
      <div className="studio-shell">
        <section className="overflow-hidden rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(24,24,29,0.96),rgba(8,8,11,0.96))] shadow-[0_30px_100px_-70px_rgba(168,85,247,0.8)]">
          <div className="relative h-40 w-full bg-zinc-900 sm:h-52">
            {data.profile.coverUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={data.profile.coverUrl}
                alt={`${data.profile.displayName} cover`}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="h-full w-full bg-[radial-gradient(circle_at_20%_15%,rgba(56,189,248,0.2),transparent_34%),radial-gradient(circle_at_78%_25%,rgba(168,85,247,0.22),transparent_36%),linear-gradient(135deg,rgba(24,24,27,1),rgba(9,9,11,1))]" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent" />
          </div>

          <div className="relative px-5 pb-6 pt-0 sm:px-8 sm:pb-8">
            <div className="-mt-12 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
                {data.profile.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={data.profile.avatarUrl}
                    alt={`${data.profile.displayName} avatar`}
                    className="h-24 w-24 rounded-[24px] border-4 border-zinc-950 bg-zinc-900 object-cover shadow-2xl sm:h-28 sm:w-28"
                  />
                ) : (
                  <div className="flex h-24 w-24 items-center justify-center rounded-[24px] border-4 border-zinc-950 bg-zinc-800 text-3xl font-semibold text-zinc-100 shadow-2xl sm:h-28 sm:w-28">
                    {data.profile.displayName[0]?.toUpperCase() ?? 'C'}
                  </div>
                )}

                <div className="max-w-3xl">
                  <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-semibold text-zinc-300">
                    <Film className="h-3.5 w-3.5 text-violet-200" />
                    Creator portfolio
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <h1 className="text-3xl font-bold text-white sm:text-5xl">
                      {data.profile.displayName}
                    </h1>
                    {data.stats.totalSaves > 10 ? (
                      <span className="rounded-full border border-violet-400/20 bg-violet-500/10 px-3 py-1 text-xs font-semibold text-violet-100">
                        Portfolio highlight
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-zinc-400">
                    <span className="font-medium text-violet-200">@{data.profile.username}</span>
                    {data.profile.location ? (
                      <>
                        <span aria-hidden="true">/</span>
                        <span className="flex items-center gap-1.5">
                          <MapPin className="h-3.5 w-3.5" />
                          {data.profile.location}
                        </span>
                      </>
                    ) : null}
                  </div>
                  <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300">
                    {data.profile.bio || 'A public collection of creator-ready experiments, references, prompts, and showcase work.'}
                  </p>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {data.profile.websiteUrl ? (
                      <a href={data.profile.websiteUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-white/20 hover:text-white">
                        <Globe className="h-3.5 w-3.5" />
                        Website
                      </a>
                    ) : null}
                    {data.profile.twitterHandle ? (
                      <a href={`https://twitter.com/${data.profile.twitterHandle}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-white/20 hover:text-white">
                        <Twitter className="h-3.5 w-3.5" />
                        Twitter
                      </a>
                    ) : null}
                    {data.profile.instagramHandle ? (
                      <a href={`https://instagram.com/${data.profile.instagramHandle}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-white/20 hover:text-white">
                        <Instagram className="h-3.5 w-3.5" />
                        Instagram
                      </a>
                    ) : null}
                    {data.profile.tiktokHandle ? (
                      <a href={`https://tiktok.com/@${data.profile.tiktokHandle}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-white/20 hover:text-white">
                        TikTok
                      </a>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 lg:justify-end">
                <Link
                  href="#creator-collection"
                  className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
                >
                  View collection
                  <ArrowRight className="h-4 w-4" />
                </Link>
                {data.stats.unlocks > 0 ? (
                  <Link
                    href="#creator-unlocks"
                    className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-5 py-2.5 text-sm font-semibold text-emerald-100 transition hover:border-emerald-300/40 hover:bg-emerald-500/15"
                  >
                    <ShoppingBag className="h-4 w-4" />
                    Shop unlocks
                  </Link>
                ) : null}
                <ProfileActions profile={{
                  id: data.profile.id,
                  username: data.profile.username ?? '',
                  displayName: data.profile.displayName ?? '',
                  bio: data.profile.bio ?? '',
                  avatarUrl: data.profile.avatarUrl ?? '',
                  coverUrl: data.profile.coverUrl ?? '',
                  websiteUrl: data.profile.websiteUrl ?? '',
                  twitterHandle: data.profile.twitterHandle ?? '',
                  instagramHandle: data.profile.instagramHandle ?? '',
                  tiktokHandle: data.profile.tiktokHandle ?? '',
                  location: data.profile.location ?? '',
                  credits: null,
                }} />
              </div>
            </div>

            <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {portfolioStats.map(({ label, value, icon: Icon, tone }) => (
                <div key={label} className="rounded-2xl border border-white/8 bg-black/30 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-zinc-500">{label}</span>
                    <Icon className={`h-4 w-4 ${tone}`} />
                  </div>
                  <div className="mt-2 text-xl font-semibold text-white">{value.toLocaleString()}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {featuredItem ? (
          <Link
            href={buildShowcaseDetailPath(featuredItem.id, {
              from: 'creator',
              returnTo: profilePath,
            })}
            className={`group mt-6 grid overflow-hidden rounded-[30px] border border-white/8 bg-zinc-950/80 shadow-[0_26px_90px_-70px_rgba(56,189,248,0.55)] transition hover:border-violet-300/25 ${
              featuredIsText ? 'lg:grid-cols-[minmax(0,0.9fr)_minmax(320px,1fr)]' : 'lg:grid-cols-[minmax(0,1.08fr)_minmax(320px,0.92fr)]'
            }`}
          >
            <div className={`relative overflow-hidden bg-black ${featuredIsText ? 'p-4 pt-12 sm:p-6 sm:pt-14' : 'min-h-[320px] sm:min-h-[420px]'}`}>
              <FeaturedPreview item={featuredItem} />
              <div className="absolute left-4 top-4 rounded-full border border-black/30 bg-black/60 px-3 py-1 text-xs font-semibold text-white backdrop-blur">
                Featured creation
              </div>
            </div>

            <div className="flex flex-col justify-between p-5 sm:p-7">
              <div>
                <div className="text-xs font-semibold text-zinc-500">Newest portfolio piece</div>
                <h2 className="mt-3 text-2xl font-semibold text-white sm:text-3xl">
                  {featuredItem.title}
                </h2>
                <p className="mt-4 line-clamp-5 text-sm leading-7 text-zinc-300">
                  {getItemSummary(featuredItem)}
                </p>

                <div className="mt-5 flex flex-wrap gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-200">
                    {getCategoryLabel(featuredItem.category)}
                  </span>
                  {getItemSourceLabel(featuredItem) ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-300/15 bg-sky-400/10 px-3 py-1 text-xs font-medium text-sky-100">
                      Made with {getItemSourceLabel(featuredItem)}
                    </span>
                  ) : null}
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-300">
                    <CalendarDays className="h-3.5 w-3.5" />
                    {formatPortfolioDate(featuredItem.createdAt)}
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-300">
                    <Heart className="h-3.5 w-3.5 text-rose-200" />
                    {featuredItem.saveCount} saves
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-300">
                    <Wand2 className="h-3.5 w-3.5 text-sky-200" />
                    {featuredItem.remixCount} remixes
                  </span>
                  {featuredItem.asset ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-100">
                      <ShoppingBag className="h-3.5 w-3.5" />
                      {getAssetAccessLabel(featuredItem.asset)}
                    </span>
                  ) : null}
                </div>

                {featuredResourceKinds.length > 0 ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {featuredResourceKinds.map((kind) => (
                      <span key={kind} className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1 text-xs font-medium text-zinc-300">
                        {getPostResourceKindLabel(kind)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="mt-8 inline-flex items-center gap-2 text-sm font-semibold text-white">
                Open portfolio piece
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
              </div>
            </div>
          </Link>
        ) : (
          <section className="mt-6 rounded-[30px] border border-white/8 bg-zinc-950/70 p-8 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-300">
              <Film className="h-5 w-5" />
            </div>
            <h2 className="mt-4 text-xl font-semibold text-white">Portfolio collection coming soon</h2>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-zinc-400">
              Public creations, tips, and unlock-backed posts will collect here when this creator publishes them.
            </p>
          </section>
        )}

        <CreatorContentTabs
          items={data.items}
          tools={data.stats.toolsUsed}
          profilePath={profilePath}
          pageInfo={data.pageInfo}
        />
      </div>
    </div>
  );
}
