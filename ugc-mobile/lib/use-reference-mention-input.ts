import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TextInput, TextInputSelectionChangeEvent } from 'react-native';

import {
  findActiveReferenceMention,
  insertHandleAtSelection,
  normalizeTextSelection,
  selectionAfterTextChange,
  type TextSelection,
} from '@/lib/reference-mentions';

/** The text and caret a dismissed @ list stays shut for. */
function mentionKeyFor(text: string, { start, end }: TextSelection) {
  return `${text}:${start}:${end}`;
}

function sameSelection(a: TextSelection, b: TextSelection) {
  return a.start === b.start && a.end === b.end;
}

/** The caret an insert puts back, and the stretch of the new text, from the handle's start, that a caret on its way there falls in. */
type PendingCaret = { caret: TextSelection; from: number; to: number };

/**
 * A creator's prompt field and its @ list: where the caret is, the mention being typed at it, and
 * putting a reference's handle in. The image and video composers each kept a copy of this until
 * 2026-11-02, and the copies had drifted.
 *
 * A mention is active while the field is focused and its caret sits at the end of an @handle
 * being typed (`findActiveReferenceMention`). An insert leaves the caret right after the handle
 * it put in, which reads as a mention being typed, so the list stays shut for that text and caret
 * until the creator types or moves the caret. An insert puts focus and that caret back on the
 * field, at once from the @ list and after the caller's delay from a sheet over the field, with the
 * field's own `setSelection`: `setNativeProps({ selection })` moved neither platform's caret
 * (Android's field has no such prop, and iOS's reads it only as the field joins a window), so on
 * Android the caret stayed where the text replacement left it, inside the handle. Android reports
 * that caret and then the one put back, and both fall in the handle's stretch of the text: a caret
 * there is the insert's, and leaves the list shut. iOS reports neither, so the wait for them ends at
 * the first caret outside that stretch, at the first keystroke, or at the next outside change.
 * A blur shuts the list 160 ms later.
 *
 * A prompt the field did not type (a saved draft arriving after the composer mounted, Enhance,
 * Undo, a rename) moves the caret with the words around it (`selectionAfterTextChange`), and puts
 * the field's own caret there too: iOS keeps its caret's distance from the end and Android moves its
 * caret in proportion, so the visible caret and the one an insert uses would part. The sync is a
 * layout effect, run in the commit's own task: as a passive effect it ran after later keystrokes on
 * the Pixel 9a and took the field's own text for an outside change.
 *
 * The field leaves without a blur when it stops being the prompt in use (`enabled`): it comes back
 * unfocused, with nothing of its own pending.
 *
 * An insert puts the handle in whether or not the prompt already names it: one prompt can name a
 * reference more than once ("@ali walks in, then @ali waves", #652).
 *
 * The field's ref comes back on its own, beside its handlers, as `useRailReveal`'s scroll ref does:
 * React Compiler treats whatever is passed as a `ref` as a ref, so reading the handlers off the
 * same object during render would make it skip the component.
 */
