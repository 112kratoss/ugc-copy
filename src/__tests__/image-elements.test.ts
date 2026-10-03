import { describe, expect, it } from 'vitest';

import {
  assignElementHandles,
  assignSubjectHandles,
  createElementHandleReplacementMap,
  extractPromptHandles,
  findUnknownPromptHandles,
  getMentionQueryAtCaret,
  insertHandleIntoPrompt,
  isValidElementHandle,
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

/**
 * A Kling O3 subject's handle kept the capitals of its name ("@Hero_creator",
 * 2026-10-03). No other handle has capitals, and the functions that read handles
 * out of a prompt read lower case only: the handle on the card was one no prompt
 * could mention, and the lower-case one was refused as unknown.
 *
 * It was also built from the subjects' names each time their cards were drawn,
 * so it moved when another subject was renamed or removed. A subject keeps its
 * handle now, by the rule assignElementHandles is tested for above. These are the
 * cases a subject has of its own, and the two faults that rule ends.
 */
describe('assignSubjectHandles', () => {
  function subjectHandles(names: string[]) {
    return handles(assignSubjectHandles(names.map((displayName) => ({ displayName }))));
  }

  it('writes a handle in lower case, with an underscore for all but letters and digits', () => {
    expect(subjectHandles(['Hero creator', 'Subject 2', '  Élan — Paris 2026!  ', 'MAIN_Product-v2']))
      .toEqual(['@hero_creator', '@subject_2', '@lan_paris_2026', '@main_product_v2']);
  });

  it('builds the handle an element card builds from the same name', () => {
    const names = ['Hero creator', 'Red JACKET', 'Élan — Paris 2026!', 'Hero creator'];

    expect(subjectHandles(names))
      .toEqual(handles(assignElementHandles(names.map((displayName) => ({ displayName })))));
  });

  it('builds only handles that the prompt is read for', () => {
    const built = subjectHandles(['Hero creator', 'Subject 1', 'HERO', '', 'नायक लाल रेनकोट में', 'X']);
    expect(built).toHaveLength(6);

    for (const handle of built) {
      expect(isValidElementHandle(handle), handle).toBe(true);

      // Mentioned in a prompt it is read whole, and it is not an unknown element.
      const prompt = `A scene with ${handle} walking, then ${handle}.`;
      expect(extractPromptHandles(prompt), handle).toEqual([handle]);
      expect(findUnknownPromptHandles(prompt, built), handle).toEqual([]);

      // While it is typed, each letter keeps the "@" panel open.
      for (let length = 1; length <= handle.length; length += 1) {
        const typed = `A scene with ${handle.slice(0, length)}`;
        expect(getMentionQueryAtCaret(typed, typed.length), typed).toEqual({
          query: handle.slice(1, length),
          replaceStart: 13,
          replaceEnd: typed.length,
        });
      }
    }
  });

  it('numbers the later of two subjects that give the same handle', () => {
    // Names that differ only by a capital are one handle, as they are to the server.
    expect(subjectHandles(['Hero', 'hero', 'Lead'])).toEqual(['@hero', '@hero_2', '@lead']);
    // The number starts at the subject's place on the card, as an element's does.
    expect(subjectHandles(['Hero', 'Lead', 'HERO!'])).toEqual(['@hero', '@lead', '@hero_3']);
    // A number that another subject's name already gives is passed over.
    expect(subjectHandles(['Hero 2', 'Hero', 'Hero'])).toEqual(['@hero_2', '@hero', '@hero_3']);
  });

  it('calls a subject by its place when its name has nothing a handle can hold', () => {
    expect(assignSubjectHandles([{ displayName: 'नायक लाल रेनकोट में' }, { displayName: '???' }])).toEqual([
      { displayName: 'नायक लाल रेनकोट में', handle: '@subject_1' },
      { displayName: '???', handle: '@subject_2' },
    ]);
    // Beside a subject that is named that, it is numbered like any other pair.
    expect(subjectHandles(['Subject 2', '???'])).toEqual(['@subject_2', '@subject_2_2']);
    // An element in the same case is "@element".
    expect(handles(assignElementHandles([{ displayName: '???' }]))).toEqual(['@element']);
  });

  it('names a subject that has no name by its place, as a new subject is named', () => {
    expect(assignSubjectHandles([{ id: 'a' }, { id: 'b', displayName: '   ' }, { id: 'c', displayName: null }])).toEqual([
      { id: 'a', displayName: 'Subject 1', handle: '@subject_1' },
      { id: 'b', displayName: 'Subject 2', handle: '@subject_2' },
      { id: 'c', displayName: 'Subject 3', handle: '@subject_3' },
    ]);
  });

  describe('two subjects with one name', () => {
    const twins = assignSubjectHandles([
      { id: 'a', displayName: 'Hero' },
      { id: 'b', displayName: 'Hero' },
    ]);

    it('leave the second its handle when the first is renamed, and the prompt follows the first', () => {
      const renamed = assignSubjectHandles<Seed>(twins.map((subject) => (
        subject.id === 'a' ? { ...subject, displayName: 'Villain', handle: null } : subject
      )));

      // "@hero" is free now. The prompt mentions the second one as "@hero_2", so it stays.
      expect(handles(renamed)).toEqual(['@villain', '@hero_2']);
      expect(replacePromptHandles('@hero hands the cup to @hero_2', createElementHandleReplacementMap(twins, renamed)))
        .toBe('@villain hands the cup to @hero_2');
    });

    it('leave the second its handle when the first is removed', () => {
      expect(assignSubjectHandles(twins.filter((subject) => subject.id !== 'a'))).toEqual([
        { id: 'b', displayName: 'Hero', handle: '@hero_2' },
      ]);
    });

    it('come back from a reload with the handles that were saved', () => {
      const saved = twins.filter((subject) => subject.id !== 'a').map(({ id, displayName, handle }) => ({ id, displayName, handle }));

      // Built from the name again it would be "@hero", the handle of the subject that is gone.
      expect(handles(assignSubjectHandles(saved))).toEqual(['@hero_2']);
    });

    it('take the handles of their names when they were saved before handles were kept', () => {
      expect(handles(assignSubjectHandles([
        { id: 'a', displayName: 'Hero', handle: null },
        { id: 'b', displayName: 'Hero' },
      ]))).toEqual(['@hero', '@hero_2']);
    });
  });
});

describe('extractPromptHandles', () => {
  it('reads each handle a prompt mentions once, in the order they come', () => {
    expect(extractPromptHandles('@lead walks past @prop_2, then (@lead) turns.\n@rival waits'))
      .toEqual(['@lead', '@prop_2', '@rival']);
  });

  it('reads no handle in an address or in a word that only contains "@"', () => {
    expect(extractPromptHandles('write to studio@example.com, or a@b')).toEqual([]);
  });

  it('reads no handle in a word with a capital, which is how a prompt names an account or a brand', () => {
    // A handle is lower case, so "@Nike" is left as the text it is. Read as a
    // handle it would be an unknown element, and prompts already saved in
    // templates and remixes would be refused for it.
    expect(extractPromptHandles('A runner in the style of @Nike, shot for @MrBeast')).toEqual([]);
    expect(findUnknownPromptHandles('A runner in the style of @Nike', ['@hero'])).toEqual([]);
  });
});

describe('getMentionQueryAtCaret', () => {
  it('reads the mention being typed at the caret', () => {
    expect(getMentionQueryAtCaret('A scene with @her', 17)).toEqual({ query: 'her', replaceStart: 13, replaceEnd: 17 });
    // "@" alone is a mention with nothing typed yet.
    expect(getMentionQueryAtCaret('@', 1)).toEqual({ query: '', replaceStart: 0, replaceEnd: 1 });
    // The caret can stand inside the prompt.
    expect(getMentionQueryAtCaret('Open on @her in the rain', 12)).toEqual({ query: 'her', replaceStart: 8, replaceEnd: 12 });
  });

  it('reads none where the caret is not at the end of a mention', () => {
    expect(getMentionQueryAtCaret('A scene with @hero walking', 26)).toBeNull();
    expect(getMentionQueryAtCaret('A scene with @her-', 18)).toBeNull();
    // An address is not a mention.
    expect(getMentionQueryAtCaret('write to studio@her', 19)).toBeNull();
  });

  it('reads a mention typed with capitals, as a name is', () => {
    // The panel this opens also finds a reference by its name, and "Hero creator"
    // starts with a capital. It shut at the "H".
    expect(getMentionQueryAtCaret('A scene with @H', 15)).toEqual({ query: 'H', replaceStart: 13, replaceEnd: 15 });
    expect(getMentionQueryAtCaret('A scene with @Hero_Creator', 26))
      .toEqual({ query: 'Hero_Creator', replaceStart: 13, replaceEnd: 26 });
  });

  it('lets the handle picked from the panel replace what was typed, capitals and all', () => {
    const typed = 'A scene with @Hero walking';
    const mention = getMentionQueryAtCaret(typed, 18);

    expect(insertHandleIntoPrompt(typed, '@hero_creator', 18, 18, mention))
      .toEqual({ prompt: 'A scene with @hero_creator walking', caretIndex: 26 });
  });
});
