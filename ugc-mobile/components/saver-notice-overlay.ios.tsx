/**
 * On iOS the saver notice is drawn in react-native-screens' full-window
 * overlay, above every presented Modal, so nothing in the app can cover it
 * while it counts down (`saver-notice-bar.tsx`). Already in the binary: the
 * library is a native dependency the app ships with.
 */
export { FullWindowOverlay as SaverNoticeOverlay } from 'react-native-screens';
