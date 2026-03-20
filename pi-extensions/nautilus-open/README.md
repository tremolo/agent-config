# nautilus-select — Multi-file selection for Nautilus

Open files in GNOME Files (Nautilus) with **multiple files selected** in a single window.

## The problem

Nautilus's built-in `org.freedesktop.FileManager1.ShowItems` DBus method processes URIs one by one. Each call to `open_location` only keeps the *last* file selected. Neither the `nautilus -s` CLI flag nor any DBus method supports true multi-select. This is a [known limitation](https://discourse.gnome.org/t/select-multiple-files-with-s-and-nautilus-cli-flags/15104) in the Nautilus source code.

## How it works

This project has two parts:

**`nautilus_select_ext.py`** — A Nautilus Python extension that runs inside the Nautilus process. It registers a custom DBus interface (`org.gnome.Nautilus.SelectItems`) and walks the GTK4 widget tree to find the `GtkSelectionModel` backing the file view. When called, it unwraps `GtkTreeListRow` items to reach the underlying `NautilusViewItem`, resolves each file's URI, and programmatically toggles selection.

**`nautilus_open.py`** — A CLI script that groups input files by parent directory, opens each folder in Nautilus via `ShowFolders`, then calls the extension's `Select` DBus method to apply multi-selection. Falls back gracefully to single-select `ShowItems` if the extension isn't installed.

## Requirements

- GNOME Files (Nautilus) 43+ (GTK4)
- Python 3.10+
- `nautilus-python` — Python bindings for the Nautilus extension API

### Install `nautilus-python`

| Distro | Command |
|---|---|
| Arch Linux | `sudo pacman -S nautilus-python` |
| Fedora | `sudo dnf install nautilus-python` |
| Debian/Ubuntu | `sudo apt install python3-nautilus` |

## Installation

```bash
# 1. Copy the extension
mkdir -p ~/.local/share/nautilus-python/extensions
cp nautilus_select_ext.py ~/.local/share/nautilus-python/extensions/

# 2. Make the CLI script executable (optional)
chmod +x nautilus_open.py

# 3. Restart Nautilus to load the extension
nautilus -q
```

## Usage

```bash
# Select multiple files in the same directory
python3 nautilus_open.py ~/Documents/report.pdf ~/Documents/notes.txt

# Files in different directories open separate windows
python3 nautilus_open.py ~/Documents/report.pdf ~/Pictures/photo.jpg

# Works with globs
python3 nautilus_open.py ~/Downloads/*.pdf
```

### Tip: add to PATH

```bash
cp nautilus_open.py ~/.local/bin/nautilus-open
chmod +x ~/.local/bin/nautilus-open

# Then use from anywhere
nautilus-open file1.txt file2.txt
```

## Verifying the extension is loaded

After restarting Nautilus, check that the extension's DBus name is registered:

```bash
gdbus call --session --dest org.freedesktop.DBus \
  --object-path /org/freedesktop/DBus \
  --method org.freedesktop.DBus.NameHasOwner \
  "org.gnome.Nautilus.SelectItems"
```

This should return `(true,)`.

## Troubleshooting

**Extension not loading / `(false,)` from NameHasOwner:**
- Ensure `nautilus-python` is installed
- Check that the file is in `~/.local/share/nautilus-python/extensions/`
- Restart Nautilus: `nautilus -q`, then open a folder or run `nautilus --gapplication-service`
- Nautilus only loads extensions when it actually starts — running in `--gapplication-service` mode is enough

**`Unable to acquire bus name 'org.gnome.Nautilus'`:**
- Another file manager (Nemo, etc.) or an existing Nautilus process holds the bus name
- Kill it first: `killall nautilus nemo`, then restart

**Extension debug log:**
- The extension writes warnings/errors to `~/.local/share/nautilus-python/select-ext.log`
- For verbose logging, edit the extension and change `level=logging.WARNING` to `level=logging.DEBUG`

**Wrong file manager opens:**
- If you have Nemo installed alongside Nautilus, it may claim the `org.freedesktop.FileManager1` bus name
- The CLI script targets `org.gnome.Nautilus` directly, so Nautilus should always be used
- If Nautilus won't start because Nemo holds `org.gnome.Nautilus`, kill Nemo first

## Limitations

- Uses Nautilus's internal GTK4 widget tree (not a public API), so it may break across major Nautilus versions. Tested with Nautilus 43–49 (extension API 4.x).
- Selection is applied with a short delay (300–500ms) to let the folder contents finish loading. On very large directories or slow storage, you may need to increase the delay in `nautilus_open.py`.
- The extension applies selection to all open windows — if you have multiple Nautilus windows open to the same directory, all will be affected.

## License

MIT
