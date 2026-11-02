import { useEffect, useMemo, useRef, useState } from 'react';
import type { TextInput, TextInputSelectionChangeEvent } from 'react-native';

import {
  findActiveReferenceMention,
  insertHandleAtSelection,
  normalizeTextSelection,
  type TextSelection,
} from '@/lib/reference-mentions';

/**
 * A creator's prompt field and its @ list: where the caret is, the mention being typed at it, and
 * putting a reference's handle in. The image and video composers each kept a copy of this until
 * 2026-11-02, and the copies had drifted.
 *
 * A mention is active while the field is focused and its caret sits at the end of an @handle
 * being typed (`findActiveReferenceMention`). An insert leaves the caret right after the handle
 * it put in, which reads as a mention being typed, so the list stays shut for that text and caret
 * until the creator types or moves the caret. The caret the insert puts back on the field
 * (`setNativeProps`) comes back as a selection change of its own, which is not the creator's and
 * leaves the list shut. A blur shuts the list 160 ms later.
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
  const restoringSelectionRef = useRef<TextSelection | null>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detectedMention = useMemo(
    () => enabled && focused ? findActiveReferenceMention(prompt, selection) : null,
    [enabled, focused, prompt, selection],
  );
  const mentionKey = detectedMention ? `${prompt}:${selection.start}:${selection.end}` : null;
  const activeMention = detectedMention && mentionKey !== dismissedMentionKey ? detectedMention : null;

  useEffect(() => {
    promptTextRef.current = prompt;
    const normalized = normalizeTextSelection(prompt, lastSelectionRef.current);
    if (normalized.start === lastSelectionRef.current.start && normalized.end === lastSelectionRef.current.end) return;
    lastSelectionRef.current = normalized;
    setSelection(normalized);
  }, [prompt]);

  useEffect(() => () => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
  }, []);

  useEffect(() => {
    onMentionStateChange(Boolean(activeMention));
    return () => onMentionStateChange(false);
  }, [activeMention, onMentionStateChange]);

  const clearBlurTimer = () => {
    if (!blurTimerRef.current) return;
    clearTimeout(blurTimerRef.current);
    blurTimerRef.current = null;
  };

  const restoreFocus = (delay: number) => {
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    focusTimerRef.current = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setNativeProps({ selection: lastSelectionRef.current });
      focusTimerRef.current = null;
    }, delay);
  };

  const insertReferenceHandle = (handle: string, at: TextSelection, focusDelay = 0) => {
    clearBlurTimer();
    const result = insertHandleAtSelection(promptTextRef.current, handle, at);
    promptTextRef.current = result.text;
    lastSelectionRef.current = result.selection;
    restoringSelectionRef.current = result.selection;
    setSelection(result.selection);
    setDismissedMentionKey(`${result.text}:${result.selection.start}:${result.selection.end}`);
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
        promptTextRef.current = text;
        onPromptChange(text);
      },
      onSelectionChange: (event: TextInputSelectionChangeEvent) => {
        const next = normalizeTextSelection(promptTextRef.current, event.nativeEvent.selection);
        const restored = restoringSelectionRef.current?.start === next.start && restoringSelectionRef.current.end === next.end;
        lastSelectionRef.current = next;
        setSelection(next);
        if (!restored) setDismissedMentionKey(null);
        if (restored) restoringSelectionRef.current = null;
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
    /** Puts a handle in over `at` (a row of the @ list: the mention being typed) and focuses the field again after `focusDelay` ms. */
    insertReferenceHandle,
    /** Puts a handle in at the field's last caret, as a reference's details sheet does from over the field. */
    insertReferenceHandleAtCaret: (handle: string, focusDelay = 0) => insertReferenceHandle(handle, lastSelectionRef.current, focusDelay),
  };
}
