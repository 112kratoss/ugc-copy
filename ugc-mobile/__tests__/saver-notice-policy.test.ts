import { describe, expect, it } from 'vitest';

import {
  SAVER_NOTICE_DURATION_MS,
  SAVER_NOTICE_MESSAGE,
  SAVER_NOTICE_STORAGE_KEY_PREFIX,
  SAVER_NOTICE_TAP_GUARD_MS,
  createSaverNoticePolicy,
  readStoredSaverNoticeMemory,
  saverNoticeStorageKey,
  type SaverNoticeMemory,
  type SaverNoticePlatform,
} from '@/lib/saver-notice-policy/saver-notice-policy';

/**
 * The policy the web and the app share, over a platform the test drives: what
 * the device would keep (`remembered`), the records it was asked to put on the
 * server (each answered by hand), and the notices it was asked to draw and take
 * down.
 */
function harness() {
  const remembered: Array<[string, SaverNoticeMemory | null]> = [];
  const records: Array<{ accountId: string; answer: (onRecord: boolean) => Promise<void> }> = [];
  const shown: string[] = [];
  const hidden: string[] = [];
  let drawable = true;

  const platform: SaverNoticePlatform = {
    remember(accountId, memory) {
      remembered.push([accountId, memory]);
    },
    record(accountId) {
      return new Promise<boolean>((resolve) => {
        records.push({
          accountId,
          answer: async (onRecord) => {
            resolve(onRecord);
            await settled();
          },
        });
      });
    },
    show(accountId) {
      if (!drawable) return false;
      shown.push(accountId);
      return true;
    },
    hide(accountId) {
      hidden.push(accountId);
    },
  };

  return {
    policy: createSaverNoticePolicy(platform),
    remembered,
    records,
    recordedFor: () => records.map(({ accountId }) => accountId),
    shown,
    hidden,
    setDrawable(value: boolean) {
      drawable = value;
    },
  };
}

/** Lets a record's answer reach the policy. */
async function settled() {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

const NOT_YET_TOLD = { saverNotYetTold: true };
const NAMES_SAVER = { creatorSeesSaver: true };

describe('the saver notice policy: what a save carries', () => {
  it("shows an untold account's first save the notice once, and tells the creator nothing of any save while it is up", () => {
    const { policy, shown } = harness();
    policy.setActiveAccount('user-1');

    expect(policy.fieldsForSave('user-1', true)).toEqual(NOT_YET_TOLD);
    // A save made while the notice is still up was not made after it.
    expect(policy.fieldsForSave('user-1', true)).toEqual(NOT_YET_TOLD);
    expect(shown).toEqual(['user-1']);
  });

  it('adds nothing to taking a save back, or to a save with no account, and shows nothing', () => {
    const { policy, shown } = harness();
    policy.setActiveAccount('user-1');

    expect(policy.fieldsForSave('user-1', false)).toEqual({});
    expect(policy.fieldsForSave(null, true)).toEqual({});
    expect(policy.fieldsForSave(undefined, true)).toEqual({});
    expect(shown).toEqual([]);
  });

  it('names the saver of an account told and on record, and asks the server nothing more', async () => {
    const { policy, records, shown } = harness();
    policy.restore('user-1', 'recorded');
    policy.setActiveAccount('user-1');
    await settled();

    expect(policy.fieldsForSave('user-1', true)).toEqual(NAMES_SAVER);
    expect(policy.fieldsForSave('user-1', false)).toEqual({});
    expect(records).toEqual([]);
    expect(shown).toEqual([]);
  });

  it('names the saver of an account told and not on record yet, and asks for the record again at that save', async () => {
    const { policy, recordedFor } = harness();
    policy.setActiveAccount('user-1');
    // Read back after the account was set: nothing has asked for its record yet.
    policy.restore('user-1', 'pending');
    expect(recordedFor()).toEqual([]);

    expect(policy.fieldsForSave('user-1', true)).toEqual(NAMES_SAVER);
    expect(recordedFor()).toEqual(['user-1']);
  });

  it('keeps the creator out while nothing can draw the notice, and tries to show it again at the next save', () => {
    const { policy, shown, setDrawable } = harness();
    policy.setActiveAccount('user-1');
    setDrawable(false);

    expect(policy.fieldsForSave('user-1', true)).toEqual(NOT_YET_TOLD);
    expect(shown).toEqual([]);

    setDrawable(true);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NOT_YET_TOLD);
    expect(shown).toEqual(['user-1']);
    // Up now: a further save draws nothing more.
    policy.fieldsForSave('user-1', true);
    expect(shown).toEqual(['user-1']);
  });
});

