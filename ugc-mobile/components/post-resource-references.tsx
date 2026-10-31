import { Image } from 'expo-image';
import type { VideoThumbnail } from 'expo-video';
import { AudioLines, ExternalLink, FileText, ImageIcon, Play } from 'lucide-react-native';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';

import { FeedMediaFrame } from '@/components/feed-media-frame';
import { MatureCover, MatureMediaCovered } from '@/components/mature-cover';
import { MediaLightbox, type LightboxMediaItem } from '@/components/media-lightbox';
import { PagerRowScrollView } from '@/components/pager-row-scroll-view';
import { isRecipeMediaItem } from '@/lib/recipe-reading/recipe-reading';
import { appTheme, mediaColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type { PostResourceItem } from '@/lib/types';
import { grabVideoFrame, VIDEO_STILLS_READ } from '@/lib/video-frame';

type PostResourceReferencesProps = {
  /**
   * A mature purchase's pictures stay under the plate until the screen's own
   * Show; left out, the screen's `MatureMediaCovered` decides.
   */
  coverMedia?: boolean;
  items: PostResourceItem[] | undefined;
  /**
   * The row's heading. A card that is itself the references passes null: its
   * name already says it, and "References" under "Reference media" said it twice.
   */
  label?: string | null;
  onError?: (message: string) => void;
  onOpenUrl: (url: string) => Promise<void>;
  /** Whether the clips' stills are read now (PostResourceBundleContent says when not); stills already read stay drawn. */
  readStills?: boolean;
  resolveFileUrl: (storagePath: string) => Promise<string>;
};

export function PostResourceReferences({
  coverMedia,
  items,
  label = 'References',
  onError,
  onOpenUrl,
  readStills = true,
  resolveFileUrl,
}: PostResourceReferencesProps) {
  const theme = useAppTheme();
  const coveredByScreen = useContext(MatureMediaCovered);
  const covered = coverMedia ?? coveredByScreen;
  const referenceItems = useMemo(
    () => getReferenceResourceItems(items),
    [items]
  );
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({});
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [failedPreviewPaths, setFailedPreviewPaths] = useState<Record<string, boolean>>({});
  // A clip's still, by storage path; null when the read gave none, asked again only once opening the clip renews its link.
  const [videoFrames, setVideoFrames] = useState<Record<string, VideoThumbnail | null>>({});
  // Keyed by item, not by position: signed URLs resolve in any order, so the
  // list of viewable items can grow while the lightbox is open.
  const [lightboxKey, setLightboxKey] = useState<string | null>(null);
  const requestedPaths = useRef(new Set<string>());
  const frameRequests = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  const openRequest = useRef(0);
  const openingTarget = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    // Nothing under the plate loads, its links included: they are signed when
    // it goes, so the thumbnails draw from fresh ones.
    if (covered) return;
    const storagePaths = referenceItems
      .map((item) => item.storagePath)
      .filter((storagePath): storagePath is string => Boolean(storagePath));

    for (const storagePath of storagePaths) {
      if (requestedPaths.current.has(storagePath)) continue;

      requestedPaths.current.add(storagePath);
      setLoadingPaths((current) => ({ ...current, [storagePath]: true }));
      // Kept even when it lands while this subtree's effects are cleaned up
      // (a hidden <Activity>, Fast Refresh): the path stays requested, so the
      // re-run never asks again, and a dropped link was a spinner for good.
      // After an unmount the update does nothing.
      void resolveFileUrl(storagePath)
        .then((url) => {
          setFileUrls((current) => ({ ...current, [storagePath]: current[storagePath] ?? url }));
        })
        .catch(() => {
          requestedPaths.current.delete(storagePath);
        })
        .finally(() => {
          setLoadingPaths((current) => {
            const next = { ...current };
            delete next[storagePath];
            return next;
          });
        });
    }
  }, [covered, referenceItems, resolveFileUrl]);

  useEffect(() => {
    const requests = frameRequests.current;
    // A read still under way when the row is hidden or goes is called off,
    // and asked for again if the row comes back.
    return () => {
      for (const request of requests.values()) request.abort();
      requests.clear();
    };
  }, []);

  useEffect(() => {
    // React Native has no <video preload="metadata"> to draw a clip's first
    // frame, so each clip is asked for one still from the link it has: a still
    // read stays when opening the clip renews the link, and a read called off
    // or given none is asked again (below, and in openItem).
    if (!VIDEO_STILLS_READ) return;
    if (covered || !readStills) {
      // Nothing under the plate is read, nor while the page is off screen:
      // reads still under way are called off, and asked for again when the
      // plate lifts or the page comes back.
      for (const request of frameRequests.current.values()) request.abort();
      frameRequests.current.clear();
      return;
    }
    for (const item of referenceItems) {
      const storagePath = item.storagePath;
      const url = storagePath ? fileUrls[storagePath] : undefined;
      if (!storagePath || !url || referenceMediaKind(item) !== 'video') continue;
      if (videoFrames[storagePath] !== undefined || frameRequests.current.has(storagePath)) continue;

      const request = new AbortController();
      frameRequests.current.set(storagePath, request);
      // The request stays recorded once it lands: a run of this effect that
      // has not seen the still yet must not ask for the clip a second time.
      void grabVideoFrame(url, { signal: request.signal }).then((frame) => {
        if (!request.signal.aborted) setVideoFrames((current) => ({ ...current, [storagePath]: frame }));
      });
    }
  }, [covered, fileUrls, readStills, referenceItems, videoFrames]);

  // Everything the app can show itself: storage-backed images and videos
  // whose signed URL has arrived. External links stay links, and audio has
  // no in-app player, so both still hand off to the browser.
  const lightboxItems = useMemo<LightboxMediaItem[]>(
    () => referenceItems.flatMap((item, index) => {
      const mediaKind = referenceMediaKind(item);
      const url = item.storagePath ? fileUrls[item.storagePath] : null;
      if (!mediaKind || !url) return [];
      const storagePath = item.storagePath!;
      return [{ id: referenceKey(item, index), url, mediaKind, label: item.title, caption: item.description,
        resolveRetryUrl: () => resolveFileUrl(storagePath),
      }];
    }),
    [fileUrls, referenceItems, resolveFileUrl]
  );
  const lightboxIndex = lightboxKey ? lightboxItems.findIndex((item) => item.id === lightboxKey) : -1;

  if (!referenceItems.length) return null;

  const openItem = async (item: PostResourceItem, index: number) => {
    const target = referenceKey(item, index);
    if (openingTarget.current === target) return;
    openingTarget.current = target;
    const request = ++openRequest.current;
    const storagePath = item.storagePath;
    try {
      setOpeningPath(storagePath ?? null);
      setOpenError(null);
      // The app draws none of a covered purchase's media, so a covered picture
      // or clip opens like any other file, in the browser.
      if (storagePath && referenceMediaKind(item) && !covered) {
        // Preview links expire. An explicit open must renew access through the
        // resource endpoint instead of replaying the URL cached at mount.
        const url = await resolveFileUrl(storagePath);
        if (!mounted.current || request !== openRequest.current) return;
        setFileUrls((current) => ({ ...current, [storagePath]: url }));
        setFailedPreviewPaths((current) => ({ ...current, [storagePath]: false }));
        // A clip that gave no still, its link having run out or its read the
        // deadline, is asked again from the renewed link, as a picture is.
        if (videoFrames[storagePath] === null) {
          frameRequests.current.delete(storagePath);
          setVideoFrames((current) => {
            if (current[storagePath] !== null) return current;
            const next = { ...current };
            delete next[storagePath];
            return next;
          });
        }
        setLightboxKey(referenceKey(item, index));
        return;
      }

      if (item.externalUrl) {
        await onOpenUrl(item.externalUrl);
        return;
      }

      if (!storagePath) return;
      const url = await resolveFileUrl(storagePath);
      if (!mounted.current || request !== openRequest.current) return;
      setFileUrls((current) => ({ ...current, [storagePath]: url }));
      await onOpenUrl(url);
    } catch (error) {
      if (mounted.current && request === openRequest.current) {
        setOpenError('Couldn’t open reference. Try again or close the preview.');
        onError?.(error instanceof Error ? error.message : 'Failed to open this reference.');
      }
    } finally {
      if (mounted.current && request === openRequest.current) {
        openingTarget.current = null;
        setOpeningPath(null);
      }
    }
  };

  return (
    <View style={{ gap: 10 }}>
      {label ? (
        <Text selectable style={{ color: theme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>
          {label}
        </Text>
      ) : null}
      <PagerRowScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: 10 }}
        showsHorizontalScrollIndicator={false}
      >
        {referenceItems.map((item, index) => {
          const storagePath = item.storagePath;
          const signedUrl = storagePath ? fileUrls[storagePath] : null;
          const isImage = Boolean(item.contentType?.startsWith('image/'));
          const mediaLabel = item.contentType?.startsWith('video/')
            ? 'Open video'
            : item.contentType?.startsWith('audio/')
              ? 'Open audio'
              : 'Open media';
          const isLoading = Boolean(storagePath && (loadingPaths[storagePath] || openingPath === storagePath));
          const previewFailed = Boolean(storagePath && failedPreviewPaths[storagePath]);
          // Never drawn under the plate, even when it was read before the plate came back.
          const videoFrame = !covered && storagePath ? videoFrames[storagePath] : null;
          const isOpenable = Boolean(item.externalUrl || storagePath);

          return (
            <Pressable
              accessibilityLabel={`Open reference ${item.title}`}
              accessibilityHint={covered && referenceMediaKind(item) ? 'Mature content. Opens in your browser.' : undefined}
              accessibilityRole={isOpenable ? 'button' : undefined}
              disabled={!isOpenable}
              key={referenceKey(item, index)}
              onPress={() => void openItem(item, index)}
              style={({ pressed }) => ({
                width: 142,
                minHeight: 222,
                borderRadius: 16,
                borderCurve: 'continuous',
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: pressed ? theme.colors.surfaceStrong : theme.colors.panel,
                overflow: 'hidden',
              })}
            >
              <View style={{ height: 166, backgroundColor: theme.colors.surfaceInset, alignItems: 'center', justifyContent: 'center' }}>
                {covered && isImage && storagePath ? (
                  <MatureCover variant="tile" />
                ) : isImage && signedUrl && !previewFailed ? (
                  <FeedMediaFrame
                    kind="image"
                    onImageError={() => {
                      if (!storagePath) return;
                      setFailedPreviewPaths((current) => ({ ...current, [storagePath]: true }));
                    }}
                    radius={0}
                    style={{ width: '100%', height: '100%' }}
                    transition={120}
                    url={signedUrl}
                  />
                ) : videoFrame ? (
                  // Ahead of the spinner, as a picture is: renewing the link to open the clip keeps its still.
                  <>
                    <Image
                      accessible={false}
                      contentFit="cover"
                      source={videoFrame}
                      style={{ position: 'absolute', inset: 0 }}
                      // The same synchronous swap on Android as StableMediaImage, for the same reason.
                      transition={Platform.OS === 'android' ? 0 : 120}
                    />
                    <ReferencePlayMark onPicture />
                  </>
                ) : isLoading ? (
                  <ActivityIndicator color={theme.colors.primary} />
                ) : isImage ? (
                  <ImageIcon size={appTheme.icon.hero} color={theme.colors.faint} />
                ) : referenceMediaKind(item) === 'video' ? (
                  // A clip reads as one: a play mark, where a document icon read as a file.
                  <ReferencePlayMark onPicture={false} />
                ) : item.contentType?.startsWith('audio/') || item.type === 'reference_audio' ? (
                  <AudioLines size={appTheme.icon.hero} color={theme.colors.faint} />
                ) : (
                  <FileText size={appTheme.icon.hero} color={theme.colors.faint} />
                )}
              </View>
              <View style={{ padding: 10, gap: 4 }}>
                {/* Selectable on iOS only. On Android the row takes a drag at gesture handler's root, which
                    leaves the touch on a selectable word uncancelled, and a flick that began on a title
                    selected it ~0.4 s later (Pixel 9a, 2026-10-29). The prompt holds the same names. */}
                <Text selectable={Platform.OS === 'ios'} numberOfLines={2} style={{ color: theme.colors.text, ...appTheme.type.label }}>
                  {item.title}
                </Text>
                {item.description ? (
                  <Text selectable={Platform.OS === 'ios'} numberOfLines={2} style={{ color: theme.colors.muted, ...appTheme.type.caption, fontWeight: '400' }}>
                    {item.description}
                  </Text>
                ) : null}
                {!isImage && isOpenable ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <ExternalLink size={appTheme.icon.xs} color={theme.colors.primary} />
                    <Text style={{ color: theme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>{mediaLabel}</Text>
                  </View>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </PagerRowScrollView>
      <MediaLightbox
        items={lightboxItems}
        activeIndex={lightboxIndex >= 0 ? lightboxIndex : null}
        statusMessage={openingPath ? 'Opening reference…' : null}
        errorMessage={openError}
        onClose={() => {
          openRequest.current++;
          openingTarget.current = null;
          setOpeningPath(null);
          setOpenError(null);
          setLightboxKey(null);
        }}
        onNavigate={(index) => {
          const key = lightboxItems[index]?.id;
          const referenceIndex = referenceItems.findIndex((item, itemIndex) => referenceKey(item, itemIndex) === key);
          if (referenceIndex >= 0) void openItem(referenceItems[referenceIndex], referenceIndex);
        }}
      />
    </View>
  );
}

/** On a clip's still, the dark layer the app draws over pictures; on the card's own panel, a plain disc. */
function ReferencePlayMark({ onPicture }: { onPicture: boolean }) {
  const theme = useAppTheme();
  const glyph = onPicture ? mediaColors.onMedia : theme.colors.text;
  return (
    <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
      backgroundColor: onPicture ? mediaColors.mediaScrimStrong : theme.colors.surfaceStrong }}>
      <Play size={appTheme.icon.compact} color={glyph} fill={glyph} />
    </View>
  );
}

function referenceKey(item: PostResourceItem, index: number) {
  return item.id ?? `${item.type}:${item.title}:${item.storagePath ?? item.externalUrl ?? index}`;
}

/** What the app can put on its own lightbox stage. Audio is not on it. */
export function referenceMediaKind(item: Pick<PostResourceItem, 'type' | 'contentType'>): 'image' | 'video' | null {
  if (item.contentType?.startsWith('image/')) return 'image';
  if (item.contentType?.startsWith('video/')) return 'video';
  if (item.type === 'reference_image') return 'image';
  if (item.type === 'reference_video') return 'video';
  return null;
}

/** The pictures, clips and sounds among a recipe's items, by the rule the web reads by too. */
export function getReferenceResourceItems(items: PostResourceItem[] | undefined) {
  return (items ?? [])
    .filter((item) => isRecipeMediaItem(item))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}
