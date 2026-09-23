import { useNavigation } from 'expo-router';
import { useEffect, useState } from 'react';

type TransitionListener = (event: { data?: { closing?: boolean } }) => void;
type Listen = (type: 'transitionStart' | 'transitionEnd' | 'gestureCancel', listener: TransitionListener) => () => void;

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
  useEffect(() => {
    const listen = navigation.addListener as unknown as Listen;
    const unsubscribers = [
      listen('transitionStart', (event) => setLeaving(event.data?.closing === true)),
      listen('transitionEnd', (event) => {
        if (event.data?.closing === false) setLeaving(false);
      }),
      listen('gestureCancel', () => setLeaving(false)),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [navigation]);
  return leaving;
}