describe('the saver notice policy: how a notice ends', () => {
  it.each(['closed', 'expired'] as const)(
    'a notice %s was read: remembered as told, put on record for the signed-in account, then remembered as on record',
    async (ending) => {
      const { policy, records, recordedFor, remembered } = harness();
      policy.setActiveAccount('user-1');
      policy.fieldsForSave('user-1', true);

      policy.settle('user-1', ending);

      expect(remembered).toEqual([['user-1', 'pending']]);
      expect(recordedFor()).toEqual(['user-1']);
      // Told from here on, before the server has answered.
      expect(policy.fieldsForSave('user-1', true)).toEqual(NAMES_SAVER);

      await records[0].answer(true);
      expect(remembered).toEqual([['user-1', 'pending'], ['user-1', 'recorded']]);
      // On record: nothing more is asked.
      policy.retryRecord('user-1');
      policy.fieldsForSave('user-1', true);
      expect(recordedFor()).toEqual(['user-1']);
    },
  );

  it('counts a notice taken down unread (the app left) as nothing: the next save tells them again', () => {
    const { policy, records, remembered, shown } = harness();
    policy.setActiveAccount('user-1');
    policy.fieldsForSave('user-1', true);

    policy.settle('user-1', 'interrupted');

    expect(remembered).toEqual([]);
    expect(records).toEqual([]);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NOT_YET_TOLD);
    expect(shown).toEqual(['user-1', 'user-1']);
  });

  it('ignores the ending of a notice that is not up, and a second ending of one that was', () => {
    const { policy, recordedFor, remembered } = harness();
    policy.setActiveAccount('user-1');

    policy.settle('user-1', 'closed');
    expect(remembered).toEqual([]);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NOT_YET_TOLD);

    policy.settle('user-1', 'closed');
    policy.settle('user-1', 'expired');
    expect(remembered).toEqual([['user-1', 'pending']]);
    expect(recordedFor()).toEqual(['user-1']);
  });

  it('keeps a telling read before its account was set as signed in, and puts it on record once it is', () => {
    const { policy, recordedFor, remembered } = harness();
    // The notice can be up before the device's memory of the account has been read back.
    policy.fieldsForSave('user-1', true);

    policy.settle('user-1', 'closed');
    expect(remembered).toEqual([['user-1', 'pending']]);
    expect(recordedFor()).toEqual([]);

    policy.setActiveAccount('user-1');
    expect(recordedFor()).toEqual(['user-1']);
  });
});

// Review finding #14, second half: a telling whose record never reached the
// server stays pending on the device and is asked for again.
describe('the saver notice policy: a telling not on record yet', () => {
  it('is asked for again at the next save, at retryRecord and at sign-in, until the server has it', async () => {
    const { policy, records, recordedFor, remembered } = harness();
    policy.setActiveAccount('user-1');
    policy.fieldsForSave('user-1', true);
    policy.settle('user-1', 'closed');

    // The POST failed: still told on this device, still not on record.
    await records[0].answer(false);
    expect(remembered).toEqual([['user-1', 'pending']]);

    expect(policy.fieldsForSave('user-1', true)).toEqual(NAMES_SAVER);
    expect(recordedFor()).toEqual(['user-1', 'user-1']);
    await records[1].answer(false);

    policy.retryRecord('user-1');
    expect(recordedFor()).toEqual(['user-1', 'user-1', 'user-1']);
    await records[2].answer(false);

    policy.setActiveAccount('user-1');
    expect(recordedFor()).toEqual(['user-1', 'user-1', 'user-1', 'user-1']);
    await records[3].answer(true);

    expect(remembered).toEqual([['user-1', 'pending'], ['user-1', 'recorded']]);
    policy.retryRecord('user-1');
    policy.fieldsForSave('user-1', true);
    expect(records).toHaveLength(4);
  });

  it('asks once at a time', async () => {
    const { policy, records, recordedFor } = harness();
    policy.setActiveAccount('user-1');
    policy.fieldsForSave('user-1', true);
    policy.settle('user-1', 'closed');

    policy.fieldsForSave('user-1', true);
    policy.retryRecord('user-1');
    policy.applyServerRecord('user-1', false);
    policy.setActiveAccount('user-1');
    expect(recordedFor()).toEqual(['user-1']);

    // Once it has answered, the next ask may go.
    await records[0].answer(false);
    policy.retryRecord('user-1');
    expect(recordedFor()).toEqual(['user-1', 'user-1']);
  });

  it('asks for nothing with no account signed in', () => {
    const { policy, recordedFor } = harness();
    policy.restore('user-1', 'pending');

    policy.retryRecord(null);
    policy.retryRecord('user-1');
    policy.fieldsForSave('user-1', true);

    expect(recordedFor()).toEqual([]);
  });
});

