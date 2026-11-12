import { Box, Search, Wrench } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { CreatorAvatar } from '@/components/ui';
import { creatorProfilePress } from '@/lib/creator-profile-opening';
import { searchEntityCountLabel, searchEntityKindLabel } from '@/lib/public-search-policy/public-search-policy';
import {
  SEARCH_TYPEAHEAD_LIST_LABEL,
  searchTypeaheadRowLabel,
  type SearchTypeaheadRow,
  type SearchTypeaheadSection,
} from '@/lib/public-search-policy/search-typeahead';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

// A row's leading mark, the size of a creator's avatar beside it.
const MARK_SIZE = 36;

function RowMark({ row }: { row: SearchTypeaheadRow }) {
  const theme = useAppTheme();
  if (row.kind === 'creator') {
    return <CreatorAvatar uri={row.creator.avatarUrl} name={row.creator.displayName} size={MARK_SIZE} />;
  }
  const Icon = row.kind === 'completion' ? Search : row.entity.kind === 'model' ? Box : Wrench;
  return (
    <View
      style={{
        width: MARK_SIZE,
        height: MARK_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: appTheme.radii.pill,
        backgroundColor: theme.colors.surfaceStrong,
      }}
    >
      <Icon size={appTheme.icon.sm} color={row.kind === 'entity' ? theme.colors.primary : theme.colors.muted} />
    </View>
  );
}

function RowWords({ row }: { row: SearchTypeaheadRow }) {
  const theme = useAppTheme();
  const title = row.kind === 'creator' ? row.creator.displayName : row.kind === 'entity' ? row.entity.label : row.text;
  const detail = row.kind === 'creator'
    ? `@${row.creator.username}${row.creator.isFollowing ? ' · Following' : ''}`
    : row.kind === 'entity'
      ? `${searchEntityKindLabel(row.entity.kind)} · ${searchEntityCountLabel(row.entity)}`
      : null;
  return (
    <View style={{ minWidth: 0, flex: 1 }}>
      <Text
        numberOfLines={1}
        style={{ color: theme.colors.text, fontSize: 15, fontWeight: row.kind === 'completion' ? '600' : '800' }}
      >
        {title}
      </Text>
      {detail ? <Text numberOfLines={1} style={{ marginTop: 1, color: theme.colors.muted, fontSize: 13 }}>{detail}</Text> : null}
    </View>
  );
}

/**
 * What the search field offers while a person types: creators, then models
 * and tools, then completions, as one quiet panel above the results. Each row
 * is a button a thumb can press (44pt and more) that says what it does; the
 * list it sits in keeps the keyboard up for the press
 * (`keyboardShouldPersistTaps` on the overlay's scroll view), so a row is
 * chosen in one tap.
 */
export function SearchTypeaheadList({
  sections,
  onPick,
}: {
  sections: readonly SearchTypeaheadSection[];
  onPick: (row: SearchTypeaheadRow) => void;
}) {
  const theme = useAppTheme();
  return (
    <View
      accessibilityLabel={SEARCH_TYPEAHEAD_LIST_LABEL}
      testID="search-typeahead-list"
      style={{
        borderRadius: appTheme.radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.surface,
        paddingVertical: 6,
      }}
    >
      {sections.map((section) => (
        <View key={section.id}>
          <Text
            accessibilityRole="header"
            style={{
              color: theme.colors.muted,
              fontSize: 12,
              fontWeight: '800',
              letterSpacing: 0.6,
              paddingHorizontal: 13,
              paddingTop: 8,
              paddingBottom: 2,
              textTransform: 'uppercase',
            }}
          >
            {section.heading}
          </Text>
          {section.rows.map((row) => (
            <Pressable
              key={row.key}
              accessibilityRole="button"
              accessibilityLabel={searchTypeaheadRowLabel(row)}
              testID={`search-typeahead-${row.kind}`}
              // A creator's page is read once the finger has rested on their row,
              // as on a found creator's (`creatorProfilePress`).
              {...(row.kind === 'creator'
                ? creatorProfilePress(row.creator.username, () => onPick(row))
                : { onPress: () => onPick(row) })}
              style={({ pressed }) => ({
                minHeight: 52,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                opacity: pressed ? appTheme.opacity.pressed : 1,
                paddingHorizontal: 13,
                paddingVertical: 6,
              })}
            >
              <RowMark row={row} />
              <RowWords row={row} />
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}
