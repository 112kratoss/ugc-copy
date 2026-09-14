import { useQuery } from '@tanstack/react-query';
import { FileText, ImageIcon } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native';

import { FeedMediaFrame } from '@/components/feed-media-frame';
import { MediaLightbox, type LightboxMediaItem } from '@/components/media-lightbox';
import { SecondaryButton } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { generationReferences } from '@/lib/generation-references';
import { appTheme } from '@/lib/theme';

/** Full owner data is fetched only on the details slide, never for every grid tile. */
export function GenerationReferences({ generationId }: { generationId: string }) {
  const { api, user } = useAuth();
  const query = useQuery({
    queryKey: ['owner-generation-details', user?.id, generationId],
    enabled: Boolean(user),
    queryFn: async () => {
      const generation = await api.getGenerationDetails(generationId);
      if (!generation) throw new Error('This creation is no longer available.');
      return generation;
    },
    staleTime: 60_000,
  });
  const [failedUrls, setFailedUrls] = useState<Record<string, string>>({});
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ items: LightboxMediaItem[]; index: number } | null>(null);
  const requestSequence = useRef(0);
  useEffect(() => () => { requestSequence.current++; }, []);

  const references = generationReferences(query.data?.input_media);
  if (!user) return null;
  if (query.data && !references.length && !query.isError) return null;

  const closePreview = () => {
    requestSequence.current++;
    setPreview(null);
    setOpeningId(null);
    setOpenError(null);
  };

  const openReference = async (id: string) => {
    const sequence = ++requestSequence.current;
    setOpeningId(id);
    setOpenError(null);
    try {
      // Re-authorize on every explicit open, including retries after signed URLs expire.
      const result = await query.refetch({ throwOnError: true });
      if (sequence !== requestSequence.current) return;
      const fresh = generationReferences(result.data?.input_media);
      const selected = fresh.find((item) => item.id === id);
      if (!selected?.url) throw new Error('This reference file is unavailable.');
      setFailedUrls((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      if (selected.mediaKind === 'audio') {
        await Linking.openURL(selected.url);
      } else {
        const items = fresh.flatMap<LightboxMediaItem>((item) => item.url && item.mediaKind !== 'audio'
          ? [{ ...item, url: item.url, mediaKind: item.mediaKind }]
          : []);
        setPreview({ items, index: items.findIndex((item) => item.id === id) });
      }
    } catch (error) {
      if (sequence === requestSequence.current) {
        setOpenError(error instanceof Error ? error.message : 'Could not open this reference. Try again.');
      }
    } finally {
      if (sequence === requestSequence.current) setOpeningId(null);
    }
  };

  return (
    <View testID="generation-references" style={{ gap: appTheme.spacing.gap }}>
      <Text style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800' }}>References</Text>
      {!query.data && !query.isError ? (
        <View accessibilityLabel="Loading references" style={{ minHeight: 48, justifyContent: 'center' }}>
          <ActivityIndicator color={appTheme.colors.primary} />
        </View>
      ) : null}
      {query.isError ? (
        <View style={{ gap: appTheme.spacing.compact }}>
          <Text accessibilityRole="alert" style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>Could not load references. Try again.</Text>
          <SecondaryButton label="Retry references" onPress={() => void query.refetch()} />
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: appTheme.spacing.gap }}>
        {references.map((item) => {
          const failed = !item.url || failedUrls[item.id] === item.url;
          return (
            <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Open reference ${item.label}`}
              disabled={openingId !== null} onPress={() => void openReference(item.id)}
              style={({ pressed }) => ({ width: 144, borderRadius: appTheme.radii.md, borderCurve: 'continuous',
                overflow: 'hidden', backgroundColor: appTheme.colors.surfaceStrong, opacity: pressed ? appTheme.opacity.pressed : 1 })}>
              <View style={{ height: 160, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.surfaceInset }}>
                {openingId === item.id ? <ActivityIndicator color={appTheme.colors.primary} />
                  : item.mediaKind === 'image' && item.url && !failed ? (
                    <FeedMediaFrame kind="image" url={item.url} cacheKey={`generation-reference:${generationId}:${item.id}`}
                      imageContentFit="contain" style={{ width: '100%', height: '100%' }}
                      onImageError={() => setFailedUrls((current) => ({ ...current, [item.id]: item.url! }))} />
                  ) : item.mediaKind === 'image' ? <ImageIcon size={32} color={appTheme.colors.muted} />
                    : <FileText size={32} color={appTheme.colors.muted} />}
              </View>
              <View style={{ padding: appTheme.spacing.gap, gap: 4 }}>
                <Text numberOfLines={2} style={{ color: appTheme.colors.text, ...appTheme.type.label }}>{item.label}</Text>
                <Text style={{ color: appTheme.colors.muted, ...appTheme.type.caption }}>{failed ? 'Unavailable · Tap to retry' : item.caption}</Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
      {openError ? <Text accessibilityRole="alert" style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>{openError}</Text> : null}
      <MediaLightbox items={preview?.items ?? []} activeIndex={preview?.index ?? null} onClose={closePreview}
        onNavigate={(index) => { const item = preview?.items[index]; if (item) void openReference(item.id); }}
        statusMessage={openingId ? 'Opening reference…' : null} errorMessage={openError} />
    </View>
  );
}
