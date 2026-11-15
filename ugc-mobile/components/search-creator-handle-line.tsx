import { Text, View } from 'react-native';

import { useAppTheme } from '@/lib/theme-context';

// The dot between a creator's handle and their count, and the room either side of it.
const META_DOT_SIZE = 3;
const META_GAP = 15;

/**
 * A creator's handle and post count under their name, on a row of search (a
 * result's or the start's). The handle keeps its room: the count stands beside
 * it where both fit and goes to a line of its own where they do not, as on a
 * 320 pt screen beside Follow, rather than squeezing the handle to an ellipsis
 * that no longer tells two creators of one name apart (review of #828, S9).
 * The dot between them is drawn in the gap, before the count: a count that has
 * gone to the next line starts at the line's edge, and the line clips the dot
 * there. Two texts and a drawn dot, so each text reads in the row's label as
 * it is drawn.
 */
export function SearchCreatorHandleLine({ username, postCount }: { username: string; postCount: number }) {
  const theme = useAppTheme();
  return (
    <View
      testID="search-creator-handle-line"
      style={{ marginTop: 2, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: META_GAP, overflow: 'hidden' }}
    >
      <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.muted, fontSize: 13 }}>@{username}</Text>
      <View style={{ justifyContent: 'center' }}>
        <View
          style={{
            position: 'absolute',
            left: -(META_GAP + META_DOT_SIZE) / 2,
            width: META_DOT_SIZE,
            height: META_DOT_SIZE,
            borderRadius: META_DOT_SIZE / 2,
            backgroundColor: theme.colors.faint,
          }}
        />
        <Text numberOfLines={1} style={{ color: theme.colors.muted, fontSize: 13 }}>
          {`${postCount} ${postCount === 1 ? 'post' : 'posts'}`}
        </Text>
      </View>
    </View>
  );
}
