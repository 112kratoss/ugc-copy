import { Platform, ScrollView, type ScrollViewProps } from 'react-native';
import { ScrollView as GestureScrollView } from 'react-native-gesture-handler';

/**
 * A sideways row on a page of a sideways pager: the rows of references,
 * outputs and output picks on the Details page, which sits in the viewer's
 * pager and the post screen's.
 *
 * On Android the pager is asked about each move before the row is, so it took
 * every sideways drag that began on a row, and the row never moved (Pixel 9a,
 * 2026-10-29). Gesture handler's scroll view is settled at its root, which
 * reads each move before the views do: the row takes a sideways drag at the
 * same move the pager would have, and an upright drag still scrolls the page.
 *
 * React Native's own answer, `nestedScrollEnabled`, is not enough, so it is
 * not set here. The pager then skips the first touch of a drag over the row
 * and keeps the start point of the drag before it. After the page had been
 * scrolled, it measured the next drag on the row from that old point and took
 * it on its first move: every first drag after a scroll was lost.
 *
 * iOS already gives the drag to the row, and gesture handler's scroll view
 * would hold back the touch on its tiles there (`delaysContentTouches`), so
 * iOS keeps React Native's scroll view.
 */
export function PagerRowScrollView(props: Omit<ScrollViewProps, 'horizontal'>) {
  return Platform.OS === 'android'
    ? <GestureScrollView {...props} horizontal keyboardShouldPersistTaps={props.keyboardShouldPersistTaps ?? 'handled'} />
    : <ScrollView {...props} horizontal keyboardShouldPersistTaps={props.keyboardShouldPersistTaps ?? 'handled'} />;
}
