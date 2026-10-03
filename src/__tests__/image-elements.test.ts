import { describe, expect, it } from 'vitest';

import {
  assignElementHandles,
  createElementHandleReplacementMap,
  replacePromptHandles,
} from '@/lib/image-elements';

type Element = { id: string; displayName: string; handle: string };
type Seed = { id: string; displayName: string; handle: string | null };

function handles(elements: Array<{ handle: string }>) {
  return elements.map((element) => element.handle);
}

/** What a creator page does on a rename: the renamed element gives up its handle. */
function rename(elements: Element[], id: string, displayName: string): Element[] {
  return assignElementHandles<Seed>(elements.map((element) => (
    element.id === id ? { ...element, displayName, handle: null } : element
  )));
}

/** What a reload does: the saved names and handles come back, and nothing else. */
function reload(elements: Element[]): Element[] {
  return assignElementHandles(elements.map(({ id, displayName, handle }) => ({ id, displayName, handle })));
}

describe('assignElementHandles', () => {
  it('builds a handle from the name of an element that has none', () => {
    const elements = assignElementHandles([
      { id: 'a', displayName: 'Red jacket' },
      { id: 'b', displayName: '  Élan — Paris 2026!  ' },
      { id: 'c', displayName: '???' },
    ]);

    expect(elements).toEqual([
      { id: 'a', displayName: 'Red jacket', handle: '@red_jacket' },
      // The name is trimmed. Only a to z and the digits reach the handle.
      { id: 'b', displayName: 'Élan — Paris 2026!', handle: '@lan_paris_2026' },
      { id: 'c', displayName: '???', handle: '@element' },
    ]);
  });

  it('names an element that has no name by its place in the list', () => {
    expect(assignElementHandles([{ id: 'a' }, { id: 'b', displayName: '   ' }, { id: 'c', displayName: null }])).toEqual([
      { id: 'a', displayName: 'Element 1', handle: '@element_1' },
      { id: 'b', displayName: 'Element 2', handle: '@element_2' },
      { id: 'c', displayName: 'Element 3', handle: '@element_3' },
    ]);
  });

  it('numbers the later of two elements that share a name', () => {
    expect(handles(assignElementHandles([
      { displayName: 'Jacket' },
      { displayName: 'jacket' },
      { displayName: 'Coat' },
      { displayName: 'JACKET!' },
    ]))).toEqual(['@jacket', '@jacket_2', '@coat', '@jacket_4']);
  });

  describe('a rename', () => {
    const start = assignElementHandles([
      { id: 'a', displayName: 'Element 1' },
      { id: 'b', displayName: 'Element 2' },
    ]);

    it('gives the element the handle of its new name', () => {
      const renamed = rename(start, 'a', 'Red jacket');

      expect(renamed).toEqual([
        { id: 'a', displayName: 'Red jacket', handle: '@red_jacket' },
        { id: 'b', displayName: 'Element 2', handle: '@element_2' },
      ]);
    });

    it('lets the mentions in the prompt follow it', () => {
      const renamed = rename(start, 'a', 'Red jacket');
      const replacements = createElementHandleReplacementMap(start, renamed);

      expect(Array.from(replacements)).toEqual([['@element_1', '@red_jacket']]);
      expect(replacePromptHandles('@element_1 beside @element_2, then @element_1.', replacements))
        .toBe('@red_jacket beside @element_2, then @red_jacket.');
      // A longer handle that only starts the same way is another element's.
      expect(replacePromptHandles('@element_10 and @element_1', replacements)).toBe('@element_10 and @red_jacket');
    });

    it('changes nothing when the new name gives the handle the element already has', () => {
      const renamed = rename(start, 'a', 'ELEMENT 1!');

      expect(handles(renamed)).toEqual(['@element_1', '@element_2']);
      expect(createElementHandleReplacementMap(start, renamed).size).toBe(0);
    });

    it('leaves every other handle alone, even one the rename frees up', () => {
      const twins = assignElementHandles([
        { id: 'a', displayName: 'Dancer' },
        { id: 'b', displayName: 'Dancer' },
      ]);
      expect(handles(twins)).toEqual(['@dancer', '@dancer_2']);

      // "@dancer" is free now. The prompt mentions the second one as "@dancer_2", so it stays.
      const renamed = rename(twins, 'a', 'Red jacket');

      expect(handles(renamed)).toEqual(['@red_jacket', '@dancer_2']);
      expect(Array.from(createElementHandleReplacementMap(twins, renamed))).toEqual([['@dancer', '@red_jacket']]);
    });

    it('never gives the renamed element a handle that another element holds', () => {
      // Renamed to the second one's name: an earlier element does not take a later one's handle.
      const renamed = rename(start, 'a', 'Element 2');

      expect(handles(renamed)).toEqual(['@element_2_2', '@element_2']);
      expect(Array.from(createElementHandleReplacementMap(start, renamed))).toEqual([['@element_1', '@element_2_2']]);
    });
  });

  describe('a remix', () => {
    // The handles the remixed prompt was written with. Neither is the handle its
    // element's name would give ("@hero_shot", "@umbrella").
    const restored = assignElementHandles([
      { id: 'a', displayName: 'Hero shot', handle: '@lead' },
      { id: 'b', displayName: 'Umbrella', handle: '@prop' },
    ]);

    it('keeps the handles it restored, whatever the names would give', () => {
      expect(handles(restored)).toEqual(['@lead', '@prop']);
    });

    it('keeps a restored handle while other elements are added, renamed and removed', () => {
      const added = assignElementHandles([...restored, { id: 'c', displayName: 'Lead' }, { id: 'd', displayName: 'Prop' }]);
      // A new element named like a restored handle takes a numbered one.
      expect(handles(added)).toEqual(['@lead', '@prop', '@lead_3', '@prop_4']);

      const renamed = rename(added, 'b', 'Lead');
      expect(handles(renamed)).toEqual(['@lead', '@lead_2', '@lead_3', '@prop_4']);

      const removed = assignElementHandles(renamed.filter((element) => element.id !== 'b' && element.id !== 'c'));
      expect(removed).toEqual([
        { id: 'a', displayName: 'Hero shot', handle: '@lead' },
        { id: 'd', displayName: 'Prop', handle: '@prop_4' },
      ]);
    });

    it('gives a restored element the handle of its new name once it is renamed', () => {
      const renamed = rename(restored, 'a', 'Captain');

      expect(handles(renamed)).toEqual(['@captain', '@prop']);
      expect(replacePromptHandles('@lead walks past @prop', createElementHandleReplacementMap(restored, renamed)))
        .toBe('@captain walks past @prop');
    });

    it('builds a handle in place of a restored one that cannot be used', () => {
      expect(handles(assignElementHandles([
        { displayName: 'Hero shot', handle: '@Lead' },
        { displayName: 'Umbrella', handle: 'prop' },
        { displayName: 'Harbour', handle: '' },
        { displayName: 'Boat', handle: '@harbour' },
        // The second of two equal handles: the first one keeps it.
        { displayName: 'Dinghy', handle: '@harbour' },
      ]))).toEqual(['@hero_shot', '@umbrella', '@harbour_3', '@harbour', '@dinghy']);
    });
  });

  describe('a reload', () => {
    it('shows the handles that were saved, through every change a creator can make', () => {
      let elements = assignElementHandles([
        { id: 'a', displayName: 'Element 1' },
        { id: 'b', displayName: 'Element 2' },
        { id: 'c', displayName: 'Element 3' },
      ]);
      const steps: Array<[string, (current: Element[]) => Element[]]> = [
        ['rename', (current) => rename(current, 'a', 'Dancer')],
        ['rename to a name in use', (current) => rename(current, 'c', 'Dancer')],
        ['remove the first of the two', (current) => assignElementHandles(current.filter((element) => element.id !== 'a'))],
        // The page names a new upload by its place in the list.
        ['add', (current) => assignElementHandles([...current, { id: 'd', displayName: `Element ${current.length + 1}` }])],
        ['rename the first to the last one\'s name', (current) => rename(current, 'b', 'Element 3')],
        ['remove the middle one', (current) => assignElementHandles(current.filter((element) => element.id !== 'c'))],
      ];

      for (const [step, apply] of steps) {
        const before = elements;
        elements = apply(elements);

        // A reload changes no handle.
        expect(handles(reload(elements)), step).toEqual(handles(elements));
        // And the step changed only the handle of the element it renamed.
        const changed = elements.filter((element) => {
          const previous = before.find((candidate) => candidate.id === element.id);
          return previous && previous.handle !== element.handle;
        });
        expect(changed.every((element) => (
          before.find((candidate) => candidate.id === element.id)?.displayName !== element.displayName
        )), step).toBe(true);
        expect(new Set(handles(elements)).size, step).toBe(elements.length);
      }

      expect(elements).toEqual([
        { id: 'b', displayName: 'Element 3', handle: '@element_3_2' },
        { id: 'd', displayName: 'Element 3', handle: '@element_3' },
      ]);
    });

    it('builds the handles of elements saved before handles were kept from their names', () => {
      expect(handles(assignElementHandles([
        { id: 'a', displayName: 'Red jacket', handle: null },
        { id: 'b', displayName: 'Red jacket', handle: null },
      ]))).toEqual(['@red_jacket', '@red_jacket_2']);
    });
  });
});
