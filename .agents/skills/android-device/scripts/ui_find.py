#!/usr/bin/env python3
"""Find on-screen controls in the Android UI tree (uiautomator), by label, for adb taps.

Usage (ANDROID_SERIAL selects the device, default emulator-5554):
  ui_find.py                 -> every labelled node (text / content-desc) with its centre
  ui_find.py <substring>...  -> nodes whose text or content-desc contains any substring (case-insensitive)
Prints: centre_x centre_y | bounds | flags | label

While a video plays the dump never goes idle: the script then hangs, or prints the previous screen.
Check a screenshot before trusting it.
"""
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

ADB = shutil.which("adb") or os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
SERIAL = os.environ.get("ANDROID_SERIAL", "emulator-5554")


def dump():
    subprocess.run([ADB, "-s", SERIAL, "shell", "uiautomator", "dump", "/sdcard/ui.xml"], check=True, capture_output=True, timeout=20)
    out = subprocess.run([ADB, "-s", SERIAL, "exec-out", "cat", "/sdcard/ui.xml"], check=True, capture_output=True, timeout=20).stdout
    return ET.fromstring(out)


def main():
    needles = [n.lower() for n in sys.argv[1:]]
    for node in dump().iter("node"):
        label = f"{node.get('content-desc') or ''} {node.get('text') or ''}".strip()
        if not label or (needles and not any(n in label.lower() for n in needles)):
            continue
        m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds") or "")
        if not m:
            continue
        x1, y1, x2, y2 = map(int, m.groups())
        flags = "".join(k[0] for k in ("clickable", "focused", "selected", "enabled") if node.get(k) == "true")
        print(f"{(x1 + x2) // 2} {(y1 + y2) // 2} | {node.get('bounds')} | {flags or '-'} | {label[:80]}")


if __name__ == "__main__":
    main()
