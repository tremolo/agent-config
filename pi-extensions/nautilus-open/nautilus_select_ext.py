"""Nautilus extension: exposes a DBus service for multi-file selection.

Nautilus's built-in ShowItems DBus method calls open_location once per
URI, so only the last file ends up selected. This extension runs inside
the Nautilus process and provides a custom DBus interface that walks the
GTK4 widget tree to programmatically select multiple files at once.

DBus interface:
    Bus name:  org.gnome.Nautilus.SelectItems
    Object:    /org/gnome/Nautilus/SelectItems
    Method:    Select(as uris)

Install:
    cp nautilus_select_ext.py ~/.local/share/nautilus-python/extensions/
    nautilus -q   # restart nautilus

Requires: nautilus-python
"""

import os
import logging
from urllib.parse import unquote

import gi
gi.require_version("Gtk", "4.0")
from gi.repository import GObject, Nautilus, Gio, GLib, Gtk

# Optional file-based log — set level to DEBUG for troubleshooting
_LOG_PATH = os.path.expanduser("~/.local/share/nautilus-python/select-ext.log")
logging.basicConfig(
    filename=_LOG_PATH, level=logging.WARNING,
    format="%(asctime)s %(levelname)s %(message)s", force=True,
)
log = logging.getLogger("select-ext")

DBUS_IFACE = "org.gnome.Nautilus.SelectItems"
DBUS_PATH = "/org/gnome/Nautilus/SelectItems"

IFACE_XML = """
<node>
  <interface name='org.gnome.Nautilus.SelectItems'>
    <method name='Select'>
      <arg type='as' name='uris' direction='in'/>
    </method>
  </interface>
</node>
"""


def _uri_to_path(uri: str) -> str:
    """Normalise a file:// URI to an absolute path for comparison."""
    if uri.startswith("file://"):
        return unquote(uri[7:])
    return uri


def _walk_widgets(widget):
    """Recursively yield all descendants of a GTK4 widget."""
    child = widget.get_first_child()
    while child is not None:
        yield child
        yield from _walk_widgets(child)
        child = child.get_next_sibling()


def _find_selection_models(window):
    """Find unique GtkSelectionModel instances in a window's widget tree.

    Nautilus uses GtkColumnView (list view) or GtkGridView (icon view),
    both backed by a GtkSelectionModel (typically NautilusViewModel).
    A ColumnView and its internal GtkColumnListView share the same model,
    so we deduplicate by object identity.
    """
    seen = set()
    models = []
    for widget in _walk_widgets(window):
        if hasattr(widget, "get_model"):
            try:
                model = widget.get_model()
            except Exception:
                continue
            if model is not None and isinstance(model, Gtk.SelectionModel):
                mid = id(model)
                if mid not in seen:
                    seen.add(mid)
                    models.append(model)
    return models


def _get_item_uri(item) -> str | None:
    """Extract the URI from a model item.

    Nautilus wraps items in GtkTreeListRow. We unwrap first, then follow
    the NautilusViewItem -> NautilusFile -> get_uri() chain.
    """
    # Unwrap TreeListRow
    if hasattr(item, "get_item"):
        inner = item.get_item()
        if inner is not None:
            item = inner

    # NautilusViewItem.get_file() -> NautilusFile
    if hasattr(item, "get_file"):
        f = item.get_file()
        if f and hasattr(f, "get_uri"):
            return f.get_uri()

    # GObject property fallback
    try:
        f = item.get_property("file")
        if f and hasattr(f, "get_uri"):
            return f.get_uri()
    except (TypeError, ValueError):
        pass

    # Item might be a NautilusFile or GFile itself
    if hasattr(item, "get_uri"):
        return item.get_uri()

    return None


class _SelectItemsDBusService:
    """Registers a custom DBus interface inside the Nautilus process."""

    def __init__(self):
        self._node_info = Gio.DBusNodeInfo.new_for_xml(IFACE_XML)
        self._bus = Gio.bus_get_sync(Gio.BusType.SESSION)

        self._bus.register_object(
            DBUS_PATH, self._node_info.interfaces[0],
            self._on_method_call, None, None,
        )
        Gio.bus_own_name_on_connection(
            self._bus, DBUS_IFACE,
            Gio.BusNameOwnerFlags.NONE, None, None,
        )

    def _on_method_call(self, connection, sender, object_path,
                        interface_name, method_name, parameters,
                        invocation):
        if method_name == "Select":
            uris = parameters.unpack()[0]
            try:
                self._select_items(uris)
            except Exception:
                log.exception("Error in _select_items")
            invocation.return_value(None)

    def _select_items(self, uris: list[str]):
        """Resolve wanted paths and schedule selection."""
        if not uris:
            return

        wanted = {_uri_to_path(u) for u in uris}

        app = Gtk.Application.get_default()
        if app is None:
            return

        windows = list(app.get_windows())
        if not windows:
            # No window yet — the CLI opens one; retry shortly
            GLib.timeout_add(800, self._apply_to_all, wanted)
            return

        # Small delay lets the folder contents finish loading after
        # the CLI script's ShowFolders call
        GLib.timeout_add(300, self._apply_to_all, wanted)

    def _apply_to_all(self, wanted: set[str]) -> bool:
        """Apply selection across all open Nautilus windows."""
        app = Gtk.Application.get_default()
        if app is not None:
            for w in app.get_windows():
                self._apply_selection(w, wanted)
        return False  # one-shot GLib timeout

    def _apply_selection(self, window, wanted: set[str]):
        """Walk a window's selection models and select matching files."""
        for model in _find_selection_models(window):
            n = model.get_n_items()
            if n == 0:
                continue

            model.unselect_all()

            for i in range(n):
                try:
                    item = model.get_item(i)
                    uri = _get_item_uri(item)
                    if uri and _uri_to_path(uri) in wanted:
                        model.select_item(i, False)
                except Exception:
                    log.exception(f"Error selecting item {i}")


# Module-level init — survives extension object finalization
_service = None
try:
    _service = _SelectItemsDBusService()
except Exception:
    log.exception("Failed to start DBus service")


class SelectItemsExtension(GObject.GObject, Nautilus.MenuProvider):
    """Entry point for nautilus-python. MenuProvider is used purely as
    a load hook — no menu items are added."""

    def get_file_items(self, *args):
        return []

    def get_background_items(self, *args):
        return []
