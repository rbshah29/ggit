"""Desktop mode for ggit: a native GTK window around the web UI.

Uses GTK 3 + WebKit2GTK through PyGObject, which ship with most GNOME-based
distros (Ubuntu: python3-gi, gir1.2-webkit2-4.1).
"""
import os
import shutil
import subprocess
import sys
import threading

import ggit

APP_ID = "ggit"
HERE = os.path.dirname(os.path.realpath(__file__))
ICON_SRC = os.path.join(HERE, "static", "icon.svg")
DATA_HOME = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
DESKTOP_FILE = os.path.join(DATA_HOME, "applications", APP_ID + ".desktop")
ICON_FILE = os.path.join(DATA_HOME, "icons", "hicolor", "scalable", "apps", APP_ID + ".svg")
SYSTEM_ICON_FILE = "/usr/share/icons/hicolor/scalable/apps/" + APP_ID + ".svg"

# Window background before the page paints (matches --bg in style.css).
BG = {"dark": (0x0b, 0x0c, 0x0f), "light": (0xfa, 0xfa, 0xfa)}


_gi = None


def _import_gi():
    global _gi
    if _gi:
        return _gi
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    gi.require_version("WebKit2", "4.1")
    from gi.repository import GLib
    # Must happen before GTK initialises: this is the window's app id / WM_CLASS,
    # which lets GNOME match the window to ggit.desktop (dock icon, grouping).
    GLib.set_prgname(APP_ID)
    GLib.set_application_name("ggit")
    from gi.repository import Gdk, Gtk, WebKit2
    _gi = (GLib, Gdk, Gtk, WebKit2)
    return _gi


def unavailable_reason():
    """Return None if a desktop window can be shown, else a short reason."""
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return "no graphical display"
    try:
        _import_gi()
    except (ImportError, ValueError) as e:
        return "GTK/WebKit2GTK not found: %s" % e
    return None


# ------------------------------------------------------------------ helpers

def pick_repo(Gtk, parent, start=None):
    """Ask for a folder until it's inside a git repo. Returns repo root or None."""
    while True:
        dlg = Gtk.FileChooserNative.new(
            "Open a git repository", parent, Gtk.FileChooserAction.SELECT_FOLDER, "_Open", "_Cancel")
        if start and os.path.isdir(start):
            dlg.set_current_folder(start)
        resp = dlg.run()
        path = dlg.get_filename() if resp == Gtk.ResponseType.ACCEPT else None
        dlg.destroy()
        if not path:
            return None
        repo = ggit.find_repo_root(path)
        if repo:
            return repo
        msg = Gtk.MessageDialog(
            transient_for=parent, modal=True, message_type=Gtk.MessageType.WARNING,
            buttons=Gtk.ButtonsType.OK, text="That folder isn't a git repository")
        msg.format_secondary_text("%s\n\nPick a folder that contains a .git directory "
                                  "(or any folder inside one)." % path)
        msg.run()
        msg.destroy()
        start = path


def window_title(repo):
    return "%s — ggit" % os.path.basename(repo)


# ------------------------------------------------------------------ app

