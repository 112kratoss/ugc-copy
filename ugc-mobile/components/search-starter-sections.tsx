import { Box, Search, Wrench } from 'lucide-react-native';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';

import { SearchCreatorHandleLine } from '@/components/search-creator-handle-line';
import { SearchFollowButton, SearchFollowFailedLine } from '@/components/search-follow-button';
import { SearchRowPicture } from '@/components/search-row-picture';
import { CreatorAvatar } from '@/components/ui';
import { creatorProfilePress } from '@/lib/creator-profile-opening';
import {
  searchEntityActionLabel,
  searchEntityCountLabel,
  searchEntityKindLabel,
} from '@/lib/public-search-policy/public-search-policy';
import {
  SEARCH_STARTER_LABEL,
  type SearchStarterCreator,
  type SearchStarterEntity,
  type SearchStarterResponse,
  type SearchStarterSearch,
} from '@/lib/public-search-policy/search-starter';
import { searchCreatorFollowStacks } from '@/lib/search-creator-row';
import { searchStarterShownSections } from '@/lib/search-screen-view-model';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import { useSearchCreatorFollow } from '@/lib/use-search-creator-follow';

// A row's leading picture or avatar, and a chip's: a thumb's width beside the words.
const ROW_MARK_SIZE = 36;
const CHIP_MARK_SIZE = 28;
// The gap between a row's mark and its words: where Follow stood under a creator's name starts.
const ROW_MARK_GAP = 12;

function SectionHeading({ children }: { children: string }) {
  const theme = useAppTheme();
  return (
    <Text accessibilityRole="header" style={{ color: theme.colors.text, fontSize: 17, fontWeight: '800' }}>
      {children}
    </Text>
  );
}

function EntityStarterRow({ entity, onPress }: { entity: SearchStarterEntity; onPress: () => void }) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={searchEntityActionLabel(entity)}
      testID="search-starter-entity"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 52,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        opacity: pressed ? appTheme.opacity.pressed : 1,
        paddingVertical: 6,
      })}
    >
      {/* A post made with it, where the answer has one; its kind's glyph otherwise. */}
      <SearchRowPicture thumbnail={entity.thumbnail} size={ROW_MARK_SIZE} Icon={entity.kind === 'model' ? Box : Wrench} />
      <View style={{ minWidth: 0, flex: 1 }}>
        <Text numberOfLines={2} style={{ color: theme.colors.text, fontSize: 15, fontWeight: '800' }}>{entity.label}</Text>
        <Text numberOfLines={1} style={{ marginTop: 1, color: theme.colors.muted, fontSize: 13 }}>
          {`${searchEntityKindLabel(entity.kind)} · ${searchEntityCountLabel(entity)}`}
        </Text>
      </View>
    </Pressable>
  );
}

