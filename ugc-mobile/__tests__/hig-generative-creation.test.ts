import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatCreditCost, withCreditCost } from '../lib/generation-action-label';
import {
  formatElapsed,
  generationWaitDetail,
  generationWaitPhase,
  generationWaitTitle,
} from '../lib/generation-wait';

/**
 * S9's rules, in the form a suite can hold. Sources: Generative AI, Entering
 * data, Progress indicators, Undo and redo, Machine learning.
 */

const mobileRoot = path.resolve(__dirname, '..');
const screen = readFileSync(path.join(mobileRoot, 'components/media-creation-screen.tsx'), 'utf8');

/** Slices one top-level declaration out of the screen, so a sweep of "the
 *  workspace" cannot silently be a sweep of everything after it. */
function declaration(start: string, end: string) {
  const from = screen.indexOf(start);
  const to = screen.indexOf(end, from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return screen.slice(from, to);
}

/** The workspace is the modal that owns the wait, the failure and the result. */
const workspace = declaration('function GenerationWorkspace(', 'const GUIDED_PROMPTS');

describe('S9 — every route to a paid generation states the price', () => {
  // Generative AI: "Consider consequences and get permission before performing
  // irreversible or potentially problematic tasks ... ask for confirmation
  // before performing a significant action on someone's behalf."
  it('counts credits in words, and gets one credit right', () => {
    expect(formatCreditCost(8)).toBe('8 credits');
    expect(formatCreditCost(1)).toBe('1 credit');
    expect(formatCreditCost(0)).toBe('0 credits');
    expect(withCreditCost('Generate', 8)).toBe('Generate · 8 credits');
    expect(withCreditCost('Try again', 1)).toBe('Try again · 1 credit');
  });

  it('falls back to the bare verb rather than inventing a price', () => {
    expect(withCreditCost('Generate', null)).toBe('Generate');
    expect(withCreditCost('Generate', undefined)).toBe('Generate');
    expect(withCreditCost('Generate', Number.NaN)).toBe('Generate');
  });

  it('prices the two controls in the workspace that spend credits', () => {
    expect(workspace).toContain("withCreditCost('Try again', retryCost)");
    expect(workspace).toContain("withCreditCost('Generate again', retryCost)");
    // The bare verbs are what this unit removed; they must not come back.
    expect(workspace).not.toContain('label="Retry"');
    expect(workspace).not.toContain("label='Retry'");
  });

  it('prices the composer button from the same helper', () => {
    const bar = declaration('function CreatorPersistentBar(', 'function SearchableModelPickerModal(');
    expect(bar).toContain("withCreditCost('Generate', cost ?? 0)");
    expect(bar).not.toContain('credits`');
  });

  it('never quotes a price the quote has not settled', () => {
    const passes = screen.match(/retryCost=\{[^}]+\}/g) ?? [];
    expect(passes.length).toBe(2);
    for (const pass of passes) {
      expect(pass).toBe("retryCost={activeQuote.status === 'ready' ? activeQuote.cost : null}");
    }
  });
});

describe('S9 — the wait says what is happening and how long it has been', () => {
  // Progress indicators: "Avoid vague terms like loading or authenticating
  // because they seldom add value." Generative AI: "instead of 'Processing…',
  // say 'Finding substitutions for ingredients'."
  it('separates queued from running', () => {
    expect(generationWaitPhase('processing')).toBe('running');
    expect(generationWaitPhase('waiting')).toBe('queued');
    expect(generationWaitPhase(null)).toBe('queued');
    expect(generationWaitPhase(undefined)).toBe('queued');
    expect(generationWaitTitle('running', 'image')).toBe('Making your image');
    expect(generationWaitTitle('queued', 'motion video')).toBe('Queued with the model');
  });

  it('reports elapsed time as a clock, uncapped', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(9)).toBe('0:09');
    expect(formatElapsed(95)).toBe('1:35');
    expect(formatElapsed(3725)).toBe('62:05');
    expect(formatElapsed(-4)).toBe('0:00');
  });

  it('says the phase with or without a clock', () => {
    expect(generationWaitDetail('running', 45)).toBe('The model is working on it now. Running for 0:45.');
    expect(generationWaitDetail('queued', null)).toBe('Waiting for the model to pick it up.');
  });

  it('leaves no vague status string behind in the workspace', () => {
    expect(workspace).not.toContain("'Generating'");
    expect(workspace).toContain('{waitTitle}');
    expect(workspace).toContain('{waitDetail}');
  });

  it('announces the detail rather than the raw provider status', () => {
    expect(workspace).toContain('accessibilityValue={{ text: waitDetail }}');
    expect(workspace).not.toContain("accessibilityValue={{ text: status?.status ?? 'starting' }}");
    expect(workspace).toContain('accessibilityLiveRegion="polite"');
  });

  it('runs the clock only while the run is live, from when it started', () => {
    // Minimizing and returning must not restart it, so the stamp is taken in
    // generate() rather than when the modal becomes visible.
    expect(screen).toContain('setGenerationStartedAt(Date.now());');
    expect(workspace).toContain('const waiting = visible && !succeeded && !failed && !pollingInterrupted;');
    expect(workspace).toContain('useGenerationElapsedSeconds(waiting ? startedAt : null)');
    const hook = screen.slice(screen.indexOf('function useGenerationElapsedSeconds('));
    expect(hook).toContain('clearInterval(timer)');
  });

  it('hands the workspace a start time at both call sites', () => {
    expect((screen.match(/startedAt=\{generationStartedAt\}/g) ?? []).length).toBe(2);
  });
});

describe('S9 — the result offers the control the chapter asks for', () => {
  // Generative AI: "Make it easy for people to refine or revert generated
  // results ... surfacing controls like Edit, Undo, Retry, or Adjust near
  // generated content preserves people's agency."
  it('can run the same draft again without leaving the result', () => {
    const success = workspace.slice(workspace.indexOf('succeeded && outputUrl'), workspace.indexOf('pollingInterrupted ? ('));
    expect(success).toContain("withCreditCost('Generate again', retryCost)");
    expect(success).toContain('onPress={onRetry}');
  });

  it('names the way back to the composer the same on success and failure', () => {
    // The identical action — close the workspace, keep the draft — was called
    // "Create another" on one panel and "Back to creator" on the other.
    expect(workspace).not.toContain('Create another');
    expect((workspace.match(/label="Back to creator"/g) ?? []).length).toBe(3);
  });
});

describe('S9 — one requirement, one voice', () => {
  // Entering data: "Be clear about the data you need"; the blocker stated the
  // condition while pressing Generate restated it as an instruction.
  it('routes the blocker through the same mapper the Generate press uses', () => {
    const mapped = screen.match(/promptValidationMessage\(visibleValidationError\)/g) ?? [];
    expect(mapped.length).toBe(2);
    expect(screen).not.toMatch(/\?\? visibleValidationError\) \?\? null;/);
  });

  it('keeps the mapper the single place a raw validation string is softened', () => {
    expect(screen).toContain("if (error === 'Prompt is required.') return 'Add a prompt before generating.';");
  });
});
