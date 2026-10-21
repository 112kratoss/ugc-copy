// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The android-device skill's scripts gate everything a session does on the owner's own phone (SKILL.md,
// section 6). They run here under /bin/bash (3.2 on the dev Mac) against a stand-in adb that answers from
// canned dumps, with a made-up serial, so no device is ever touched. Until 2026-10-21 `free` counted
// `state=DIALING` lines anywhere in telecom's dump, including its event log of past calls, and read 118 calls
// on an idle S24; a first fix read telephony's call state, which knows no app calls and read an empty dump as
// no call.

const SCRIPTS = path.join(process.cwd(), '.agents', 'skills', 'android-device', 'scripts');
const SERIAL = 'PHONE-STAND-IN';

// Matched in order: `dumpsys window policy` before `dumpsys window`.
const STAND_IN_ADB = `#!/bin/bash
case "$*" in
  *get-state*) echo device ;;
  *"dumpsys power"*) echo "  mWakefulness=\${STUB_POWER:-Awake}" ;;
  *"dumpsys window policy"*) [ -n "\${STUB_NO_POLICY:-}" ] || echo "    showing=\${STUB_KEYGUARD:-false}" ;;
  *"dumpsys window"*) echo "  mCurrentFocus=Window{1f2e3d u0 \${STUB_FRONT:-com.sec.android.app.launcher}/com.example.Main}" ;;
  *"dumpsys audio"*) echo "- Actual mode = \${STUB_AUDIO:-MODE_NORMAL}" ;;
  *"dumpsys telecom"*) printf '%s\\n' "\${STUB_TELECOM:-}" ;;
  *"date -d"*) [ -n "\${STUB_NO_CLOCK:-}" ] || echo "10-21 10:00:00.000" ;;
  *logcat*) [ -z "\${STUB_LOGCAT_FAILS:-}" ] || exit 1; echo "I ActivityManager: idle"; [ -z "\${STUB_TOUCH:-}" ] || echo "I ViewRootImpl: ViewPostIme pointer 0" ;;
  *pidof*) echo 4242 ;;
  *) echo "stand-in adb: unexpected $*" >&2; exit 1 ;;
esac
`;

// Telecom's dump as the S24 printed it on 2026-10-21, idle and cut down: an empty list of current calls, the next
// section at the list's depth, and the event log still holding a call made hours before.
const IDLE_TELECOM = [
  'telecom: samsung/e3qxxx/e3q:16/BP4A.251205.006/S928BXXS6DZI1:user/release-keys, 16, /system/priv-app',
  'CallsManager: ',
  '  mCalls: ',
  '  mCallAudioManager:',
  '    All calls:',
  '    Ringing calls:',
  '      Call Route History',
  '        2026-10-20T18:49:50.531762 - Call[id=e4e3e670, state=DIALING]: AudioRoute[Type=TYPE_EARPIECE] - EXIT',
].join('\n');
// A WhatsApp call ringing: an app's call sits in the same list, and audio has not left MODE_NORMAL yet.
const RINGING_TELECOM = IDLE_TELECOM.replace(
  '  mCalls: ',
  '  mCalls: \n    [Call id=TC@7, state=RINGING, tpac=ComponentInfo{com.whatsapp/com.whatsapp.SelfManagedConnectionService}]',
);

let stubDirectory = '';

beforeAll(() => {
  stubDirectory = mkdtempSync(path.join(os.tmpdir(), 'android-device-'));
  writeFileSync(path.join(stubDirectory, 'adb'), STAND_IN_ADB);
  chmodSync(path.join(stubDirectory, 'adb'), 0o755);
});
afterAll(() => {
  if (stubDirectory) rmSync(stubDirectory, { recursive: true, force: true });
});

function run(script: string, args: string[], stub: Record<string, string> = {}) {
  return spawnSync('/bin/bash', [path.join(SCRIPTS, script), ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      NODE_ENV: 'test',
      PATH: `${stubDirectory}:/usr/bin:/bin`,
      ANDROID_SERIAL: SERIAL,
      ADB: path.join(stubDirectory, 'adb'),
      EMU: '/usr/bin/true',
      STUB_TELECOM: IDLE_TELECOM,
      ...stub,
    },
  });
}

