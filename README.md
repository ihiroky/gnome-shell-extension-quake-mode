# ⚠️ Unmaintained Project

**This project is no longer maintained. For an actively supported version, please use this fork: [quake-terminal](https://github.com/diegodario88/quake-terminal)**

---

# It's a GNOME Shell extension adds support quake-mode for any application

## Installation

```bash
git clone https://github.com/ihiroky/gnome-shell-extension-quake-mode.git

cd gnome-shell-extension-quake-mode

pack_args=(
  quake-mode@ihiroky.github.com
  --extra-source=quakemodeapp.js
  --extra-source=indicator.js
  --extra-source=util.js
)

if command -v msgfmt >/dev/null 2>&1; then
  gnome-extensions pack "${pack_args[@]}"
else
  echo "msgfmt not found; packaging without translations."
  empty_po_dir="$(mktemp -d)"
  if gnome-extensions pack "${pack_args[@]}" --podir="$empty_po_dir"; then
    rmdir "$empty_po_dir"
  else
    pack_status=$?
    rmdir "$empty_po_dir"
    exit "$pack_status"
  fi
fi

gnome-extensions install quake-mode@ihiroky.github.com.shell-extension.zip
```

When `msgfmt` is unavailable, translations are omitted and the extension uses the original source strings.

## Usage

Go to gnome extensions or extension manager and open the settings for quake-mode. Switch over to the accelerators tab and define a shortcut key and an application it should open. Use that key to toggle the application like a quake shell.

## Know issues

Due to the implementation of some tricks of initial placement of the window in the desired location on the screen and suppression of the initial animation with replacement of its own, it may not always work correctly.

## P.S.

Developed for usage [tilix](https://github.com/gnunn1/tilix) on wayland but can manage almost any application.
