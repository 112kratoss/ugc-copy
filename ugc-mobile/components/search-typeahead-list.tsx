import { Box, Clock3, Search, Wrench } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { SearchRowPicture } from '@/components/search-row-picture';
import { CreatorAvatar } from '@/components/ui';
import { creatorProfilePress } from '@/lib/creator-profile-opening';
import { searchTypeaheadEntityWords } from '@/lib/search-screen-view-model';
import {
  SEARCH_TYPEAHEAD_LIST_LABEL,
  searchForRowLabel,
  searchTypeaheadQuery,
  searchTypeaheadRowLabel,
  searchTypeaheadTextRuns,
  type SearchTypeaheadRow,
  type SearchTypingSection,
} from '@/lib/public-search-policy/search-typeahead';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

const NO_ROWS: readonly string[] = [];

// A row's leading mark, the size of a creator's avatar beside it.
const MARK_SIZE = 36;

function RowMark({ row }: { row: SearchTypeaheadRow }) {
  const theme = useAppTheme();
  if (row.kind === 'creator') {
    return <CreatorAvatar uri={row.creator.avatarUrl} name={row.creator.displayName} size={MARK_SIZE} />;
  }
  if (row.kind === 'entity') {
    // A post made with it, where the answer has one; its kind's glyph in the same frame otherwise.
    return <SearchRowPicture thumbnail={row.entity.thumbnail} size={MARK_SIZE} Icon={row.entity.kind === 'model' ? Box : Wrench} />;
  }
  const Icon = row.kind === 'completion' && row.recent ? Clock3 : Search;
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
      <Icon size={appTheme.icon.sm} color={theme.colors.muted} />
    </View>
  );
}

// A completion or a recent search with the part not yet typed emphasised and
// the part typed plain (searchTypeaheadTextRuns). The runs are one Text: the row's
// accessible name, set on its button, stays whole.
function TypedRuns({ text, query }: { text: string; query: string | null }) {
  const theme = useAppTheme();
  return (
    // Whole at every size: since 2026-11-15 a completion can be a phrase posts
    // wrote ("cinematic neon portrait"), which two lines cut at the largest
    // sizes. It wraps instead, up to running text's cap. Its key is its text,
    // so a row that wraps differently is another row to the press rule.
    <Text maxFontSizeMultiplier={appTheme.typeScale.body} style={{ color: theme.colors.text, fontSize: 15 }}>
      {searchTypeaheadTextRuns(text, query).map((run, index) => (
        <Text
          key={index}
          style={run.typed ? { color: theme.colors.textSecondary, fontWeight: '400' } : { color: theme.colors.text, fontWeight: '700' }}
        >
          {run.text}
        </Text>
      ))}
    </Text>
  );
}

function RowWords({ row, query }: { row: SearchTypeaheadRow; query: string | null }) {
  const theme = useAppTheme();
  if (row.kind === 'completion') {
    return (
      <View style={{ minWidth: 0, flex: 1 }}>
        <TypedRuns text={row.text} query={query} />
      </View>
    );
  }
  if (row.kind === 'search') {
    return (
      <View style={{ minWidth: 0, flex: 1 }}>
        {/* One line at every size: the row's text changes with each letter
            while its key stays, so a row that grew a line would move every
            row under it with no change the press rule sees (review of #786).
            Cut in the middle, so the start and the latest letters both show;
            its accessible name holds the whole text. */}
        <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: theme.colors.text, fontSize: 15, fontWeight: '700' }}>
          {searchForRowLabel(row.text)}
        </Text>
      </View>
    );
  }
  const title = row.kind === 'creator' ? row.creator.displayName : row.entity.label;
  // A model's or tool's name is drawn whole and plain of any "typed part": it
  // can differ from what was typed altogether ("sdxl" offers Stability AI). A
  // catalog model nobody has posted with says what pressing it does
  // ("Video model · Generate with it"), never "0 posts".
  const detail = row.kind === 'creator'
    ? `@${row.creator.username}${row.creator.isFollowing ? ' · Following' : ''}`
    : row.kind === 'entity'
      ? searchTypeaheadEntityWords(row.entity).detail
      : null;
  return (
    <View style={{ minWidth: 0, flex: 1 }}>
      <Text numberOfLines={row.kind === 'entity' ? 2 : 1} style={{ color: theme.colors.text, fontSize: 15, fontWeight: '800' }}>
        {title}
      </Text>
      {detail ? <Text numberOfLines={1} style={{ marginTop: 1, color: theme.colors.muted, fontSize: 13 }}>{detail}</Text> : null}
    </View>
  );
}

/**
 * What the search screen shows while a person types, in place of results
 * (`lib/search-typing-mode.ts`): "Search for “…”", the recent searches the
 * text begins, then creators, models and tools, and completions
 * (searchTypingSections), as one list under the tabs. Each row is a button a
 * thumb can press (44pt and more) that says what it does; the list it sits in
 * keeps the keyboard up for the press (`keyboardShouldPersistTaps` on the
 * overlay's scroll view), so a row is chosen in one tap.
 *
 * `busy` is the panel changing or just changed: its rows are the answer to the
 * text before this one, kept on show until this text's arrives so the panel
 * does not go and come back at every letter, or a row came to stand in a new
 * place a moment ago and takes no press yet. The panel says so, and its stale
 * rows look the same (a dim at every letter would be the flicker the keeping
 * avoids); a row that takes a press does what it shows.
 *
 * `settlingRows` are the keys of the rows that take no press yet: each is
 * drawn dimmed until it does (the theme's disabled strength), and shows no
 * press, since a press on it does nothing. Only the rows a change moved, so a panel whose answer leaves its
 * rows where they were does not change at all.
 */
export function SearchTypeaheadList({
  sections,
  query: text,
  busy = false,
  settlingRows = NO_ROWS,
  onPick,
}: {
  sections: readonly SearchTypingSection[];
  /** What the field holds: the part of a row already typed is drawn plain. */
  query: string;
  busy?: boolean;
  settlingRows?: readonly string[];
  onPick: (row: SearchTypeaheadRow) => void;
}) {
  const theme = useAppTheme();
  const query = searchTypeaheadQuery(text);
  return (
    <View
      accessibilityLabel={SEARCH_TYPEAHEAD_LIST_LABEL}
      accessibilityState={{ busy }}
      testID="search-typeahead-list"
      // The screen's own list, edge to edge in its margins, as the recent
      // searches under an empty field are: not a panel over something else.
      style={{ marginTop: -6 }}
    >
      {sections.map((section) => (
        <View key={section.id}>
          {section.heading === null ? null : <Text
            accessibilityRole="header"
            style={{
              color: theme.colors.muted,
              fontSize: 12,
              fontWeight: '800',
              letterSpacing: 0.6,
              paddingTop: 14,
              paddingBottom: 2,
              textTransform: 'uppercase',
            }}
          >
            {section.heading}
          </Text>}
          {section.rows.map((row) => {
            const settling = settlingRows.includes(row.key);
            return (
              <Pressable
                key={row.key}
                accessibilityRole="button"
                accessibilityLabel={row.kind === 'entity' ? searchTypeaheadEntityWords(row.entity).accessibilityLabel : searchTypeaheadRowLabel(row)}
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
                  // A row that takes no press yet is drawn as a control that is off, for that moment.
                  opacity: settling ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
                  paddingVertical: 6,
                })}
              >
                <RowMark row={row} />
                <RowWords row={row} query={query} />
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}
