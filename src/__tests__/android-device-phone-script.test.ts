// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// phone.sh's `free` gates every start and press on the owner's own phone (the android-device skill, section 6).
// It runs here under /bin/bash (3.2 on the dev Mac) against a stand-in adb that answers from canned dumps, so no
// device is touched. Until 2026-10-21 it counted `state=DIALING` lines anywhere in telecom's dump, including its
// event log of past calls, and read 118 calls on an idle S24.

const PHONE_SH = path.join(process.cwd(), '.agents', 'skills', 'android-device', 'scripts', 'phone.sh');
const stubDirectory = mkdtempSync(path.join(os.tmpdir(), 'phone-sh-'));

// Matched in order: `dumpsys window policy` before `dumpsys window`.
writeFileSync(path.join(stubDirectory, 'adb'), `#!/bin/bash
case "$*" in
  *get-state*) echo device ;;
  *"dumpsys power"*) echo "  mWakefulness=\${STUB_POWER:-Awake}" ;;
  *"dumpsys window policy"*) echo "    showing=\${STUB_KEYGUARD:-false}" ;;
  *"dumpsys window"*) echo "  mCurrentFocus=Window{1f2e3d u0 \${STUB_FRONT:-com.sec.android.app.launcher}/com.example.Main}" ;;
  *"dumpsys audio"*) echo "- Actual mode = \${STUB_AUDIO:-MODE_NORMAL}" ;;
  *"dumpsys telecom"*) printf '%s\\n' "\${STUB_TELECOM:-}" ;;
  *"date -d"*) [ -n "\${STUB_NO_CLOCK:-}" ] || echo "10-21 10:00:00.000" ;;
  *logcat*) echo "I ActivityManager: idle"; [ -z "\${STUB_TOUCH:-}" ] || echo "I ViewRootImpl: ViewPostIme pointer 0" ;;
  *pidof*) echo 4242 ;;
  *) echo "stand-in adb: unexpected $*" >&2; exit 1 ;;
esac
`);
chmodSync(path.join(stubDirectory, 'adb'), 0o755);
afterAll(() => rmSync(stubDirectory, { recursive: true, force: true }));

// Telecom's dump as the S24 printed it on 2026-10-21, idle and cut down: an empty list of current calls, and the
// event log still holding a call made hours before.
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

function run(step: 'free' | 'state', stub: Record<string, string>) {
  return spawnSync('/bin/bash', [PHONE_SH, step], {
    encoding: 'utf8',
    env: { NODE_ENV: 'test', PATH: `${stubDirectory}:/usr/bin:/bin`, ANDROID_SERIAL: 'STUB', STUB_TELECOM: IDLE_TELECOM, ...stub },
  });
}

describe('phone.sh free', () => {
  it('finds an idle phone free, past calls in the event log and all', () => {
    const result = run('free', {});
    expect(result.stdout.trim(), result.stderr).toBe('free');
    expect(result.status).toBe(0);
  });

  it('finds the phone busy while a call is ringing, an app call included', () => {
    const result = run('free', { STUB_TELECOM: RINGING_TELECOM });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('call=1');
  });

  it('finds the phone busy when it cannot read the list of calls', () => {
    for (const unreadable of ['', "Can't find service: telecom"]) {
      const result = run('free', { STUB_TELECOM: unreadable });
      expect(result.status, `telecom dump: ${JSON.stringify(unreadable)}`).toBe(1);
      expect(result.stdout).toContain('call=unknown');
    }
  });

  it('finds the phone busy in an app call telecom does not list, by its audio mode', () => {
    const result = run('free', { STUB_AUDIO: 'MODE_IN_COMMUNICATION' });
    expect(result.status).toBe(1);
  });

  it('finds the phone busy with a finger on the screen, or when it cannot tell', () => {
    expect(run('free', { STUB_TOUCH: '1' }).stdout).toContain('touches=1');
    expect(run('free', { STUB_NO_CLOCK: '1' }).stdout).toContain('touches=unknown');
  });

  it('finds the phone busy when locked, asleep, or another app is in front', () => {
    expect(run('free', { STUB_KEYGUARD: 'true' }).status).toBe(1);
    expect(run('free', { STUB_POWER: 'Asleep' }).status).toBe(1);
    expect(run('free', { STUB_FRONT: 'com.whatsapp' }).status).toBe(1);
  });
});

describe('phone.sh state', () => {
  it('counts the calls in progress from the same list', () => {
    expect(run('state', {}).stdout).toContain('calls in progress: 0\n');
    expect(run('state', { STUB_TELECOM: RINGING_TELECOM }).stdout).toContain('calls in progress: 1\n');
    expect(run('state', { STUB_TELECOM: '' }).stdout).toContain('calls in progress: unknown\n');
  });
});
