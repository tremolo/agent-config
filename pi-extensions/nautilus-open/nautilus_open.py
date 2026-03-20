#!/usr/bin/env python3
"""Open files in Nautilus with multi-file selection per directory.

Uses a companion Nautilus extension (nautilus_select_ext.py) that exposes
a custom DBus interface for programmatic multi-select — something
Nautilus's built-in ShowItems cannot do.

Usage:
    nautilus_open.py FILE [FILE ...]

Files sharing the same parent directory are selected together in one
Nautilus window. Files in different directories open separate windows.
"""

import sys
import subprocess
import time
from pathlib import Path
from collections import defaultdict
from urllib.parse import quote

from gi.repository import Gio, GLib

# DBus coordinates — must match the extension
EXT_BUS_NAME = "org.gnome.Nautilus.SelectItems"
EXT_PATH = "/org/gnome/Nautilus/SelectItems"
EXT_IFACE = "org.gnome.Nautilus.SelectItems"

NAUTILUS_BUS = "org.gnome.Nautilus"
FM_PATH = "/org/freedesktop/FileManager1"
FM_IFACE = "org.freedesktop.FileManager1"


def group_by_directory(paths: list[str]) -> dict[str, list[str]]:
    """Resolve paths and group them by parent directory."""
    groups: dict[str, list[str]] = defaultdict(list)
    for p in paths:
        resolved = Path(p).resolve()
        if not resolved.exists():
            print(f"warning: skipping non-existent path: {p}", file=sys.stderr)
            continue
        groups[str(resolved.parent)].append(str(resolved))
    return groups


def path_to_uri(path: str) -> str:
    """Convert an absolute path to a file:// URI with proper escaping."""
    return "file://" + quote(path, safe="/")


def ensure_nautilus_running() -> None:
    """Start Nautilus if it isn't already running."""
    try:
        subprocess.Popen(
            ["nautilus", "--gapplication-service"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        print("error: nautilus not found in PATH", file=sys.stderr)
        sys.exit(1)


def extension_available(bus: Gio.DBusConnection) -> bool:
    """Check whether the companion extension is registered on the bus."""
    try:
        result = bus.call_sync(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "NameHasOwner",
            GLib.Variant("(s)", (EXT_BUS_NAME,)),
            GLib.VariantType("(b)"),
            Gio.DBusCallFlags.NONE, -1, None,
        )
        return result.unpack()[0]
    except Exception:
        return False


def wait_for_extension(bus: Gio.DBusConnection, timeout: float = 5.0) -> bool:
    """Wait for the extension to appear on the bus, with timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if extension_available(bus):
            return True
        time.sleep(0.3)
    return False


def open_folder(bus: Gio.DBusConnection, dir_uri: str) -> None:
    """Open a directory in Nautilus via ShowFolders."""
    bus.call_sync(
        NAUTILUS_BUS, FM_PATH, FM_IFACE, "ShowFolders",
        GLib.Variant("(ass)", ([dir_uri], "")),
        None, Gio.DBusCallFlags.NONE, -1, None,
    )


def select_via_extension(bus: Gio.DBusConnection, uris: list[str]) -> None:
    """Call the extension's Select method to set multi-file selection."""
    bus.call_sync(
        EXT_BUS_NAME, EXT_PATH, EXT_IFACE, "Select",
        GLib.Variant("(as)", (uris,)),
        None, Gio.DBusCallFlags.NONE, -1, None,
    )


def show_items_fallback(bus: Gio.DBusConnection, uris: list[str]) -> None:
    """Fallback: use Nautilus's built-in ShowItems (single-select only)."""
    bus.call_sync(
        NAUTILUS_BUS, FM_PATH, FM_IFACE, "ShowItems",
        GLib.Variant("(ass)", (uris, "")),
        None, Gio.DBusCallFlags.NONE, -1, None,
    )


def show_items(paths: list[str]) -> None:
    """Open Nautilus and select files, grouped by directory."""
    groups = group_by_directory(paths)
    if not groups:
        print("error: no valid paths provided", file=sys.stderr)
        sys.exit(1)

    ensure_nautilus_running()
    bus = Gio.bus_get_sync(Gio.BusType.SESSION)

    has_ext = wait_for_extension(bus, timeout=5.0)
    if not has_ext:
        print(
            "warning: nautilus_select_ext not detected — "
            "falling back to ShowItems (only one file will be selected).\n"
            "Install the extension for multi-select support:\n"
            "  cp nautilus_select_ext.py "
            "~/.local/share/nautilus-python/extensions/\n"
            "  nautilus -q",
            file=sys.stderr,
        )

    for dir_path, file_paths in groups.items():
        uris = [path_to_uri(p) for p in file_paths]
        dir_uri = path_to_uri(dir_path)

        if has_ext:
            # Open the folder so the extension has a window to work with
            open_folder(bus, dir_uri)
            time.sleep(0.5)
            # Ask the extension to set the selection
            select_via_extension(bus, uris)
        else:
            show_items_fallback(bus, uris)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"usage: {sys.argv[0]} FILE [FILE ...]", file=sys.stderr)
        sys.exit(1)
    show_items(sys.argv[1:])
