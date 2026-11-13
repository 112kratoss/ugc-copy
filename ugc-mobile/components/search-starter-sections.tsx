import { Box, Search, Wrench } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { CreatorAvatar } from '@/components/ui';
import { creatorProfilePress } from '@/lib/creator-profile-opening';
import {
  searchEntityActionLabel,
  searchEntityCountLabel,
  searchEntityKindLabel,
} from '@/lib/public-search-policy/public-search-policy';
import {
  SEARCH_STARTER_LABEL,
  searchStarterSections,
  type SearchStarterCreator,
  type SearchStarterEntity,
  type SearchStarterResponse,
  type SearchStarterSearch,
} from '@/lib/public-search-policy/search-starter';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

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
  const Icon = entity.kind === 'model' ? Box : Wrench;
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
      <View
        style={{
          width: 36,
          height: 36,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: appTheme.radii.pill,
          backgroundColor: theme.colors.surfaceStrong,
        }}
      >
        <Icon size={appTheme.icon.sm} color={theme.colors.primary} />
      </View>
      <View style={{ minWidth: 0, flex: 1 }}>
        <Text numberOfLines={2} style={{ color: theme.colors.text, fontSize: 15, fontWeight: '800' }}>{entity.label}</Text>
        <Text numberOfLines={1} style={{ marginTop: 1, color: theme.colors.muted, fontSize: 13 }}>
          {`${searchEntityKindLabel(entity.kind)} · ${searchEntityCountLabel(entity)}`}
        </Text>
      </View>
    </Pressable>
  );
}

function CreatorStarterRow({ creator, onOpen }: { creator: SearchStarterCreator; onOpen: () => void }) {
  const theme = useAppTheme();
  const name = creator.displayName.toLowerCase() === creator.username.toLowerCase() ? `@${creator.username}` : `${creator.displayName}, @${creator.username}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${creator.publicPostCount} ${creator.publicPostCount === 1 ? 'post' : 'posts'}. Open profile`}
      testID="search-starter-creator"
      // Their page is read once the finger has rested here, as on every creator row.
      {...creatorProfilePress(creator.username, onOpen)}
      style={({ pressed }) => ({
        minHeight: 52,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        opacity: pressed ? appTheme.opacity.pressed : 1,
        paddingVertical: 6,
      })}
    >
      <CreatorAvatar uri={creator.avatarUrl} name={creator.displayName} size={36} />
      <View style={{ minWidth: 0, flex: 1 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 15, fontWeight: '800' }}>{creator.displayName}</Text>
        <Text numberOfLines={1} style={{ marginTop: 1, color: theme.colors.muted, fontSize: 13 }}>
          {`@${creator.username} · ${creator.publicPostCount} ${creator.publicPostCount === 1 ? 'post' : 'posts'}`}
        </Text>
      </View>
    </Pressable>
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
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
        opacity: pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: 14,
      })}
    >
      <Search size={appTheme.icon.xs} color={theme.colors.muted} />
      <Text style={{ color: theme.colors.text, fontSize: 14, fontWeight: '700' }}>{search.text}</Text>
    </Pressable>
  );
}

/**
 * The starter content of the search screen (search UX audit 2026-11-13,
 * findings 2 and 8; `GET /api/search/starter`, rules in
 * `lib/public-search-policy/search-starter.ts`): popular models and tools,
 * creators to follow, and searches to try, each under its heading, in that
 * order; a list with nothing in it draws no heading. Drawn under the recent
 * searches before anything is typed, and under "No results" with `heading`
 * ("Try one of these instead") when a search finds nothing.
 */
export function SearchStarterSections({
  answer,
  heading = null,
  onEntity,
  onCreator,
  onSearch,
}: {
  answer: SearchStarterResponse;
  heading?: string | null;
  onEntity: (entity: SearchStarterEntity) => void;
  onCreator: (creator: SearchStarterCreator) => void;
  onSearch: (search: SearchStarterSearch) => void;
}) {
  const theme = useAppTheme();
  const sections = searchStarterSections(answer);
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
                <CreatorStarterRow key={creator.id} creator={creator} onOpen={() => onCreator(creator)} />
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