// Review finding #14, first half: the server's record decides when it and the
// device differ.
describe("the saver notice policy: the server's record", () => {
  it('takes a telling on record from another device, without the notice', () => {
    const { policy, remembered, shown } = harness();
    policy.setActiveAccount('user-1');

    policy.applyServerRecord('user-1', true);
    policy.applyServerRecord('user-1', true);

    expect(remembered).toEqual([['user-1', 'recorded']]);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NAMES_SAVER);
    expect(shown).toEqual([]);
  });

  it('forgets a telling this device saw on record once the server no longer has it, and the next save tells them again', () => {
    const { policy, remembered, shown } = harness();
    policy.setActiveAccount('user-1');
    policy.applyServerRecord('user-1', true);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NAMES_SAVER);

    // Cleared on the server on purpose.
    expect(policy.applyServerRecord('user-1', false)).toBe(true);

    expect(remembered).toEqual([['user-1', 'recorded'], ['user-1', null]]);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NOT_YET_TOLD);
    expect(shown).toEqual(['user-1']);
  });

  // Review 4 finding #9: a profile read that began before this device's
  // record landed (the launch fetch the record's own refresh joined, or a
  // refresh started with a retried record) answers "no record" after it.
  it("sets aside a 'no record' once this device has put the telling on record since it started", async () => {
    const { policy, records, remembered, shown } = harness();
    policy.setActiveAccount('user-1');
    policy.fieldsForSave('user-1', true);
    policy.settle('user-1', 'closed');
    await records[0].answer(true);

    expect(policy.applyServerRecord('user-1', false)).toBe(false);
    expect(policy.applyServerRecord('user-1', false)).toBe(false);

    expect(remembered).toEqual([['user-1', 'pending'], ['user-1', 'recorded']]);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NAMES_SAVER);
    expect(shown).toEqual(['user-1']);
    // "On record" is taken as ever.
    expect(policy.applyServerRecord('user-1', true)).toBe(true);
  });

  it("acts on a 'no record' while the telling is still on its way to the server: it is asked for, not forgotten", async () => {
    const { policy, records, recordedFor, remembered } = harness();
    policy.setActiveAccount('user-1');
    policy.fieldsForSave('user-1', true);
    policy.settle('user-1', 'closed');

    // The record is out; the read came back first.
    expect(policy.applyServerRecord('user-1', false)).toBe(true);
    expect(recordedFor()).toEqual(['user-1']);
    await records[0].answer(true);
    expect(remembered).toEqual([['user-1', 'pending'], ['user-1', 'recorded']]);
    expect(policy.applyServerRecord('user-1', false)).toBe(false);
  });

  it('keeps setting aside only for the account this device recorded', async () => {
    const { policy, records, remembered } = harness();
    policy.setActiveAccount('user-1');
    policy.fieldsForSave('user-1', true);
    policy.settle('user-1', 'closed');
    await records[0].answer(true);

    policy.restore('user-2', 'recorded');
    expect(policy.applyServerRecord('user-2', false)).toBe(true);
    expect(remembered).toContainEqual(['user-2', null]);
  });

  it('starts again at reset: a later run acts on the record the server keeps', async () => {
    const { policy, records } = harness();
    policy.setActiveAccount('user-1');
    policy.fieldsForSave('user-1', true);
    policy.settle('user-1', 'closed');
    await records[0].answer(true);

    policy.reset();
    policy.restore('user-1', 'recorded');
    policy.setActiveAccount('user-1');
    expect(policy.applyServerRecord('user-1', false)).toBe(true);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NOT_YET_TOLD);
  });

  it('forgets a telling read back from the device as on record, as it does one seen on record this run', () => {
    const { policy, remembered } = harness();
    policy.restore('user-1', 'recorded');
    policy.setActiveAccount('user-1');

    policy.applyServerRecord('user-1', false);

    expect(remembered).toEqual([['user-1', null]]);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NOT_YET_TOLD);
  });

  it('asks again for a telling the server has not got yet, rather than forgetting it', () => {
    const { policy, recordedFor, remembered } = harness();
    policy.setActiveAccount('user-1');
    policy.restore('user-1', 'pending');

    policy.applyServerRecord('user-1', false);

    expect(recordedFor()).toEqual(['user-1']);
    expect(remembered).toEqual([]);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NAMES_SAVER);
  });

  it('changes nothing for an account this device knows nothing of', () => {
    const { policy, records, remembered } = harness();
    policy.setActiveAccount('user-1');

    policy.applyServerRecord('user-1', false);

    expect(remembered).toEqual([]);
    expect(records).toEqual([]);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NOT_YET_TOLD);
  });
});

