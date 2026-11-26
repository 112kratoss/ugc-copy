'use client';

import { ArrowRight, Lightbulb, Map as MapIcon, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button, StatusCallout, Surface, Text } from '@/components/DesignSystem';
import SkeletonLoader from '@/components/SkeletonLoader';

import {
  SUPPORT_HUB_WORDS,
  groupSupportRoadmapItems,
  supportHubReactionPeople,
  supportRoadmapVoteWords,
  type SupportRoadmapItem,
} from '../../../ugc-mobile/lib/support-hub-policy/support-hub-policy';

import SupportHubReactions from './SupportHubReactions';
import { fetchSupportRoadmap, supportHubSignInHref, useSupportHubReaction } from './support-hub-client';

type RoadmapState =
  | { status: 'loading' }
  | { status: 'failed' }
  /** `readAt`: when the list came, the moment "Shipped recently" is counted from. */
  | { status: 'ready'; items: SupportRoadmapItem[]; readAt: number };

const SIGN_IN_HREF = supportHubSignInHref('roadmap');

function RoadmapSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the roadmap…</span>
      <SkeletonLoader className="h-6 w-32" />
      {Array.from({ length: 3 }, (_, index) => (
        <Surface key={index} variant="card" padding="md" className="space-y-3">
          <SkeletonLoader className="h-6 w-1/2" />
          <SkeletonLoader className="h-4 w-3/4" />
        </Surface>
      ))}
    </div>
  );
}

function SuggestFeatureButton({ onPress }: { onPress: () => void }) {
  return (
    <Button variant="secondary" icon={Lightbulb} iconPosition="start" onClick={onPress}>
      {SUPPORT_HUB_WORDS.suggestFeature}
    </Button>
  );
}

function RoadmapItemCard({
  item,
  canReact,
  busy,
  onReact,
}: {
  item: SupportRoadmapItem;
  canReact: boolean;
  busy: boolean;
  onReact: (item: SupportRoadmapItem, emoji: SupportRoadmapItem['myReaction']) => void;
}) {
  return (
    <article className="rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-5 sm:p-6">
      <Text as="h3" variant="cardTitle">{item.title}</Text>
      {item.summary ? <Text variant="bodySm" className="mt-1.5">{item.summary}</Text> : null}
      <div className="mt-4">
        <SupportHubReactions
          subject={item.title}
          reactions={item.reactions}
          myReaction={item.myReaction}
          canReact={canReact}
          signInHref={SIGN_IN_HREF}
          busy={busy}
          onReact={(emoji) => onReact(item, emoji)}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {/* The number of people who reacted is the item's vote. */}
        <Text variant="caption">{supportRoadmapVoteWords(supportHubReactionPeople(item.reactions))}</Text>
        {item.status === 'shipped' && item.shippedUpdateId ? (
          <Link
            href={`/showcase/${encodeURIComponent(item.shippedUpdateId)}`}
            prefetch={false}
            className="ui-focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-sm font-bold text-[var(--ui-primary)] transition-colors hover:bg-[var(--ui-primary-soft)]"
          >
            {SUPPORT_HUB_WORDS.readUpdate}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        ) : null}
      </div>
    </article>
  );
}

/**
 * Help & Support's Roadmap (owner, 2026-11-26): what is being built, short and
 * without dates, in three groups (Building, Exploring and Shipped recently,
 * `groupSupportRoadmapItems`). People react to an item, one reaction each, and
 * the number of people is its vote; a shipped item links the update that
 * announced it. "Suggest a feature" opens the chat with the composer started.
 */
export default function SupportRoadmapPanel({
  accessToken,
  canReact,
  onSuggestFeature,
}: {
  accessToken: string | null;
  /** A registered account: reactions are its own. */
  canReact: boolean;
  onSuggestFeature: () => void;
}) {
  const tokenRef = useRef(accessToken);
  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);
  const getAccessToken = useCallback(() => tokenRef.current, []);

  const [state, setState] = useState<RoadmapState>({ status: 'loading' });
  // Each Try again reads the list anew.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchSupportRoadmap({ accessToken: tokenRef.current, signal: controller.signal })
      .then((roadmap) => setState({ status: 'ready', items: roadmap.items, readAt: Date.now() }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'failed' });
      });
    return () => controller.abort();
  }, [attempt]);

  const groups = useMemo(
    () => (state.status === 'ready' ? groupSupportRoadmapItems(state.items, state.readAt) : []),
    [state],
  );

  const patch = useCallback((id: string, change: Pick<SupportRoadmapItem, 'reactions' | 'myReaction'>) => {
    setState((current) => (current.status === 'ready'
      ? { ...current, items: current.items.map((item) => (item.id === id ? { ...item, ...change } : item)) }
      : current));
  }, []);
  const { react, pending } = useSupportHubReaction({ kind: 'roadmap', getAccessToken, patch });

  const retry = () => {
    setState({ status: 'loading' });
    setAttempt((current) => current + 1);
  };

  return (
    <div>
      <Text variant="bodySm" className="mb-5 max-w-xl sm:text-base">{SUPPORT_HUB_WORDS.roadmapIntro}</Text>

      {state.status === 'loading' ? (
        <RoadmapSkeleton />
      ) : state.status === 'failed' ? (
        <div>
          <StatusCallout tone="danger" icon={RefreshCw} title={SUPPORT_HUB_WORDS.roadmapLoadFailed} />
          <button type="button" onClick={retry} className="ui-button ui-button-primary ui-focus-ring mt-5">
            <RefreshCw className="h-4 w-4" aria-hidden />
            {SUPPORT_HUB_WORDS.tryAgain}
          </button>
        </div>
      ) : groups.length === 0 ? (
        <Surface variant="soft" padding="lg" className="text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] text-[var(--ui-text-secondary)]">
            <MapIcon className="h-5 w-5" aria-hidden />
          </span>
          <Text as="h2" variant="cardTitle" className="mt-4">{SUPPORT_HUB_WORDS.roadmapEmptyTitle}</Text>
          <Text variant="bodySm" className="mx-auto mt-2 max-w-lg">{SUPPORT_HUB_WORDS.roadmapEmptyBody}</Text>
          <div className="mt-5 flex justify-center">
            <SuggestFeatureButton onPress={onSuggestFeature} />
          </div>
        </Surface>
      ) : (
        <>
          <div className="flex flex-col gap-8">
            {groups.map((group) => (
              <section key={group.status} aria-labelledby={`support-roadmap-${group.status}`}>
                <Text as="h2" variant="label" id={`support-roadmap-${group.status}`} className="mb-3">
                  {SUPPORT_HUB_WORDS.roadmapGroups[group.status]}
                </Text>
                <ul className="flex flex-col gap-3">
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <RoadmapItemCard
                        item={item}
                        canReact={canReact}
                        busy={pending.has(item.id)}
                        onReact={(target, emoji) => void react(target, emoji)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <Surface variant="soft" padding="md" className="mt-8 flex flex-wrap items-center justify-between gap-3">
            <Text variant="bodySm">{SUPPORT_HUB_WORDS.suggestFeatureLine}</Text>
            <SuggestFeatureButton onPress={onSuggestFeature} />
          </Surface>
        </>
      )}
    </div>
  );
}
