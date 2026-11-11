# ggit

A modern, friendly git history viewer — like `gitk`, but easier to read.

- **Commit graph** with coloured lanes, smooth curves, animated branch-flow pulses, hollow dots for merges and a halo on HEAD
- **Branch path tracing**: hover any branch in the sidebar to highlight its commits and animate its lane path
- **Plain-English explanations**: what a merge commit is, what changed, staged vs. not staged
- **Branch sidebar** with colour-matched lane dots and ahead/behind counts (↑ not pushed, ↓ not pulled); click to jump
- **Uncommitted changes** shown as a dashed row on top of the graph
- **Diffs** with line numbers, file list with change bars, large diffs collapsed
- **Search** across message, author and hash (non-matches are dimmed)
- Parent/child navigation, “which branches contain this commit?”, copy hash
- Dark/light theme, keyboard shortcuts, auto-refresh when the repo changes
- Fast: virtualised list handles tens of thousands of commits

Needs Python 3.8+ and git. The desktop window uses GTK 3 + WebKit2GTK via
PyGObject (preinstalled on Ubuntu/GNOME; otherwise installed automatically via the `.deb` package).
Without them ggit falls back to your browser. The internal server listens on `127.0.0.1` only.

## Installation

### Option 1: One-Line Installer (Ubuntu / Debian / Linux)

Builds and installs the `.deb` package (including GTK/WebKit dependencies and desktop launcher) on Debian/Ubuntu, or installs to `~/.local/bin` on other Linux distros:

```bash
curl -fsSL https://raw.githubusercontent.com/rbshah29/ggit/main/install.sh | bash
```

### Option 2: Install via `apt` Repository (Ubuntu / Debian)

```bash
echo "deb [trusted=yes] https://rbshah29.github.io/ggit ./" | sudo tee /etc/apt/sources.list.d/ggit.list
sudo apt update
sudo apt install ggit
```

### Option 3: Build & Install `.deb` from Source

```bash
git clone https://github.com/rbshah29/ggit.git
cd ggit
make install-deb   # builds dist/ggit_0.1.0_all.deb and runs sudo apt install
```

*(For a user-local install without `sudo`, run `./install.sh --user`, or to uninstall run `./install.sh --uninstall`.)*

## Usage

```bash
ggit                    # open a desktop window for the repo you're in
ggit ~/code/project     # open another repo
ggit --pick             # choose a repo with a folder dialog
ggit --browser          # old behaviour: serve the UI to your web browser
ggit --install          # add ggit to the applications menu (search "ggit")
ggit --uninstall        # remove it from the menu
```

Run from a terminal, the window detaches so your prompt is free again
(`--foreground` keeps it attached; `--debug` enables right-click → Inspect).

In the window, click the repo name (top left) or press **Ctrl+O** to switch repositories.
Theme, panel width, window size and last repo are saved in `~/.config/ggit/prefs.json`.

## Keyboard

| Key | Action |
| --- | --- |
| `↑` `↓` / `k` `j` | move between commits |
| `/` | search; `Enter` / `Shift+Enter` next / previous match |
| `p` | go to parent |
| `h` | jump to HEAD |
| `r` | reload |
| `?` | help: how to read the graph |