describe('phone.sh free', () => {
  it('finds an idle phone free, past calls in the event log and all', () => {
    const result = run('phone.sh', ['free']);
    expect(result.stdout.trim(), result.stderr).toBe('free');
    expect(result.status).toBe(0);
  });

  it('finds the phone busy while a call is ringing, an app call included', () => {
    const result = run('phone.sh', ['free'], { STUB_TELECOM: RINGING_TELECOM });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('call=1');
  });

  it('finds the phone busy when it cannot read the list of calls in full', () => {
    const unreadable = {
      'no dump': '',
      'no service': "Can't find service: telecom",
      'cut after the list header': 'CallsManager: \n  mCalls: ',
      'a dumpsys timeout inside the list': '  mCalls: \n*** SERVICE telecom DUMP TIMEOUT (10000ms) EXPIRED ***',
    };
    for (const [shape, dump] of Object.entries(unreadable)) {
      const result = run('phone.sh', ['free'], { STUB_TELECOM: dump });
      expect(result.status, shape).toBe(1);
      expect(result.stdout, shape).toContain('call=unknown');
    }
  });

  it('finds the phone busy in an app call telecom does not list, by its audio mode', () => {
    expect(run('phone.sh', ['free'], { STUB_AUDIO: 'MODE_IN_COMMUNICATION' }).status).toBe(1);
  });

  it('finds the phone busy with a finger on the screen, or when it cannot tell', () => {
    expect(run('phone.sh', ['free'], { STUB_TOUCH: '1' }).stdout).toContain('touches=1');
    expect(run('phone.sh', ['free'], { STUB_NO_CLOCK: '1' }).stdout).toContain('touches=unknown');
    expect(run('phone.sh', ['free'], { STUB_LOGCAT_FAILS: '1' }).stdout).toContain('touches=unknown');
  });

  it('finds the phone busy when locked or when the keyguard cannot be read, asleep, or another app in front', () => {
    expect(run('phone.sh', ['free'], { STUB_KEYGUARD: 'true' }).status).toBe(1);
    expect(run('phone.sh', ['free'], { STUB_NO_POLICY: '1' }).stdout).toContain('keyguard=unknown');
    expect(run('phone.sh', ['free'], { STUB_POWER: 'Asleep' }).status).toBe(1);
    expect(run('phone.sh', ['free'], { STUB_FRONT: 'com.whatsapp' }).status).toBe(1);
  });
});

describe('phone.sh state', () => {
  it('counts the calls in progress from the same list', () => {
    expect(run('phone.sh', ['state']).stdout).toContain('calls in progress: 0\n');
    expect(run('phone.sh', ['state'], { STUB_TELECOM: RINGING_TELECOM }).stdout).toContain('calls in progress: 1\n');
    expect(run('phone.sh', ['state'], { STUB_TELECOM: '' }).stdout).toContain('calls in progress: unknown\n');
  });
});

describe('emulator.sh', () => {
  it('refuses to act on a device that is not an emulator, and still lets a hand-back clear its lock', () => {
    for (const command of ['boot', 'launch', 'shot', 'restarts']) {
      const result = run('emulator.sh', [command, path.join(stubDirectory, 'shot.png')]);
      expect(result.status, command).toBe(2);
      expect(result.stderr, command).toContain(`${SERIAL} is not one`);
    }
    const unlock = run('emulator.sh', ['unlock'], { LOCK: path.join(stubDirectory, 'emulator.lock') });
    expect(unlock.status, unlock.stderr).toBe(0);
  });
});

describe('keep-awake.sh', () => {
  it('ends a run on a stop file and uses it up, so the next run is not stopped by it', () => {
    const stop = path.join(stubDirectory, 'keep-awake-stop');
    writeFileSync(stop, '');
    const stopped = run('keep-awake.sh', ['1'], { STOP: stop });
    expect(stopped.stdout).toContain(`stopped by ${stop}`);
    expect(existsSync(stop)).toBe(false);
    // The next run goes on to its checks: with the screen off it stops for that reason.
    expect(run('keep-awake.sh', ['1'], { STOP: stop, STUB_POWER: 'Asleep' }).stdout).toContain('screen off; stopping');
  });
});
