/**
 * Test double for `react-native-gesture-handler`. Its entry imports
 * react-native/index.js, whose Flow syntax vitest cannot parse. The app draws
 * its scroll view for the rows on a pager page (`components/pager-row-scroll-view.tsx`),
 * which only decides who takes a drag on Android, and no unit test can see
 * that: under test it is the suite's own React Native ScrollView, whatever
 * the suite's `vi.mock('react-native')` makes of it. Aliased globally in
 * vitest.config.ts.
 */
export { ScrollView } from 'react-native';