export function useReferenceMentionInput({
  prompt,
  enabled = true,
  onPromptChange,
  onFocus,
  onBlur,
  onMentionStateChange,
}: {
  /** The prompt the field shows. */
  prompt: string;
  /** False while the field is not the prompt in use (a video story writes its shots instead): no mention is active then. */
  enabled?: boolean;
  onPromptChange: (prompt: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  /** Told whether the @ list is open, and that it is not once the field's composer goes. */
  onMentionStateChange: (active: boolean) => void;
}) {
  const initialSelection = { start: prompt.length, end: prompt.length };
  const [selection, setSelection] = useState<TextSelection>(initialSelection);
  const [focused, setFocused] = useState(false);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);
  const promptTextRef = useRef(prompt);
  const lastSelectionRef = useRef<TextSelection>(initialSelection);
  const pendingCaretRef = useRef<PendingCaret | null>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detectedMention = useMemo(
    () => enabled && focused ? findActiveReferenceMention(prompt, selection) : null,
    [enabled, focused, prompt, selection],
  );
  const mentionKey = detectedMention ? mentionKeyFor(prompt, selection) : null;
  const activeMention = detectedMention && mentionKey !== dismissedMentionKey ? detectedMention : null;

  const clearBlurTimer = () => {
    if (!blurTimerRef.current) return;
    clearTimeout(blurTimerRef.current);
    blurTimerRef.current = null;
  };

  const clearFocusTimer = () => {
    if (!focusTimerRef.current) return;
    clearTimeout(focusTimerRef.current);
    focusTimerRef.current = null;
  };

  useLayoutEffect(() => {
    const fieldText = promptTextRef.current;
    promptTextRef.current = prompt;
    const outside = prompt !== fieldText;
    const next = outside
      ? selectionAfterTextChange(fieldText, prompt, lastSelectionRef.current)
      : normalizeTextSelection(prompt, lastSelectionRef.current);
    if (outside) {
      pendingCaretRef.current = null;
      inputRef.current?.setSelection(next.start, next.end);
    }
    if (sameSelection(lastSelectionRef.current, next)) return;
    lastSelectionRef.current = next;
    setSelection(next);
  }, [prompt]);

  useEffect(() => {
    if (enabled) return;
    clearBlurTimer();
    clearFocusTimer();
    pendingCaretRef.current = null;
    setFocused(false);
  }, [enabled]);

  useEffect(() => () => {
    clearBlurTimer();
    clearFocusTimer();
  }, []);

  useEffect(() => {
    onMentionStateChange(Boolean(activeMention));
    return () => onMentionStateChange(false);
  }, [activeMention, onMentionStateChange]);

  const restoreFocus = (delay: number) => {
    clearFocusTimer();
    focusTimerRef.current = setTimeout(() => {
      focusTimerRef.current = null;
      const field = inputRef.current;
      field?.focus();
      // Not over a caret the creator has put somewhere else meanwhile, or typed past.
      const pending = pendingCaretRef.current;
      if (pending) field?.setSelection(pending.caret.start, pending.caret.end);
    }, delay);
  };

  const insertAt = (handle: string, at: TextSelection, focusDelay: number) => {
    clearBlurTimer();
    const result = insertHandleAtSelection(promptTextRef.current, handle, at);
    promptTextRef.current = result.text;
    lastSelectionRef.current = result.selection;
    pendingCaretRef.current = { caret: result.selection, from: at.start, to: Math.max(at.end, result.selection.end) };
    setSelection(result.selection);
    setDismissedMentionKey(mentionKeyFor(result.text, result.selection));
    setFocused(true);
    onPromptChange(result.text);
    restoreFocus(focusDelay);
  };

  return {
    inputRef,
    /** For the field: what the creator types, where the caret goes, focus and blur. */
    inputProps: {
      onChangeText: (text: string) => {
        clearBlurTimer();
        setFocused(true);
        setDismissedMentionKey(null);
        pendingCaretRef.current = null;
        promptTextRef.current = text;
        onPromptChange(text);
      },
      onSelectionChange: (event: TextInputSelectionChangeEvent) => {
        const next = normalizeTextSelection(promptTextRef.current, event.nativeEvent.selection);
        lastSelectionRef.current = next;
        setSelection(next);
        const pending = pendingCaretRef.current;
        if (pending && next.start === next.end && next.start >= pending.from && next.start <= pending.to) {
          if (sameSelection(pending.caret, next)) pendingCaretRef.current = null;
          return;
        }
        pendingCaretRef.current = null;
        setDismissedMentionKey(null);
      },
      onFocus: () => {
        clearBlurTimer();
        setFocused(true);
        onFocus();
      },
      onBlur: () => {
        onBlur();
        clearBlurTimer();
        blurTimerRef.current = setTimeout(() => {
          setFocused(false);
          blurTimerRef.current = null;
        }, 160);
      },
    },
    /** The mention being typed at the caret, while the @ list is open for it. */
    activeMention,
    /** Puts a handle in place of the mention being typed: a row of the @ list. */
    insertHandleAtMention: (handle: string) => {
      if (activeMention) insertAt(handle, activeMention, 0);
    },
    /** Puts a handle in at the field's last caret, focusing it again after `focusDelay` ms: a sheet over the field. */
    insertHandleAtCaret: (handle: string, focusDelay: number) => insertAt(handle, lastSelectionRef.current, focusDelay),
  };
}
