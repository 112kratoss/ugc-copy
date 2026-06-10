import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import {
  Archive,
  ArrowLeft,
  Edit,
  Eye,
  EyeOff,
  FileText,
  Globe,
  Heart,
  ImageIcon,
  Images,
  Lock,
  MoreVertical,
  Play,
  Share2,
  Sparkles,
  Zap,
} from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Share,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth';
import {
  buildViewerItems,
  loadImmersiveSourceData,
  normalizeViewerSource,
} from '@/lib/immersive-preview-source-data';
import { getProfileHandle } from '@/lib/profile-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import type { ShowcaseMediaItem } from '@/lib/types';

export default function MediaFeedScreen() {
  const { user, isLoading: authLoading, api } = useAuth();
  const params = useLocalSearchParams<{ source?: string; initialId?: string }>();
  const source = normalizeViewerSource(params.source);
  const initialId = params.initialId;
  const queryClient = useQueryClient();

  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);

  const [activeVerticalIndex, setActiveVerticalIndex] = useState(0);
  const [selectedItemForActions, setSelectedItemForActions] = useState<ImmersivePreviewItem | null>(null);

  const profileQuery = useQuery({
    queryKey: ['profile', user?.id],
    enabled: Boolean(user),
    queryFn: api.getProfile,
  });

  const creatorLabel = useMemo(
    () => getProfileHandle(profileQuery.data, user?.email),
    [profileQuery.data, user?.email]
  );
  const creatorAvatar = profileQuery.data?.avatarUrl ?? null;

  const sourceDataQuery = useQuery({
    queryKey: ['media-feed-data', source, user?.id, initialId],
    enabled: Boolean(user && source),
    queryFn: () => loadImmersiveSourceData({ api, source, initialId: initialId ?? '' }),
  });

  const items = useMemo(() => {
    if (!sourceDataQuery.data) return [];
    return buildViewerItems(source, sourceDataQuery.data, { creatorLabel, creatorAvatar });
  }, [source, sourceDataQuery.data, creatorLabel, creatorAvatar]);

  const orderedItems = useMemo(() => {
    if (!initialId || items.length === 0) return items;
    const idx = items.findIndex((item) => item.id === initialId);
    if (idx <= 0) return items;
    return [...items.slice(idx), ...items.slice(0, idx)];
  }, [items, initialId]);

  useEffect(() => {
    if (orderedItems.length > 0) {
      setActiveVerticalIndex(0);
    }
  }, [orderedItems.length, initialId, source]);

  const title = useMemo(() => {
    if (source === 'profile-saved') return 'Saved';
    if (source === 'profile-creations') return 'Creations';
    return 'Posts';
  }, [source]);

  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 60,
  });

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: any[] }) => {
    if (viewableItems.length > 0) {
      setActiveVerticalIndex(viewableItems[0].index ?? 0);
    }
  });

  if (authLoading) {
    return <MediaFeedLoadingScreen />;
  }

  if (!user) {
    return <Redirect href="/auth" />;
  }

  if (sourceDataQuery.isLoading || profileQuery.isLoading) {
    return <MediaFeedLoadingScreen />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#03040d', paddingTop: topInset }}>
      {/* Top Header */}
      <View
        style={{
          height: 56,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: 'rgba(255,255,255,0.08)',
          backgroundColor: '#03040d',
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={({ pressed }) => ({
            width: 40,
            height: 40,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <ArrowLeft size={24} color="#ffffff" />
        </Pressable>
        <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: '900' }}>{title}</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Feed List */}
      {orderedItems.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 16 }}>No items found in this section.</Text>
        </View>
      ) : (
        <FlatList
          data={orderedItems}
          keyExtractor={(item) => item.id}
          viewabilityConfig={viewabilityConfig.current}
          onViewableItemsChanged={onViewableItemsChanged.current}
          showsVerticalScrollIndicator={false}
          renderItem={({ item, index }) => (
            <MediaFeedCard
              item={item}
              isActive={index === activeVerticalIndex}
              onPressActions={() => setSelectedItemForActions(item)}
              width={width}
            />
          )}
          contentContainerStyle={{ paddingBottom: bottomInset + 20 }}
        />
      )}

      {/* Action Bottom Sheet */}
      {selectedItemForActions && (
        <ActionBottomSheet
          item={selectedItemForActions}
          onClose={() => setSelectedItemForActions(null)}
          onRefresh={() => {
            void sourceDataQuery.refetch();
          }}
          api={api}
          queryClient={queryClient}
          userId={user?.id}
        />
      )}
    </View>
  );
}

function MediaFeedLoadingScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: '#03040d', alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color="#d946ef" size="large" />
    </View>
  );
}

function MediaFeedCard({
  item,
  isActive,
  onPressActions,
  width,
}: {
  item: ImmersivePreviewItem;
  isActive: boolean;
  onPressActions: () => void;
  width: number;
}) {
  const cardWidth = Math.min(width, 430);
  const mediaCount = item.mediaItems.length;

  const promptText = item.recreatePrompt || item.details?.prompt;
  const isTitleFallback = item.title === promptText || item.title === item.displayText;

  const displayTitle = useMemo(() => {
    if (!isTitleFallback) return item.title;
    if (item.previewKind === 'text') return 'AI Text Generation';
    if (item.mediaKind === 'video') return 'AI Video Generation';
    return 'AI Image Generation';
  }, [item.title, isTitleFallback, item.previewKind, item.mediaKind]);

  const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1);

  const renderStatus = () => {
    if (item.sourceType === 'generation') {
      if (item.archivedAt) {
        return (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Archive size={11} color="rgba(255,255,255,0.5)" />
            <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '700' }}>Archived Creation</Text>
          </View>
        );
      }
      if (item.linkedPostId) {
        const isPrivate = item.linkedPostVisibility === 'private' || item.linkedPostVisibility === 'unlisted';
        return (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {isPrivate ? (
              <EyeOff size={11} color="rgba(255,255,255,0.5)" />
            ) : (
              <Eye size={11} color="rgba(255,255,255,0.5)" />
            )}
            <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '700' }}>
              Posted ({item.linkedPostVisibility ? capitalize(item.linkedPostVisibility) : 'Public'})
            </Text>
          </View>
        );
      }
      return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Sparkles size={11} color="#a855f7" />
          <Text style={{ color: '#a855f7', fontSize: 11, fontWeight: '700' }}>
            Private Creation
          </Text>
        </View>
      );
    }

    const isArchived = Boolean(item.archivedAt);
    const isPrivate = item.visibility === 'private' || item.visibility === 'unlisted';

    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {isArchived ? (
          <Archive size={11} color="rgba(255,255,255,0.5)" />
        ) : isPrivate ? (
          <EyeOff size={11} color="rgba(255,255,255,0.5)" />
        ) : (
          <Eye size={11} color="rgba(255,255,255,0.5)" />
        )}
        <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '700' }}>
          {isArchived ? 'Archived' : item.visibility ? capitalize(item.visibility) : item.badge || 'Public'}
        </Text>
      </View>
    );
  };

  const formatDate = (dateStr?: string | null) => {
    if (!dateStr) return '-';
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return '-';
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${months[d.getMonth()]} ${d.getDate()}`;
    } catch {
      return '-';
    }
  };

  const formatRenderDuration = (seconds?: number | null) => {
    if (seconds === undefined || seconds === null) return '-';
    if (seconds < 60) {
      return `0m ${seconds.toString().padStart(2, '0')}s`;
    }
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  };

  return (
    <View
      style={{
        width: cardWidth,
        alignSelf: 'center',
        marginVertical: 10,
        backgroundColor: '#090914',
        borderRadius: 24,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.06)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 12,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View
            style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              overflow: 'hidden',
              backgroundColor: '#1c1c2e',
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.12)',
            }}
          >
            {item.creatorAvatar ? (
              <Image source={{ uri: item.creatorAvatar }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
            ) : (
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '900' }}>
                {item.creatorLabel.replace('@', '').slice(0, 2).toUpperCase()}
              </Text>
            )}
          </View>
          <View style={{ gap: 2 }}>
            <Text style={{ color: '#ffffff', fontSize: 14, fontWeight: '800' }}>{item.creatorLabel}</Text>
            {renderStatus()}
          </View>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open options menu"
          onPress={onPressActions}
          style={({ pressed }) => ({
            width: 36,
            height: 36,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <MoreVertical size={20} color="#ffffff" />
        </Pressable>
      </View>

      {/* Media Carousel */}
      <View style={{ width: cardWidth, height: cardWidth * 1.2, backgroundColor: '#000', position: 'relative' }}>
        {mediaCount === 0 ? (
          <TextSlide item={item} width={cardWidth} height={cardWidth * 1.2} />
        ) : (
          <MediaCarousel mediaItems={item.mediaItems} isActive={isActive} width={cardWidth} height={cardWidth * 1.2} />
        )}

        {/* Overlay Badge */}
        {item.sourceType !== 'showcase' && (
          <View
            style={{
              position: 'absolute',
              top: 12,
              left: 12,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              borderRadius: 12,
              backgroundColor: 'rgba(9, 9, 20, 0.75)',
              borderWidth: 1,
              borderColor: 'rgba(56, 189, 248, 0.25)',
              paddingHorizontal: 8,
              paddingVertical: 4,
            }}
          >
            {item.previewKind === 'text' ? (
              <>
                <FileText size={10} color="#38bdf8" />
                <Text style={{ color: '#38bdf8', fontSize: 10, fontWeight: '900' }}>TEXT</Text>
              </>
            ) : item.mediaKind === 'video' ? (
              <>
                <Play size={10} color="#38bdf8" fill="#38bdf8" />
                <Text style={{ color: '#38bdf8', fontSize: 10, fontWeight: '900' }}>VIDEO</Text>
              </>
            ) : (
              <>
                <ImageIcon size={10} color="#38bdf8" />
                <Text style={{ color: '#38bdf8', fontSize: 10, fontWeight: '900' }}>IMAGE</Text>
              </>
            )}
          </View>
        )}
      </View>

      {/* Status Row */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 10,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Heart size={20} color="#ff4d2d" fill={item.isSaved ? '#ff4d2d' : 'transparent'} strokeWidth={2.2} />
          <Text style={{ color: '#ffffff', fontSize: 13, fontWeight: '800' }}>{item.saveLabel}</Text>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Share media"
          onPress={() => {
            void Share.share({
              message: item.sharePath ? `Check this out: ${item.sharePath}` : item.title,
            });
          }}
          style={({ pressed }) => ({
            width: 32,
            height: 32,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Share2 size={20} color="#ffffff" />
        </Pressable>
      </View>

      {/* Details / Caption */}
      <View style={{ paddingHorizontal: 14, paddingBottom: 16, gap: 8 }}>
        <Text style={{ color: '#ffffff', fontSize: 15, fontWeight: '900' }}>{displayTitle}</Text>

        {item.displayText && item.displayText !== promptText ? (
          <Text style={{ color: 'rgba(255,255,255,0.76)', fontSize: 13, lineHeight: 18 }}>{item.displayText}</Text>
        ) : null}

        {promptText ? (
          <View
            style={{
              backgroundColor: 'rgba(168,85,247,0.06)',
              borderRadius: 14,
              borderWidth: 1,
              borderColor: 'rgba(168,85,247,0.16)',
              padding: 12,
              marginTop: 4,
              gap: 6,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Sparkles size={12} color="#c084fc" />
              <Text style={{ color: '#c084fc', fontSize: 11, fontWeight: '900', textTransform: 'uppercase' }}>
                AI Prompt
              </Text>
            </View>
            <Text selectable style={{ color: 'rgba(255,255,255,0.86)', fontSize: 13, lineHeight: 19, fontStyle: 'italic' }}>
              "{promptText}"
            </Text>
          </View>
        ) : null}

        {/* Specifications Table */}
        {item.details?.generationInfo && (
          <View
            style={{
              flexDirection: 'row',
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.06)',
              borderRadius: 16,
              backgroundColor: 'rgba(255,255,255,0.02)',
              paddingVertical: 12,
              paddingHorizontal: 8,
              marginTop: 6,
            }}
          >
            <View style={{ flex: 1, alignItems: 'center', borderRightWidth: 1, borderRightColor: 'rgba(255,255,255,0.06)' }}>
              <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: '800', marginBottom: 4 }}>CREATED</Text>
              <Text style={{ color: '#ffffff', fontSize: 13, fontWeight: '700' }}>
                {formatDate(item.details.generationInfo.createdAt)}
              </Text>
            </View>

            <View style={{ flex: 1, alignItems: 'center', borderRightWidth: 1, borderRightColor: 'rgba(255,255,255,0.06)' }}>
              <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: '800', marginBottom: 4 }}>RENDER</Text>
              <Text style={{ color: '#ffffff', fontSize: 13, fontWeight: '700' }}>
                {formatRenderDuration(item.details.generationInfo.duration)}
              </Text>
            </View>

            <View style={{ flex: 1, alignItems: 'center' }}>
              <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: '800', marginBottom: 4 }}>CREDITS</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <Zap size={11} color="#eab308" fill="#eab308" />
                <Text style={{ color: '#ffffff', fontSize: 13, fontWeight: '700' }}>
                  {item.details.generationInfo.cost ?? 0}
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Status Pills */}
        {item.details?.generationInfo && (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
            {/* Post State Pill */}
            {item.linkedPostId || item.sourceType === 'owner-post' || item.sourceType === 'showcase' ? (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 8,
                  backgroundColor: 'rgba(16, 185, 129, 0.08)',
                  borderWidth: 1,
                  borderColor: 'rgba(16, 185, 129, 0.2)',
                }}
              >
                <Text style={{ color: '#10b981', fontSize: 11, fontWeight: '700' }}>Published</Text>
              </View>
            ) : (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 8,
                  backgroundColor: 'rgba(255, 255, 255, 0.05)',
                  borderWidth: 1,
                  borderColor: 'rgba(255, 255, 255, 0.1)',
                }}
              >
                <Text style={{ color: 'rgba(255, 255, 255, 0.6)', fontSize: 11, fontWeight: '700' }}>Not published</Text>
              </View>
            )}

            {/* Unlock State Pill */}
            {item.resource ? (
              item.resource.accessMode === 'free' ? (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    borderRadius: 8,
                    backgroundColor: 'rgba(168, 85, 247, 0.08)',
                    borderWidth: 1,
                    borderColor: 'rgba(168, 85, 247, 0.2)',
                  }}
                >
                  <Text style={{ color: '#c084fc', fontSize: 11, fontWeight: '700' }}>Free unlock</Text>
                </View>
              ) : (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    borderRadius: 8,
                    backgroundColor: 'rgba(217, 70, 239, 0.08)',
                    borderWidth: 1,
                    borderColor: 'rgba(217, 70, 239, 0.2)',
                  }}
                >
                  <Text style={{ color: '#d946ef', fontSize: 11, fontWeight: '700' }}>Paid unlock</Text>
                </View>
              )
            ) : (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 8,
                  backgroundColor: 'rgba(255, 255, 255, 0.05)',
                  borderWidth: 1,
                  borderColor: 'rgba(255, 255, 255, 0.1)',
                }}
              >
                <Text style={{ color: 'rgba(255, 255, 255, 0.6)', fontSize: 11, fontWeight: '700' }}>No unlock</Text>
              </View>
            )}
          </View>
        )}

        {/* Reference Inputs Used Row */}
        {item.details?.generationInfo?.inputMedia && item.details.generationInfo.inputMedia.length > 0 && (
          <View style={{ marginTop: 8 }}>
            <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, fontWeight: '900', textTransform: 'uppercase', marginBottom: 8 }}>
              Reference Inputs Used
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              {item.details.generationInfo.inputMedia.map((media, idx) => (
                <View
                  key={idx}
                  style={{
                    width: 72,
                    backgroundColor: '#161622',
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: 'rgba(255,255,255,0.08)',
                    overflow: 'hidden',
                  }}
                >
                  <View style={{ width: 70, height: 70 }}>
                    {media.url ? (
                      <Image source={{ uri: media.url }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
                    ) : (
                      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                        <ImageIcon size={18} color="rgba(255,255,255,0.4)" />
                      </View>
                    )}
                  </View>
                  <View
                    style={{
                      paddingVertical: 4,
                      paddingHorizontal: 6,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 4,
                      backgroundColor: '#0c0c14',
                      borderTopWidth: 1,
                      borderTopColor: 'rgba(255,255,255,0.06)',
                    }}
                  >
                    <ImageIcon size={9} color="rgba(255,255,255,0.5)" />
                    <Text numberOfLines={1} style={{ color: 'rgba(255,255,255,0.6)', fontSize: 9, fontWeight: '700' }}>
                      Element {idx + 1}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Call to Action Buttons */}
        {item.sourceType === 'generation' && !item.archivedAt && (
          <View style={{ marginTop: 8 }}>
            {!item.linkedPostId ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Publish Creation"
                onPress={() => {
                  router.push({
                    pathname: '/post/new',
                    params: { generationId: item.id },
                  } as never);
                }}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: '#ffffff',
                  borderRadius: 12,
                  paddingVertical: 12,
                  gap: 8,
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Globe size={16} color="#090914" />
                <Text style={{ color: '#090914', fontSize: 14, fontWeight: '800' }}>Publish</Text>
              </Pressable>
            ) : (
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="View Post"
                  onPress={() => {
                    router.push({
                      pathname: '/media-feed',
                      params: { source: 'profile-posts', initialId: item.linkedPostId },
                    } as never);
                  }}
                  style={({ pressed }) => ({
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: 'rgba(255,255,255,0.06)',
                    borderWidth: 1,
                    borderColor: 'rgba(255,255,255,0.12)',
                    borderRadius: 12,
                    paddingVertical: 10,
                    gap: 6,
                    opacity: pressed ? 0.75 : 1,
                  })}
                >
                  <Eye size={14} color="#ffffff" />
                  <Text style={{ color: '#ffffff', fontSize: 13, fontWeight: '800' }}>View Post</Text>
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Customize Post"
                  onPress={() => {
                    router.push({
                      pathname: '/post/new',
                      params: { postId: item.linkedPostId },
                    } as never);
                  }}
                  style={({ pressed }) => ({
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: 'rgba(255,255,255,0.06)',
                    borderWidth: 1,
                    borderColor: 'rgba(255,255,255,0.12)',
                    borderRadius: 12,
                    paddingVertical: 10,
                    gap: 6,
                    opacity: pressed ? 0.75 : 1,
                  })}
                >
                  <Edit size={14} color="#ffffff" />
                  <Text style={{ color: '#ffffff', fontSize: 13, fontWeight: '800' }}>Customize Post</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}

        {/* Unlock Summary Banner */}
        {item.resource && !item.details?.generationInfo && (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              marginTop: 4,
              padding: 10,
              backgroundColor: 'rgba(168,85,247,0.12)',
              borderRadius: 12,
              borderWidth: 1,
              borderColor: 'rgba(168,85,247,0.24)',
            }}
          >
            <Lock size={15} color="#d946ef" />
            <Text style={{ color: '#d946ef', fontSize: 12, fontWeight: '900' }}>
              Includes {item.resource.accessMode === 'free' ? 'Free Unlock' : 'Paid Unlock'}{' '}
              {item.resource.priceUsdCents ? `($${(item.resource.priceUsdCents / 100).toFixed(2)})` : ''}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

function MediaCarousel({
  mediaItems,
  isActive,
  width,
  height,
}: {
  mediaItems: ShowcaseMediaItem[];
  isActive: boolean;
  width: number;
  height: number;
}) {
  const [currentPage, setCurrentPage] = useState(0);
  const count = mediaItems.length;

  return (
    <View style={{ width, height }}>
      <FlatList
        data={mediaItems}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(event) => {
          const page = Math.round(event.nativeEvent.contentOffset.x / width);
          setCurrentPage(page);
        }}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index }) => (
          <View style={{ width, height }}>
            {item.mediaKind === 'video' ? (
              <VideoPlayerItem
                url={item.url}
                isActive={isActive && index === currentPage}
                width={width}
                height={height}
              />
            ) : (
              <Image source={{ uri: item.url }} style={{ width, height }} contentFit="cover" />
            )}
          </View>
        )}
      />
      {/* 1 / N Overlay */}
      {count > 1 ? (
        <View
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            borderRadius: 14,
            backgroundColor: 'rgba(0,0,0,0.58)',
            paddingHorizontal: 9,
            paddingVertical: 5,
          }}
        >
          <Images size={13} color="#ffffff" />
          <Text style={{ color: '#ffffff', fontSize: 11, fontWeight: '900' }}>
            {currentPage + 1} / {count}
          </Text>
        </View>
      ) : null}

      {/* Indicators Dots */}
      {count > 1 ? (
        <View
          style={{
            position: 'absolute',
            bottom: 12,
            left: 0,
            right: 0,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 5,
          }}
        >
          {mediaItems.map((_, index) => (
            <View
              key={index}
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: index === currentPage ? '#ffffff' : 'rgba(255,255,255,0.4)',
              }}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function VideoPlayerItem({ url, isActive, width, height }: { url: string; isActive: boolean; width: number; height: number }) {
  const player = useVideoPlayer(url, (instance) => {
    instance.loop = true;
    instance.muted = false;
    instance.volume = 1.0;
    instance.showNowPlayingNotification = false;
    instance.staysActiveInBackground = false;
  });

  const [isPlaying, setIsPlaying] = useState(player.playing);

  useEffect(() => {
    if (isActive) {
      player.play();
      setIsPlaying(player.playing);
    } else {
      player.pause();
    }
  }, [isActive, player]);

  useEffect(() => {
    const subscription = player.addListener('playingChange', (event) => {
      setIsPlaying(event.isPlaying);
    });
    return () => {
      subscription.remove();
    };
  }, [player]);

  const handlePress = () => {
    if (player.playing) {
      player.pause();
    } else {
      player.play();
    }
  };

  return (
    <Pressable onPress={handlePress} style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
      <VideoView
        player={player}
        nativeControls={false}
        contentFit="cover"
        fullscreenOptions={{ enable: false }}
        allowsPictureInPicture={false}
        startsPictureInPictureAutomatically={false}
        useExoShutter={false}
        surfaceType="textureView"
        style={{ position: 'absolute', inset: 0, backgroundColor: '#000' }}
      />
      {!isPlaying && (
        <View
          style={{
            width: 62,
            height: 62,
            borderRadius: 31,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0,0,0,0.5)',
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.2)',
          }}
        >
          <Play size={28} color="#fff" fill="#fff" style={{ marginLeft: 3 }} />
        </View>
      )}
    </Pressable>
  );
}

function TextSlide({ item, width, height }: { item: ImmersivePreviewItem; width: number; height: number }) {
  return (
    <LinearGradient
      colors={['#17051d', '#060609', '#07171f']}
      style={{ width, height, justifyContent: 'center', padding: 22 }}
    >
      <View style={{ borderRadius: 20, borderCurve: 'continuous', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', backgroundColor: 'rgba(255,255,255,0.07)', padding: 20, gap: 10 }}>
        <Text numberOfLines={3} style={{ color: '#fff', fontSize: 22, lineHeight: 28, fontWeight: '900' }}>
          {item.title}
        </Text>
        <Text numberOfLines={8} style={{ color: 'rgba(255,255,255,0.76)', fontSize: 14, lineHeight: 21 }}>
          {item.displayText}
        </Text>
      </View>
    </LinearGradient>
  );
}

function ActionBottomSheet({
  item,
  onClose,
  onRefresh,
  api,
  queryClient,
  userId,
}: {
  item: ImmersivePreviewItem;
  onClose: () => void;
  onRefresh: () => void;
  api: any;
  queryClient: QueryClient;
  userId: string | undefined;
}) {
  const actions = item.availableActions;
  const disabledActions = item.disabledActions;
  const refreshAfterMutation = async () => {
    await invalidateMediaFeedCaches(queryClient, userId);
    onRefresh();
  };

  const handleAction = async (action: string) => {
    onClose();

    if (action === 'unsave') {
      Alert.alert('Unsave Post', 'Are you sure you want to unsave this post?', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unsave',
          style: 'destructive',
          onPress: async () => {
            try {
              if (item.showcasePostId) {
                await api.saveShowcasePost(item.showcasePostId);
                await refreshAfterMutation();
              }
            } catch (err) {
              Alert.alert('Error', 'Failed to unsave post.');
            }
          },
        },
      ]);
      return;
    }

    if (action === 'archive') {
      Alert.alert('Archive Item', `Are you sure you want to archive this ${item.sourceType === 'owner-post' ? 'post' : 'creation'}?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: async () => {
            try {
              if (item.sourceType === 'owner-post') {
                await api.archivePost(item.id);
              } else {
                await api.archiveGeneration(item.id);
              }
              await refreshAfterMutation();
            } catch (err) {
              Alert.alert('Error', 'Failed to archive.');
            }
          },
        },
      ]);
      return;
    }

    if (action === 'restore') {
      Alert.alert('Restore Item', `Are you sure you want to restore this ${item.sourceType === 'owner-post' ? 'post' : 'creation'}?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore',
          onPress: async () => {
            try {
              if (item.sourceType === 'owner-post') {
                await api.restorePost(item.id);
              } else {
                await api.restoreGeneration(item.id);
              }
              await refreshAfterMutation();
            } catch (err) {
              Alert.alert('Error', 'Failed to restore.');
            }
          },
        },
      ]);
      return;
    }

    if (action === 'publish') {
      router.push({
        pathname: '/post/new',
        params: { generationId: item.id },
      } as never);
      return;
    }

    if (action === 'edit-post') {
      router.push({
        pathname: '/post/new',
        params: { postId: item.id },
      } as never);
      return;
    }

    if (action === 'view-linked') {
      if (item.linkedPostId) {
        router.push({
          pathname: '/media-feed',
          params: { source: 'profile-posts', initialId: item.linkedPostId },
        } as never);
      }
      return;
    }

    if (action === 'edit-linked') {
      if (item.linkedPostId) {
        router.push({
          pathname: '/post/new',
          params: { postId: item.linkedPostId },
        } as never);
      }
      return;
    }

    if (action === 'change-visibility') {
      Alert.alert('Change Visibility', 'Choose who can see this post:', [
        { text: 'Public', onPress: () => updatePostVisibility('public') },
        { text: 'Unlisted', onPress: () => updatePostVisibility('unlisted') },
        { text: 'Private', onPress: () => updatePostVisibility('private') },
        { text: 'Cancel', style: 'cancel' },
      ]);
      return;
    }

    if (action === 'recreate') {
      router.push(`/create/${item.recreateTool}?prompt=${encodeURIComponent(item.recreatePrompt)}` as any);
      return;
    }

    if (action === 'open-original') {
      if (item.showcasePostId) {
        router.push(`/showcase/${item.showcasePostId}` as any);
      }
      return;
    }

    if (action === 'share') {
      void Share.share({
        message: item.sharePath ? `Check this out: ${item.sharePath}` : item.title,
      });
      return;
    }

    if (action === 'download') {
      const mediaUrl = item.mediaItems[0]?.url ?? item.mediaUrl;
      if (!mediaUrl) {
        Alert.alert('No media file', 'This item does not have a downloadable media file.');
        return;
      }
      await Linking.openURL(mediaUrl);
      return;
    }

    if (action === 'view-details') {
      Alert.alert(
        item.title,
        `Prompt:\n${item.details?.prompt || item.recreatePrompt || 'None'}\n\nDescription:\n${item.displayText || 'None'}`
      );
      return;
    }

    Alert.alert('Action', `Action "${action}" triggered.`);
  };

  const updatePostVisibility = async (visibility: 'public' | 'unlisted' | 'private') => {
    try {
      await api.updatePost(item.id, { visibility });
      await refreshAfterMutation();
    } catch (err) {
      Alert.alert('Error', 'Failed to update visibility.');
    }
  };

  return (
    <Modal visible={true} transparent={true} animationType="slide" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' }}>
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: '#0c0c16',
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingBottom: 34,
            paddingTop: 16,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.08)',
          }}
        >
          <View
            style={{
              width: 42,
              height: 4,
              borderRadius: 2,
              backgroundColor: 'rgba(255,255,255,0.18)',
              alignSelf: 'center',
              marginBottom: 16,
            }}
          />

          <ScrollView style={{ maxHeight: 380 }}>
            {actions.map((action) => {
              const disabledReason = disabledActions[action];
              const isDestructive = ['unsave', 'archive'].includes(action);

              return (
                <Pressable
                  key={action}
                  disabled={Boolean(disabledReason)}
                  onPress={() => handleAction(action)}
                  style={({ pressed }) => ({
                    paddingVertical: 14,
                    paddingHorizontal: 22,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    backgroundColor: pressed ? 'rgba(255,255,255,0.04)' : 'transparent',
                    opacity: disabledReason ? 0.38 : 1,
                  })}
                >
                  <View style={{ gap: 2 }}>
                    <Text
                      style={{
                        color: isDestructive ? '#ff4d2d' : '#ffffff',
                        fontSize: 15,
                        fontWeight: '800',
                      }}
                    >
                      {actionLabel(action)}
                    </Text>
                    {disabledReason ? (
                      <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>{disabledReason}</Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}

function actionLabel(action: string): string {
  switch (action) {
    case 'unsave':
      return 'Unsave';
    case 'share':
      return 'Share';
    case 'recreate':
      return 'Recreate / Remix';
    case 'publish':
      return 'Post this creation';
    case 'archive':
      return 'Archive';
    case 'restore':
      return 'Restore';
    case 'edit-post':
      return 'Edit post';
    case 'change-visibility':
      return 'Change visibility';
    case 'view-linked':
      return 'View linked post';
    case 'edit-linked':
      return 'Edit linked post';
    case 'open-original':
      return 'Open original post';
    case 'view-details':
      return 'View details';
    case 'download':
      return 'Download media';
    default:
      return action.charAt(0).toUpperCase() + action.slice(1);
  }
}

async function invalidateMediaFeedCaches(queryClient: QueryClient, userId: string | undefined) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['media-feed-data'] }),
    queryClient.invalidateQueries({ queryKey: ['showcase-feed'] }),
    queryClient.invalidateQueries({ queryKey: ['post-new-generations', userId] }),
    queryClient.invalidateQueries({ queryKey: ['profile-saved-showcase', userId] }),
    queryClient.invalidateQueries({ queryKey: ['profile-generations', userId] }),
    queryClient.invalidateQueries({ queryKey: ['profile-owner-posts', userId] }),
  ]);
}