// The app's profile comes back from its cache before the phone's storage has
// answered, so "no record" can reach the policy before the device's memory.
describe("the saver notice policy: the server's record before the device's memory", () => {
  it('forgets a telling the device kept as on record once that memory is read, and the next save tells them again', () => {
    const { policy, remembered, shown } = harness();
    policy.setActiveAccount('user-1');
    policy.applyServerRecord('user-1', false);

    policy.restore('user-1', 'recorded');

    expect(remembered).toEqual([['user-1', null]]);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NOT_YET_TOLD);
    expect(shown).toEqual(['user-1']);
  });

  it('asks the server again for a telling the device kept as not on record yet', () => {
    const { policy, recordedFor } = harness();
    policy.setActiveAccount('user-1');
    policy.applyServerRecord('user-1', false);

    policy.restore('user-1', 'pending');

    expect(recordedFor()).toEqual(['user-1']);
  });

  it('keeps a telling made after that answer, before the memory was read', () => {
    const { policy, remembered } = harness();
    policy.setActiveAccount('user-1');
    policy.applyServerRecord('user-1', false);
    policy.fieldsForSave('user-1', true);
    policy.settle('user-1', 'closed');

    policy.restore('user-1', 'recorded');

    expect(remembered).toEqual([['user-1', 'pending']]);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NAMES_SAVER);
  });

  it('holds the latest answer: a record the server then cleared does not come back from the device', () => {
    const { policy, remembered } = harness();
    policy.setActiveAccount('user-1');
    policy.applyServerRecord('user-1', true);
    policy.applyServerRecord('user-1', false);

    policy.restore('user-1', 'recorded');

    expect(remembered).toEqual([['user-1', 'recorded'], ['user-1', null], ['user-1', null]]);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NOT_YET_TOLD);
  });

  it('lets a later "on record" stand over an earlier "no record"', () => {
    const { policy } = harness();
    policy.setActiveAccount('user-1');
    policy.applyServerRecord('user-1', false);
    policy.applyServerRecord('user-1', true);

    policy.restore('user-1', null);

    expect(policy.fieldsForSave('user-1', true)).toEqual(NAMES_SAVER);
  });
});

// Review finding #10: a notice belongs to the account it tells, and its
// record goes out only as that account.
describe('the saver notice policy: another account signing in', () => {
  it("takes the other account's notice down unread, so its ending later tells nothing", () => {
    const { policy, hidden, records, remembered, shown } = harness();
    policy.setActiveAccount('user-1');
    policy.fieldsForSave('user-1', true);

    policy.setActiveAccount('user-2');

    expect(hidden).toEqual(['user-1']);
    // The bar's countdown or OK arriving after the switch.
    policy.settle('user-1', 'expired');
    expect(remembered).toEqual([]);
    expect(records).toEqual([]);

    // Back on this phone later: told at its next save, as if never shown.
    policy.setActiveAccount('user-1');
    expect(policy.fieldsForSave('user-1', true)).toEqual(NOT_YET_TOLD);
    expect(shown).toEqual(['user-1', 'user-1']);
    expect(records).toEqual([]);
  });

  it('takes it down when the account signs out', () => {
    const { policy, hidden, shown } = harness();
    policy.setActiveAccount('user-1');
    policy.fieldsForSave('user-1', true);

    policy.setActiveAccount(null);

    expect(hidden).toEqual(['user-1']);
    // Down: back on this phone, the next save draws it again.
    policy.setActiveAccount('user-1');
    policy.fieldsForSave('user-1', true);
    expect(shown).toEqual(['user-1', 'user-1']);
  });

  it('leaves the notice up when the same account is set again', () => {
    const { policy, hidden, shown } = harness();
    policy.setActiveAccount('user-1');
    policy.fieldsForSave('user-1', true);

    policy.setActiveAccount('user-1');

    expect(hidden).toEqual([]);
    // Still up: a further save draws nothing more.
    policy.fieldsForSave('user-1', true);
    expect(shown).toEqual(['user-1']);
  });

  it('never asks for a record for an account that is not signed in, and asks once it is', () => {
    const { policy, recordedFor } = harness();
    policy.restore('user-1', 'pending');
    policy.restore('user-2', 'pending');
    policy.setActiveAccount('user-2');
    expect(recordedFor()).toEqual(['user-2']);

    // user-1 is not signed in: its telling waits on the device.
    policy.retryRecord('user-1');
    policy.applyServerRecord('user-1', false);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NAMES_SAVER);
    expect(recordedFor()).toEqual(['user-2']);

    policy.setActiveAccount('user-1');
    expect(recordedFor()).toEqual(['user-2', 'user-1']);
  });

  it("keeps each account's telling to itself", async () => {
    const { policy, records, shown } = harness();
    policy.setActiveAccount('user-1');
    policy.fieldsForSave('user-1', true);
    policy.settle('user-1', 'closed');
    await records[0].answer(true);

    policy.setActiveAccount('user-2');
    expect(policy.fieldsForSave('user-2', true)).toEqual(NOT_YET_TOLD);
    expect(shown).toEqual(['user-1', 'user-2']);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NAMES_SAVER);
  });
});

