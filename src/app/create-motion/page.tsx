import type { StartPostsSource } from '@/components/CreatorStartPosts';
import { RequestHintedOptionalAuth, RequireAuth } from '@/components/RouteAuthBoundary';
import type { CreatorOpening } from '@/lib/creator-opening';
import {
  loadCreatorOpening,
  loadCreatorStartPostsForRequest,
  loadVisitorWelcomeCredits,
  readCreatorReturn,
  startPostsWithin,
} from '@/lib/creator-page-server';
import { loadTemplatesLive } from '@/lib/live-media-templates';

import CreateMotionClient, { type CreateMotionPrefill } from './CreateMotionClient';

type CreateMotionPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getFirstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CreateMotionPage({
  searchParams,
}: CreateMotionPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const prefill: CreateMotionPrefill = {
    remixId: getFirstValue(resolvedSearchParams.remix),
    remixPostId: getFirstValue(resolvedSearchParams.remixPost),
    prompt: getFirstValue(resolvedSearchParams.prompt),
    model: getFirstValue(resolvedSearchParams.model),
  };
  const returnParams = new URLSearchParams();
  if (prefill.remixId) returnParams.set('remix', prefill.remixId);
  if (prefill.remixPostId) returnParams.set('remixPost', prefill.remixPostId);
  if (prefill.prompt) returnParams.set('prompt', prefill.prompt);
  if (prefill.model) returnParams.set('model', prefill.model);
  const returnTo = returnParams.size > 0
    ? `/create-motion?${returnParams.toString()}`
    : '/create-motion';
  const { welcome, handoverNonce } = readCreatorReturn(resolvedSearchParams);
  // The shelf's posts, for the empty canvas (owner, 2026-10-28), read beside the rest and waited
  // for only briefly (`startPostsWithin`). A remix opens on its own post instead.
  const startPostsRead = prefill.remixId ? null : loadCreatorStartPostsForRequest();
  // Whether /templates lists anything, from the creators' shared cache: the ways into it are drawn
  // only then, so a reader is never sent to an empty catalog.
  const templatesLiveRead = loadTemplatesLive();
  const client = (
    visitorWelcomeCredits: number | null,
    opening: CreatorOpening | null,
    templatesLive: boolean,
    startPosts: StartPostsSource,
  ) => (
    <CreateMotionClient
      // A Remix from this page lands on the same route, which keeps the client: a
      // new remix starts a new one, so it loads as a remix opened anywhere else does.
      key={`${prefill.remixId ?? ''}|${prefill.remixPostId ?? ''}`}
      prefill={prefill}
      returnTo={returnTo}
      welcome={welcome}
      handoverNonce={handoverNonce}
      visitorWelcomeCredits={visitorWelcomeCredits}
      opening={opening}
      startPosts={startPosts}
      templatesLive={templatesLive}
    />
  );

  // Remixing someone's post takes an account (the remix source answers no one
  // else), so a signed-out remix signs in first and comes back to it. Everything
  // else works signed out up to Generate, which asks for an account. A remix
  // opens on its own run, which the page reads once it is in.
  if (prefill.remixId) return <RequireAuth returnTo={returnTo}>{client(null, null, await templatesLiveRead, null)}</RequireAuth>;
  const [visitorWelcomeCredits, opening, templatesLive] = await Promise.all([
    loadVisitorWelcomeCredits(),
    loadCreatorOpening('motion', prefill),
    templatesLiveRead,
  ]);
  // In by then, the posts are drawn in the page's first part; else they follow it.
  const startPosts = startPostsRead && ((await startPostsWithin(startPostsRead)) ?? startPostsRead);
  return <RequestHintedOptionalAuth>{client(visitorWelcomeCredits, opening, templatesLive, startPosts)}</RequestHintedOptionalAuth>;
}
