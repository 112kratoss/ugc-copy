import { useQuery } from '@tanstack/react-query';
import { FileText, ImageIcon } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native';

import { FeedMediaFrame } from '@/components/feed-media-frame';
import { MediaLightbox, type LightboxMediaItem } from '@/components/media-lightbox';
import { PagerRowScrollView } from '@/components/pager-row-scroll-view';
import { SecondaryButton } from '@/components/ui';
import { VideoPlayMark } from '@/components/video-play-mark';
import { VideoStill } from '@/components/video-still';
import { useAuth } from '@/lib/auth';
import { getGenerationKind, getGenerationRenderableMediaKind } from '@/lib/generation-media';
import { generationReferences } from '@/lib/generation-references';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import { useVideoStills } from '@/lib/use-video-stills';

/**
 * Full owner data is fetched only on the details slide, never for every grid
 * tile. The references and the outputs read the one record.
 */
function useOwnerGenerationDetails(generationId: string) {
  const { api, user } = useAuth();
  return useQuery({
    queryKey: ['owner-generation-details', user?.id, generationId],
    enabled: Boolean(user),
    queryFn: async () => {
      const generation = await api.getGenerationDetails(generationId);
      if (!generation) throw new Error('This creation is no longer available.');
      return generation;
    },
    staleTime: 60_000,
  });
}

