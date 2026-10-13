import { useEffect, useState } from 'react';
import { AppState, Linking, Platform, View } from 'react-native';
import { AppText, Pill, PrimaryButton, SecondaryButton } from '@/components/ui';
import { ShowcaseMediaPreview } from '@/components/showcase-media-preview';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
import { canRevealNsfwInApp } from '@/lib/nsfw-reveal-policy';
import { useAppTheme } from '@/lib/theme-context';
import type { ShowcaseFeedItem } from '@/lib/types';

/**
 * The body of a post its creator marked NSFW, drawn where the post's own text
 * would be. The page around it — the byline, the ⋮ with Report and Block, save
 * and share — stays: the posts most likely to be reported keep the way to
 * report them. Originals live only in this disclosure, never in a persisted
 * feed query.
 */
export function NsfwPostNotice({
  postId,
  width,
  onRevealedChange,
}: {
  postId: string;
  /** The column the notice is drawn in; revealed media fills it. */
  width: number;
  /**
   * Told each time the original appears or goes again (a reveal, Hide, the
   * ten-minute expiry, the app leaving the foreground), so the page can keep
   * the post's thread covered while the post is.
   */
  onRevealedChange?: (revealed: boolean) => void;
}) {
  const { api, user } = useAuth();
  const theme = useAppTheme();
  const [item, setItem] = useState<ShowcaseFeedItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revealAllowed = canRevealNsfwInApp(Platform.OS);
  const revealed = item !== null;
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
  useEffect(() => { onRevealedChange?.(revealed); }, [onRevealedChange, revealed]);
  async function reveal() {
    if (!revealAllowed) return;
    setLoading(true); setError(null);
    try {
      const response = await api.revealNsfwPost(postId);
      if (!response.item?.nsfwRevealed) throw new Error('This post is unavailable.');
      if (AppState.currentState === 'active') setItem(response.item);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not reveal this post. Please retry.'); }
    finally { setLoading(false); }
  }
  const mediaWidth = Math.max(1, width);
  return <View style={{ gap: 16 }}>
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
    </> : !revealAllowed ? <>
      <AppText variant="body">The creator marked this post NSFW. Mature posts stay covered in this app.</AppText>
    </> : <>
      <AppText variant="body">The creator marked this post NSFW. Its media and text stay hidden until you choose to reveal them.</AppText>
      <AppText variant="body" color="muted">Mature content is off by default. Adults can enable it on the Magicbooklet website, then return here to reveal individual posts.</AppText>
      <PrimaryButton label="Reveal post" loading={loading} loadingLabel="Loading…" onPress={() => void reveal()} />
      <SecondaryButton label="Manage on website" onPress={() => void Linking.openURL(`${env.siteUrl}/showcase/${encodeURIComponent(postId)}`)} />
    </>}
    {error ? <AppText variant="body" accessibilityRole="alert">{error}</AppText> : null}
  </View>;
}