// Follow beside the creator, as on a result's row: at the accessibility text
// sizes under the name, and the handle keeping its room (review of #828, S9).
function CreatorStarterRow({ creator, onOpen, followReturnTo }: { creator: SearchStarterCreator; onOpen: () => void; followReturnTo: string }) {
  const theme = useAppTheme();
  const followStacks = searchCreatorFollowStacks(useWindowDimensions().fontScale);
  const follow = useSearchCreatorFollow(creator, { returnTo: followReturnTo });
  const name = creator.displayName.toLowerCase() === creator.username.toLowerCase() ? `@${creator.username}` : `${creator.displayName}, @${creator.username}`;
  const opener = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}${follow.following ? ', following' : ''}, ${creator.publicPostCount} ${creator.publicPostCount === 1 ? 'post' : 'posts'}. Open profile`}
      testID="search-starter-creator"
      // Their page is read once the finger has rested here, as on every creator row.
      {...creatorProfilePress(creator.username, onOpen)}
      style={({ pressed }) => ({
        minHeight: 52,
        minWidth: 0,
        flex: followStacks ? undefined : 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: ROW_MARK_GAP,
        opacity: pressed ? appTheme.opacity.pressed : 1,
        paddingVertical: 6,
      })}
    >
      <CreatorAvatar uri={creator.avatarUrl} name={creator.displayName} size={ROW_MARK_SIZE} />
      <View style={{ minWidth: 0, flex: 1 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 15, fontWeight: '800' }}>{creator.displayName}</Text>
        <SearchCreatorHandleLine username={creator.username} postCount={creator.publicPostCount} />
      </View>
    </Pressable>
  );
  // Follows in place: beside the row's press, never inside it (search-follow-button.tsx).
  const followButton = follow.offered
    ? <SearchFollowButton creator={creator} following={follow.following} pending={follow.pending} onPress={follow.press} />
    : null;
  return (
    <View testID="search-starter-creator-card" style={{ gap: 4 }}>
      {followStacks ? (
        <>
          {opener}
          {followButton ? (
            // A row holding the button at its start, as on a result's card: a column drawn
            // `alignItems: 'flex-start'` grew the button to 1,230 pt at AX3 on iOS.
            <View testID="search-creator-follow" style={{ flexDirection: 'row', paddingLeft: ROW_MARK_SIZE + ROW_MARK_GAP }}>
              {followButton}
            </View>
          ) : null}
        </>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          {opener}
          {followButton ? <View testID="search-creator-follow">{followButton}</View> : null}
        </View>
      )}
      {follow.failed ? <SearchFollowFailedLine /> : null}
    </View>
  );
}

function SearchStarterChip({ search, onPress }: { search: SearchStarterSearch; onPress: () => void }) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Search for ${search.text}`}
      testID="search-starter-search"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: appTheme.touch.default,
        maxWidth: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
        opacity: pressed ? appTheme.opacity.pressed : 1,
        paddingLeft: 10,
        paddingRight: 14,
        paddingVertical: 6,
      })}
    >
      {/* A post the search finds, round at the capsule's start; the magnifier where there is none. */}
      <SearchRowPicture thumbnail={search.thumbnail} size={CHIP_MARK_SIZE} shape="circle" Icon={Search} iconSize={appTheme.icon.xs} iconTone="muted" />
      {/* A phrase wraps inside its capsule rather than run past the screen at the largest sizes. */}
      <Text style={{ flexShrink: 1, color: theme.colors.text, fontSize: 14, fontWeight: '700' }}>{search.text}</Text>
    </Pressable>
  );
}

/**
 * The starter content of the search screen (search UX audit 2026-11-13,
 * findings 2 and 8; `GET /api/search/starter`, rules in
 * `lib/public-search-policy/search-starter.ts`): popular models and tools,
 * creators to follow, and searches to try, each under its heading, in that
 * order; a list with nothing in it draws no heading. A list the answer says is
 * this week's is titled so ("Popular this week"), any other by its all-time
 * heading (searchStarterShownSections). Each model, tool and search draws the
 * picture the answer gives it, its glyph in the same frame where there is
 * none; each creator has Follow beside them. Drawn under the recent searches
 * before anything is typed, and under "No results" with `heading` ("Try one
 * of these instead") when a search finds nothing.
 */
export function SearchStarterSections({
  answer,
  heading = null,
  onEntity,
  onCreator,
  onSearch,
  followReturnTo,
}: {
  answer: SearchStarterResponse;
  heading?: string | null;
  onEntity: (entity: SearchStarterEntity) => void;
  onCreator: (creator: SearchStarterCreator) => void;
  onSearch: (search: SearchStarterSearch) => void;
  /** The search the sections are drawn on: where a visitor's Follow comes back to (searchScreenHref). */
  followReturnTo: string;
}) {
  const theme = useAppTheme();
  const sections = searchStarterShownSections(answer);
  if (sections.length === 0) return null;
  return (
    <View accessibilityLabel={SEARCH_STARTER_LABEL} testID="search-starter" style={{ gap: 22 }}>
      {heading ? (
        <Text accessibilityRole="header" style={{ color: theme.colors.textSecondary, fontSize: 15, fontWeight: '700' }}>{heading}</Text>
      ) : null}
      {sections.map((section) => (
        <View key={section.id} style={{ gap: 6 }}>
          <SectionHeading>{section.heading}</SectionHeading>
          {section.id === 'entities'
            ? section.entities.map((entity) => (
              <EntityStarterRow key={`${entity.kind}:${entity.key}`} entity={entity} onPress={() => onEntity(entity)} />
            ))
            : section.id === 'creators'
              ? section.creators.map((creator) => (
                <CreatorStarterRow key={creator.id} creator={creator} onOpen={() => onCreator(creator)} followReturnTo={followReturnTo} />
              ))
              : (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 }}>
                  {section.searches.map((search) => (
                    <SearchStarterChip key={search.text} search={search} onPress={() => onSearch(search)} />
                  ))}
                </View>
              )}
        </View>
      ))}
    </View>
  );
}
