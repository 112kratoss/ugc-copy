import { useNavigation } from 'expo-router';
import { useEffect, useState } from 'react';

type TransitionEvent = 'transitionStart' | 'transitionEnd' | 'gestureCancel';
type TransitionListener = (event: { data?: { closing?: boolean } }) => void;
/** A screen's navigation object, as far as listening to it goes. */
type ScreenNavigation = { addListener: (...args: never[]) => unknown };

/**
 * Listens for one of the events native-stack sends a screen about its
 * transitions. Expo Router types `useNavigation()` with the events every
 * navigator sends, and these three are native-stack's own. Returns the
 * unsubscribe.
 */
export function listenToTransition(navigation: ScreenNavigation, type: TransitionEvent, listener: TransitionListener) {
  const transitions = navigation as unknown as { addListener: (type: TransitionEvent, listener: TransitionListener) => () => void };
  return transitions.addListener(type, listener);
}

/**
 * Tells `onChange` whether the screen is leaving (`useScreenLeaving`) at each
 * transition event that can change the answer. Returns the unsubscribe.
 */
export function listenForScreenLeaving(navigation: ScreenNavigation, onChange: (leaving: boolean) => void) {
  const unsubscribers = [
    listenToTransition(navigation, 'transitionStart', (event) => onChange(event.data?.closing === true)),
    listenToTransition(navigation, 'transitionEnd', (event) => {
      if (event.data?.closing === false) onChange(false);
    }),
    listenToTransition(navigation, 'gestureCancel', () => onChange(false)),
  ];
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

/**
 * Whether this screen has started to go off screen and has not come back.
 *
 * Native-stack says a screen is about to disappear (`transitionStart` with
 * `closing: true`) as its transition begins: on Back, and as soon as a back
 * swipe or a zoom's drag starts. The screen leaves navigation state only once
 * that transition is over, which after a back swipe on the iPhone 16e came up
 * to a second after the finger lifted. A swipe let go of before it commits
 * brings the screen back (`transitionStart` with `closing: false`, or
 * `gestureCancel`); a transition that finishes leaving keeps it gone.
 */
export function useScreenLeaving() {
  const navigation = useNavigation();
  const [leaving, setLeaving] = useState(false);
  useEffect(() => listenForScreenLeaving(navigation, setLeaving), [navigation]);
  return leaving;
}
