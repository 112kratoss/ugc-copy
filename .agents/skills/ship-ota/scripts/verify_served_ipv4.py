#!/usr/bin/env python3
"""Fetch the production update a store build would get, as a phone would, and check every asset's
sha256 against the manifest. Prints no header values.

    verify_served_ipv4.py <ios|android> <runtime fingerprint> <expected update group id> [stored artifact dir]

With a stored artifact dir it also compares the served launch asset with the stored .hbc (sha256).

From archive/ugc-app-audits/media-smoothness-checkup-2026-09-18/scripts/release/verify_ota.py, with the
targets taken from the arguments instead of being written in."""
import socket
_orig_getaddrinfo = socket.getaddrinfo
def _ipv4_only(*args, **kwargs):
    return [r for r in _orig_getaddrinfo(*args, **kwargs) if r[0] == socket.AF_INET]
socket.getaddrinfo = _ipv4_only
import base64, hashlib, json, re, sys, urllib.request

UA = 'curl/8.7.1'
PROJECT = '80e0b101-06da-4b8c-a31f-60c90ba9bdfb'


def parts(body, ctype):
    boundary = re.search(r'boundary=("?)([^";]+)\1', ctype).group(2).encode()
    out = {}
    for chunk in body.split(b'--' + boundary):
        if b'\r\n\r\n' not in chunk:
            continue
        head, data = chunk.split(b'\r\n\r\n', 1)
        name = re.search(rb'name="([^"]+)"', head)
        if name:
            out[name.group(1).decode()] = json.loads(data.rstrip(b'\r\n-'))
    return out


platform, runtime, expected = sys.argv[1], sys.argv[2], sys.argv[3]
stored = sys.argv[4] if len(sys.argv) > 4 else None
req = urllib.request.Request(f'https://u.expo.dev/{PROJECT}', headers={
    'expo-platform': platform, 'expo-runtime-version': runtime, 'expo-channel-name': 'production',
    'expo-protocol-version': '1', 'accept': 'multipart/mixed', 'user-agent': UA})
with urllib.request.urlopen(req, timeout=30) as r:
    p = parts(r.read(), r.headers['content-type'])
m, ext = p['manifest'], p.get('extensions', {})
group = (m.get('metadata') or {}).get('updateGroup') or (m.get('extra') or {}).get('updateGroup')
headers = ext.get('assetRequestHeaders', {})
assets = [m['launchAsset']] + m.get('assets', [])
good = 0
import time; t0 = time.time()
for a in assets:
    h = dict(headers.get(a['key'], {}))
    h['user-agent'] = UA
    with urllib.request.urlopen(urllib.request.Request(a['url'], headers=h), timeout=60) as r:
        data = r.read()
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('=')
    good += digest == a['hash']
match = group == expected if group else None
print(f"{platform} @ {runtime[:8]}: update {m['id'][:8]} created {m['createdAt']} group {str(group)[:8]} "
      f"(expected {expected[:8]}: {match}); launch asset + {len(assets) - 1} assets, {good}/{len(assets)} sha256 match")
same = None
if stored:
    import pathlib
    bundles = sorted(pathlib.Path(stored).rglob('*.hbc'))
    if len(bundles) == 1:
        local = base64.urlsafe_b64encode(hashlib.sha256(bundles[0].read_bytes()).digest()).decode().rstrip('=')
        same = local == m['launchAsset']['hash']
        print(f"{platform}: served launch hash {m['launchAsset']['hash'][:16]}… stored {bundles[0].name} {local[:16]}… equal: {same}")
    else:
        same = False
        print(f'{platform}: expected one .hbc under {stored}, found {len(bundles)}')
sys.exit(0 if good == len(assets) and match is not False and same is not False else 1)