describe("the saver notice policy: the device's memory", () => {
  it.each([
    ['recorded', NAMES_SAVER],
    ['pending', NAMES_SAVER],
    // The v1 key held '1'; v2 reads only its own two values.
    ['1', NOT_YET_TOLD],
    [null, NOT_YET_TOLD],
    [undefined, NOT_YET_TOLD],
    [{ seen: true }, NOT_YET_TOLD],
  ] as const)('reads back %j as %j', (stored, fields) => {
    const { policy } = harness();
    policy.restore('user-1', stored);
    expect(policy.fieldsForSave('user-1', true)).toEqual(fields);
  });

  it('never lets a read-back overwrite what this run already knows', () => {
    const { policy, recordedFor } = harness();
    policy.applyServerRecord('user-1', true);
    policy.restore('user-1', null);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NAMES_SAVER);

    // Told on this run before the device's copy was read back: still pending,
    // so its record is still asked for once the account is signed in.
    policy.fieldsForSave('user-2', true);
    policy.settle('user-2', 'closed');
    policy.restore('user-2', 'recorded');
    policy.setActiveAccount('user-2');
    expect(recordedFor()).toEqual(['user-2']);
  });

  it('keeps it per account, under a v2 key', () => {
    expect(SAVER_NOTICE_STORAGE_KEY_PREFIX).toBe('magicbooklet:saver-notice:v2:');
    expect(saverNoticeStorageKey('user-1')).toBe('magicbooklet:saver-notice:v2:user-1');
    expect(readStoredSaverNoticeMemory('pending')).toBe('pending');
    expect(readStoredSaverNoticeMemory('recorded')).toBe('recorded');
    expect(readStoredSaverNoticeMemory('1')).toBeNull();
    expect(readStoredSaverNoticeMemory(true)).toBeNull();
  });

  it('forgets everything at reset, the signed-in account too', () => {
    const { policy, recordedFor, shown } = harness();
    policy.setActiveAccount('user-1');
    policy.applyServerRecord('user-1', true);
    policy.fieldsForSave('user-2', true);
    policy.restore('user-3', null);

    policy.reset();

    // user-2's notice is no longer held up: its next save draws it again.
    policy.fieldsForSave('user-2', true);
    expect(shown).toEqual(['user-2', 'user-2']);
    expect(policy.hasRestored('user-3')).toBe(false);
    expect(policy.fieldsForSave('user-1', true)).toEqual(NOT_YET_TOLD);
    // No account is signed in after a reset: a telling read now waits for one.
    policy.settle('user-1', 'closed');
    expect(recordedFor()).toEqual([]);
  });
});

describe('the saver notice copy and timings', () => {
  it('says what the web says, for six seconds in view, ignoring a press in its first 700 ms', () => {
    expect(SAVER_NOTICE_MESSAGE).toBe('Creators can see who saved their posts.');
    expect(SAVER_NOTICE_DURATION_MS).toBe(6000);
    expect(SAVER_NOTICE_TAP_GUARD_MS).toBe(700);
  });
});