def run_app(ctx, debug=False):
    GLib, Gdk, Gtk, WebKit2 = _import_gi()
    prefs = ggit.load_prefs()

    if not ctx["repo"]:
        ctx["repo"] = pick_repo(Gtk, None, prefs.get("lastRepo") or os.path.expanduser("~"))
        if not ctx["repo"]:
            return
    ggit.update_prefs({"lastRepo": ctx["repo"]})

    server, url = ggit.start_server(ctx)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    win = Gtk.Window(title=window_title(ctx["repo"]))
    win.set_default_size(int(prefs.get("winW", 1440)), int(prefs.get("winH", 900)))
    if prefs.get("winMax"):
        win.maximize()
    if os.path.exists(ICON_FILE) or os.path.exists(SYSTEM_ICON_FILE):
        win.set_icon_name(APP_ID)
    else:
        try:
            win.set_icon_from_file(ICON_SRC)
        except GLib.Error:
            pass

    # JS -> Python bridge: window.webkit.messageHandlers.ggit.postMessage("open")
    manager = WebKit2.UserContentManager()
    manager.register_script_message_handler("ggit")

    view = WebKit2.WebView.new_with_user_content_manager(manager)
    settings = view.get_settings()
    settings.set_enable_developer_extras(debug)
    settings.set_javascript_can_access_clipboard(True)
    settings.set_enable_back_forward_navigation_gestures(False)
    rgb = BG["dark" if prefs.get("theme") == "dark" else "light"]
    view.set_background_color(Gdk.RGBA(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1))

    if not debug:
        view.connect("context-menu", lambda *a: True)  # no "Back / Reload" menu

    def on_policy(_view, decision, kind):
        # Keep the window on our own pages; send any other link to the browser.
        if kind == WebKit2.PolicyDecisionType.NAVIGATION_ACTION:
            uri = decision.get_navigation_action().get_request().get_uri()
            if not uri.startswith(url):
                decision.ignore()
                Gtk.show_uri_on_window(win, uri, Gdk.CURRENT_TIME)
                return True
        return False
    view.connect("decide-policy", on_policy)

    def open_other_repo():
        repo = pick_repo(Gtk, win, os.path.dirname(ctx["repo"]))
        if repo and repo != ctx["repo"]:
            ctx["repo"] = repo
            ggit.update_prefs({"lastRepo": repo})
            win.set_title(window_title(repo))
            view.load_uri(url)

    def on_message(_manager, result):
        try:
            msg = result.get_js_value().to_string()
        except AttributeError:
            msg = result.to_string()
        if msg == "open":
            GLib.idle_add(lambda: open_other_repo() and False)
    manager.connect("script-message-received::ggit", on_message)

    # Remember window size between runs.
    geom = {}

    def on_configure(w, _event):
        if not geom.get("winMax"):
            geom["winW"], geom["winH"] = w.get_size()
        return False

    def on_state(_w, event):
        geom["winMax"] = bool(event.new_window_state & Gdk.WindowState.MAXIMIZED)
        return False

    def on_close(*_):
        ggit.update_prefs(geom)
        return False

    win.connect("configure-event", on_configure)
    win.connect("window-state-event", on_state)
    win.connect("delete-event", on_close)
    win.connect("destroy", lambda *_: Gtk.main_quit())

    win.add(view)
    view.load_uri(url)
    win.show_all()
    Gtk.main()
    server.shutdown()


# ------------------------------------------------------------------ install

def _desktop_entry():
    script = os.path.join(HERE, "ggit.py")

    def q(arg):  # quoting rules from the Desktop Entry spec
        if any(c in arg for c in ' \t\n"\'\\><~|&;$*?#()`'):
            return '"%s"' % arg.replace("\\", "\\\\").replace('"', '\\"').replace("`", "\\`").replace("$", "\\$")
        return arg

    return "\n".join([
        "[Desktop Entry]",
        "Type=Application",
        "Name=ggit",
        "GenericName=Git History Viewer",
        "Comment=Browse git history with a friendly, modern commit graph",
        "Exec=%s %s --pick" % (q(sys.executable), q(script)),
        "Icon=" + APP_ID,
        "Terminal=false",
        "Categories=Development;RevisionControl;",
        "Keywords=git;history;log;commit;branch;graph;gitk;",
        "StartupWMClass=" + APP_ID,
        "StartupNotify=true",
        "",
    ])


def install():
    os.makedirs(os.path.dirname(DESKTOP_FILE), exist_ok=True)
    os.makedirs(os.path.dirname(ICON_FILE), exist_ok=True)
    shutil.copyfile(ICON_SRC, ICON_FILE)
    with open(DESKTOP_FILE, "w", encoding="utf-8") as f:
        f.write(_desktop_entry())
    _refresh_caches()
    print("ggit: installed\n  %s\n  %s" % (DESKTOP_FILE, ICON_FILE))
    print("ggit: search for \"ggit\" in your applications (it may take a few seconds to appear)")


def uninstall():
    for path in (DESKTOP_FILE, ICON_FILE):
        if os.path.exists(path):
            os.remove(path)
            print("ggit: removed %s" % path)
    _refresh_caches()


def _refresh_caches():
    for cmd in (["update-desktop-database", os.path.dirname(DESKTOP_FILE)],
                ["gtk-update-icon-cache", "-q", "-t", os.path.join(DATA_HOME, "icons", "hicolor")]):
        if shutil.which(cmd[0]):
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