export function GenerationReferences({ generationId }: { generationId: string }) {
  const theme = useAppTheme();
  const { user } = useAuth();
  const query = useOwnerGenerationDetails(generationId);
  const [failedUrls, setFailedUrls] = useState<Record<string, string>>({});
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ items: LightboxMediaItem[]; index: number } | null>(null);
  const requestSequence = useRef(0);
  useEffect(() => () => { requestSequence.current++; }, []);

  const inputMedia = query.data?.input_media;
  const references = useMemo(() => generationReferences(inputMedia), [inputMedia]);
  // An input clip's still, by its file where the record names one: a recipe that lists the creation's saved inputs
  // as they are names the same file on the same page, and draws the same still.
  const clips = useMemo(() => references.flatMap((item) => (
    item.mediaKind === 'video' ? [{ key: stillKey(generationId, item), url: item.url }] : []
  )), [generationId, references]);
  const { stills, readAgain } = useVideoStills(clips);
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
      // A clip that gave no still is read again from the link just renewed.
      if (selected.mediaKind === 'video') readAgain(stillKey(generationId, selected));
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
      <Text style={{ color: theme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800' }}>References</Text>
      {!query.data && !query.isError ? (
        <View accessibilityLabel="Loading references" style={{ minHeight: 48, justifyContent: 'center' }}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      ) : null}
      {query.isError ? (
        <View style={{ gap: appTheme.spacing.compact }}>
          <Text accessibilityRole="alert" style={{ color: theme.colors.muted, ...appTheme.type.bodySm }}>Could not load references. Try again.</Text>
          <SecondaryButton label="Retry references" onPress={() => void query.refetch()} />
        </View>
      ) : null}
      <PagerRowScrollView keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: appTheme.spacing.gap }}>
        {references.map((item) => {
          const failed = !item.url || failedUrls[item.id] === item.url;
          // Not for a clip the record no longer links: its card says it is unavailable.
          const still = item.url ? stills[stillKey(generationId, item)] : null;
          return (
            <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Open reference ${item.label}`}
              disabled={openingId !== null} onPress={() => void openReference(item.id)}
              style={({ pressed }) => ({ width: 144, borderRadius: appTheme.radii.md, borderCurve: 'continuous',
                overflow: 'hidden', backgroundColor: theme.colors.surfaceStrong, opacity: pressed ? appTheme.opacity.pressed : 1 })}>
              <View style={{ height: 160, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceInset }}>
                {openingId === item.id ? <ActivityIndicator color={theme.colors.primary} />
                  : item.mediaKind === 'image' && item.url && !failed ? (
                    <FeedMediaFrame kind="image" url={item.url} cacheKey={`generation-reference:${generationId}:${item.id}`}
                      imageContentFit="contain" style={{ width: '100%', height: '100%' }}
                      onImageError={() => setFailedUrls((current) => ({ ...current, [item.id]: item.url! }))} />
                  ) : item.mediaKind === 'image' ? <ImageIcon size={32} color={theme.colors.muted} />
                    // A clip reads as one: its still under a play mark, or the mark alone, where a document icon read as a file.
                    : item.mediaKind === 'video' ? (
                      <>
                        {still ? <VideoStill still={still} /> : null}
                        <VideoPlayMark onPicture={Boolean(still)} />
                      </>
                    )
                    : <FileText size={32} color={theme.colors.muted} />}
              </View>
              <View style={{ padding: appTheme.spacing.gap, gap: 4 }}>
                <Text numberOfLines={2} style={{ color: theme.colors.text, ...appTheme.type.label }}>{item.label}</Text>
                <Text style={{ color: theme.colors.muted, ...appTheme.type.caption }}>{failed ? 'Unavailable · Tap to retry' : item.caption}</Text>
              </View>
            </Pressable>
          );
        })}
      </PagerRowScrollView>
      {openError ? <Text accessibilityRole="alert" style={{ color: theme.colors.muted, ...appTheme.type.bodySm }}>{openError}</Text> : null}
      <MediaLightbox items={preview?.items ?? []} activeIndex={preview?.index ?? null} onClose={closePreview}
        onNavigate={(index) => { const item = preview?.items[index]; if (item) void openReference(item.id); }}
        statusMessage={openingId ? 'Opening reference…' : null} errorMessage={openError} />
    </View>
  );
}

const OUTPUT_CARD_WIDTH = 144;
const OUTPUT_MEDIA_HEIGHT = 160;

/**
 * Every file a run made. The library is read with `detail=summary`, which
 * sends the first output only, so the rest of a run of several were out of
 * reach in the app; the full record carries them all (`output_urls`). `count`
 * is the list's `output_count`, which holds the row's place while the record
 * loads.
 */
export function GenerationOutputs({ count, generationId }: { count: number; generationId: string }) {
  const theme = useAppTheme();
  const { user } = useAuth();
  const query = useOwnerGenerationDetails(generationId);
  // The thumbnail address that failed, by output, so a renewed one tries again.
  const [failedUrls, setFailedUrls] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<{ items: LightboxMediaItem[]; index: number } | null>(null);

  const record = query.data;
  const urls = record?.output_urls ?? [];
  const mediaKind = record ? getGenerationRenderableMediaKind(getGenerationKind(record)) : null;
  // The poster is the primary output's, which is the first in every run the
  // server saves now and was not always in older ones.
  const primaryIndex = Math.max(0, urls.indexOf(record?.media?.url ?? record?.output_url ?? ''));
  const poster = record?.media?.previewUrl ?? record?.previewUrl ?? record?.preview_url ?? null;
  // A video is drawn by its poster, or by a still read from its file where it has none or its poster failed: its file
  // is not a picture.
  const thumbnailUrl = (url: string, index: number) => (
    index === primaryIndex && poster ? poster : mediaKind === 'image' ? url : null
  );
  const posterFailed = Boolean(poster) && failedUrls[primaryIndex] === poster;
  // Nothing is read for a row that is not drawn (below).
  const drawn = Boolean(user) && mediaKind === 'video' && urls.length >= 2;
  const clips = useMemo(() => (drawn
    ? urls.flatMap((url, index) => (index === primaryIndex && poster && !posterFailed ? [] : [{ key: outputStillKey(generationId, index), url }]))
    : []), [drawn, generationId, poster, posterFailed, primaryIndex, urls]);
  const { stills, readAgain } = useVideoStills(clips);
  if (!user) return null;
  // Sound and words have no place on the lightbox, and a single file is the slide itself.
  if (record && (!mediaKind || urls.length < 2)) return null;

  const rereadOutputUrl = async (index: number) => {
    const result = await query.refetch({ throwOnError: true });
    const url = result.data?.output_urls?.[index];
    if (!url) throw new Error('This output is unavailable.');
    return url;
  };

  const openOutput = (index: number) => {
    if (!mediaKind) return;
    setFailedUrls((current) => {
      const next = { ...current };
      delete next[index];
      return next;
    });
    // A clip that gave no still is read again, as a picture that failed is loaded again.
    readAgain(outputStillKey(generationId, index));
    setPreview({
      index,
      items: urls.map((url, position) => ({
        // Keyed by run: the lightbox caches each picture under its id.
        id: `${generationId}:output:${position}`,
        url,
        mediaKind,
        label: `Output ${position + 1}`,
        caption: position === primaryIndex ? 'Main output' : null,
        resolveRetryUrl: () => rereadOutputUrl(position),
      })),
    });
  };

  return (
    <View testID="generation-outputs" style={{ gap: appTheme.spacing.gap }}>
      <Text style={{ color: theme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800' }}>Outputs</Text>
      {!record && query.isError ? (
        <View style={{ gap: appTheme.spacing.compact }}>
          <Text accessibilityRole="alert" style={{ color: theme.colors.muted, ...appTheme.type.bodySm }}>Could not load outputs. Try again.</Text>
          <SecondaryButton label="Retry outputs" onPress={() => void query.refetch()} />
        </View>
      ) : (
        <PagerRowScrollView keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: appTheme.spacing.gap }}>
          {record ? urls.map((url, index) => {
            const thumbnail = thumbnailUrl(url, index);
            const failed = Boolean(thumbnail) && failedUrls[index] === thumbnail;
            const still = thumbnail && !failed ? null : stills[outputStillKey(generationId, index)];
            return (
              <OutputCard key={index} accessibilityLabel={`Open output ${index + 1} of ${urls.length}`}
                label={`Output ${index + 1}`}
                // A video whose poster failed still plays; only a picture is lost with its file.
                caption={failed && mediaKind === 'image' ? 'Unavailable · Tap to retry'
                  : index === primaryIndex ? 'Main output' : mediaKind === 'video' ? 'Video' : 'Image'}
                onPress={() => openOutput(index)}>
                {thumbnail && !failed ? (
                  <FeedMediaFrame kind="image" url={thumbnail} cacheKey={`generation-output:${generationId}:${index}`}
                    imageContentFit="cover" style={{ position: 'absolute', inset: 0 }}
                    onImageError={() => setFailedUrls((current) => ({ ...current, [index]: thumbnail }))} />
                ) : still ? <VideoStill still={still} />
                  : mediaKind === 'image' ? <ImageIcon size={appTheme.icon.hero} color={theme.colors.muted} /> : null}
                {mediaKind === 'video' ? <VideoPlayMark onPicture={Boolean((thumbnail && !failed) || still)} /> : null}
              </OutputCard>
            );
          }) : Array.from({ length: count }, (_, index) => (
            <OutputCard key={index} accessibilityLabel={`Output ${index + 1} of ${count}, loading`}
              label={`Output ${index + 1}`} caption="Loading…">
              <ActivityIndicator color={theme.colors.primary} />
            </OutputCard>
          ))}
        </PagerRowScrollView>
      )}
      <MediaLightbox items={preview?.items ?? []} activeIndex={preview?.index ?? null} onClose={() => setPreview(null)}
        onNavigate={(index) => setPreview((current) => (current ? { ...current, index } : current))} />
    </View>
  );
}

function OutputCard({ accessibilityLabel, caption, children, label, onPress }: {
  accessibilityLabel: string;
  caption: string;
  children: ReactNode;
  label: string;
  /** Absent while the record loads: the card holds its place and opens nothing. */
  onPress?: () => void;
}) {
  const theme = useAppTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ busy: !onPress }}
      disabled={!onPress} onPress={onPress}
      style={({ pressed }) => ({ width: OUTPUT_CARD_WIDTH, borderRadius: appTheme.radii.md, borderCurve: 'continuous',
        overflow: 'hidden', backgroundColor: theme.colors.surfaceStrong, opacity: pressed ? appTheme.opacity.pressed : 1 })}>
      <View style={{ height: OUTPUT_MEDIA_HEIGHT, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceInset }}>
        {children}
      </View>
      <View style={{ padding: appTheme.spacing.gap, gap: 4 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.text, ...appTheme.type.label }}>{label}</Text>
        <Text numberOfLines={1} style={{ color: theme.colors.muted, ...appTheme.type.caption }}>{caption}</Text>
      </View>
    </Pressable>
  );
}

/** A creation input's still, by its file where the record names one, so the recipe's row can draw it too. */
function stillKey(generationId: string, item: { id: string; storagePath: string | null }) {
  return item.storagePath ?? `generation-input:${generationId}:${item.id}`;
}

/** An output's still, by its place in its run: an output's link is signed anew with each read of the record. */
function outputStillKey(generationId: string, index: number) {
  return `generation-output:${generationId}:${index}`;
}
