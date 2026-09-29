import { useEffect, useState } from 'react';
import { AppState, Linking, ScrollView, View, useWindowDimensions } from 'react-native';
import { AppText, Pill, PrimaryButton, SecondaryButton } from '@/components/ui';
import { ShowcaseMediaPreview } from '@/components/showcase-media-preview';
import { useAuth } from '@/lib/auth';
import { useAppTheme } from '@/lib/theme-context';
import type { ShowcaseFeedItem } from '@/lib/types';

/** Originals live only in this disclosure, never in a persisted feed query. */
export function NsfwPostNotice({ postId }: { postId: string }) {
  const { api, user } = useAuth();
  const theme = useAppTheme();
  const { width } = useWindowDimensions();
  const [item, setItem] = useState<ShowcaseFeedItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => { if (state !== 'active') setItem(null); });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!item) return;
    const timeout = setTimeout(() => setItem(null), 10 * 60 * 1000);
    return () => clearTimeout(timeout);
  }, [item]);
  useEffect(() => { setItem(null); }, [postId, user?.id]);
  async function reveal() {
    setLoading(true); setError(null);
    try {
      const response = await api.revealNsfwPost(postId);
      if (!response.item?.nsfwRevealed) throw new Error('This post is unavailable.');
      if (AppState.currentState === 'active') setItem(response.item);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not reveal this post. Please retry.'); }
    finally { setLoading(false); }
  }
  const mediaWidth = Math.max(1, width - 48);
  return <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
    <Pill label="NSFW · 18+" />
    <AppText variant="pageTitle">{item?.title ?? 'Mature content'}</AppText>
    {item ? <>
      {item.body ? <AppText variant="body">{item.body}</AppText> : null}
      {item.mediaItems?.length ? <View style={{ width: mediaWidth }}><ShowcaseMediaPreview
        accent={theme.colors.primary}
        mediaItems={item.mediaItems}
        width={mediaWidth} height={mediaWidth * 1.25} radius={16}
        recyclingKey={`revealed:${postId}`} videoActivation="visible"
      /></View> : null}
      <SecondaryButton label="Hide this post" onPress={() => setItem(null)} />
    </> : <>
      <AppText variant="body">The creator marked this post NSFW. Its media and text stay hidden until you choose to reveal them.</AppText>
      <AppText variant="body" color="muted">Mature content is off by default. Adults can enable it on the Magicbooklet website, then return here to reveal individual posts.</AppText>
      <PrimaryButton label="Reveal post" loading={loading} loadingLabel="Loading…" onPress={() => void reveal()} />
      <SecondaryButton label="Manage on website" onPress={() => void Linking.openURL(`https://magicbooklet.com/showcase/${encodeURIComponent(postId)}`)} />
    </>}
    {error ? <AppText variant="body" accessibilityRole="alert">{error}</AppText> : null}
  </ScrollView>;
}
