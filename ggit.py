#!/usr/bin/env python3
"""ggit — a modern, friendly git history viewer (a gitk alternative).

Usage:
    ggit [PATH]                 open a desktop window for the repo
    ggit --browser [PATH]       view it in your web browser instead
    ggit --install              add ggit to your applications menu
    ggit --update               update ggit to the latest version

A small local server (bound to 127.0.0.1 only) feeds the UI. Needs Python 3.8+
and git; the desktop window also uses GTK 3 + WebKit2GTK (python3-gi).
"""
import argparse
import hashlib
import json
import mimetypes
import os
import re
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

STATIC_DIR = os.path.join(os.path.dirname(os.path.realpath(__file__)), "static")
VERSION = "0.1.0"
HASH_RE = re.compile(r"^[0-9a-fA-F]{4,64}$")
MAX_DIFF_BYTES = 3_000_000
DEFAULT_LIMIT = 5000
INSTALLER_URL = "https://raw.githubusercontent.com/rbshah29/ggit/main/install.sh"


class GitError(Exception):
    pass


def git(repo, *args, check=True):
    cmd = ["git", "-C", repo, "-c", "core.quotepath=false", "-c", "color.ui=false", *args]
    env = dict(os.environ, GIT_PAGER="cat", GIT_OPTIONAL_LOCKS="0")
    p = subprocess.run(cmd, capture_output=True, env=env)
    if check and p.returncode != 0:
        msg = p.stderr.decode("utf-8", "replace").strip()
        raise GitError(msg or "git %s failed" % args[0])
    return p.stdout.decode("utf-8", "replace")


def find_repo_root(path):
    try:
        return git(path, "rev-parse", "--show-toplevel").strip()
    except (GitError, FileNotFoundError, NotADirectoryError):
        return None


def head_info(repo):
    head = git(repo, "rev-parse", "--verify", "-q", "HEAD", check=False).strip() or None
    branch = git(repo, "symbolic-ref", "-q", "--short", "HEAD", check=False).strip() or None
    return head, branch


def empty_tree(repo):
    return git(repo, "hash-object", "-t", "tree", "/dev/null").strip()


# ---------------------------------------------------------------- endpoints

def api_repo(repo):
    head, branch = head_info(repo)
    gitdir = git(repo, "rev-parse", "--absolute-git-dir").strip()
    state = None
    for fname, label in (
        ("MERGE_HEAD", "merging"),
        ("rebase-merge", "rebasing"),
        ("rebase-apply", "rebasing"),
        ("CHERRY_PICK_HEAD", "cherry-picking"),
        ("REVERT_HEAD", "reverting"),
        ("BISECT_LOG", "bisecting"),
    ):
        if os.path.exists(os.path.join(gitdir, fname)):
            state = label
            break
    return {
        "path": repo,
        "name": os.path.basename(repo),
        "head": head,
        "branch": branch,
        "detached": bool(head and not branch),
        "state": state,
    }


def api_refs(repo):
    fmt = "%00".join([
        "%(refname)", "%(objectname)", "%(*objectname)",
        "%(upstream:short)", "%(upstream:track,nobracket)",
    ])
    out = git(repo, "for-each-ref", "--format=" + fmt, "refs/heads", "refs/remotes", "refs/tags")
    refs = []
    for line in out.splitlines():
        parts = line.split("\0")
        if len(parts) < 5:
            continue
        name, obj, peeled, upstream, track = parts[:5]
        if name.startswith("refs/heads/"):
            kind, short = "branch", name[len("refs/heads/"):]
        elif name.startswith("refs/remotes/"):
            if name.endswith("/HEAD"):
                continue
            kind, short = "remote", name[len("refs/remotes/"):]
        elif name.startswith("refs/tags/"):
            kind, short = "tag", name[len("refs/tags/"):]
        else:
            continue
        ref = {"name": short, "full": name, "kind": kind, "hash": peeled or obj}
        if kind == "branch" and upstream:
            ref["upstream"] = upstream
            ahead = re.search(r"ahead (\d+)", track)
            behind = re.search(r"behind (\d+)", track)
            ref["ahead"] = int(ahead.group(1)) if ahead else 0
            ref["behind"] = int(behind.group(1)) if behind else 0
            ref["gone"] = "gone" in track
        refs.append(ref)
    return refs


def api_log(repo, scope, limit):
    head, _ = head_info(repo)
    if scope == "all":
        revs = ["--branches", "--remotes", "--tags"] + (["HEAD"] if head else [])
    elif scope == "head":
        if not head:
            return {"commits": [], "truncated": False}
        revs = ["HEAD"]
    else:
        valid = {r["full"] for r in api_refs(repo)}
        if scope not in valid:
            raise GitError("Unknown ref: %s" % scope)
        revs = ["--end-of-options", scope]
    if not head and not api_refs(repo):
        return {"commits": [], "truncated": False}

    fmt = "%x1f".join(["%H", "%P", "%an", "%ae", "%at", "%s"])
    out = git(repo, "log", "--topo-order", "--max-count=%d" % limit, "--format=" + fmt, *revs)
    commits = []
    for line in out.split("\n"):
        if not line:
            continue
        p = line.split("\x1f")
        if len(p) < 6:
            continue
        commits.append({
            "hash": p[0],
            "parents": p[1].split() if p[1] else [],
            "author": p[2],
            "email": p[3],
            "time": int(p[4]),
            "subject": "\x1f".join(p[5:]),
        })
    return {"commits": commits, "truncated": len(commits) >= limit}


def _parse_files(name_status, numstat):
    """Combine `--name-status -z` and `--numstat -z` output into a file list."""
    files = []
    tok = name_status.split("\0")
    i = 0
    while i < len(tok):
        st = tok[i]
        if not st:
            i += 1
            continue
        code = st[0]
        if code in "RC":
            files.append({"status": code, "old": tok[i + 1], "path": tok[i + 2]})
            i += 3
        else:
            files.append({"status": code, "path": tok[i + 1]})
            i += 2

    stats = []
    tok = numstat.split("\0")
    i = 0
    while i < len(tok):
        t = tok[i]
        if not t:
            i += 1
            continue
        a, d, path = t.split("\t", 2)
        if path == "":  # rename: old and new follow as separate tokens
            path = tok[i + 2]
            i += 3
        else:
            i += 1
        stats.append((path, a, d))
    by_path = {p: (a, d) for p, a, d in stats}
    for f in files:
        a, d = by_path.get(f["path"], ("0", "0"))
        f["binary"] = a == "-"
        f["added"] = 0 if a == "-" else int(a)
        f["deleted"] = 0 if d == "-" else int(d)
    return files


def _diff(repo, base, target_args):
    common = ["diff", "-M", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"]
    name_status = git(repo, *common, "--name-status", "-z", base, *target_args)
    numstat = git(repo, *common, "--numstat", "-z", base, *target_args)
    patch = git(repo, *common, "-p", base, *target_args)
    truncated = len(patch) > MAX_DIFF_BYTES
    if truncated:
        patch = patch[:MAX_DIFF_BYTES]
        patch = patch[: patch.rfind("\ndiff --git ") + 1] or patch
    return _parse_files(name_status, numstat), patch, truncated


def api_commit(repo, h):
    if not HASH_RE.match(h):
        raise GitError("Invalid commit id")
    fmt = "%x00".join(["%H", "%P", "%an", "%ae", "%at", "%cn", "%ce", "%ct", "%B"])
    raw = git(repo, "show", "-s", "--format=" + fmt, h, "--")
    p = raw.split("\0", 8)
    parents = p[1].split() if p[1] else []
    base = parents[0] if parents else empty_tree(repo)
    files, patch, truncated = _diff(repo, base, [p[0]])
    return {
        "hash": p[0],
        "parents": parents,
        "author": p[2], "email": p[3], "time": int(p[4]),
        "committer": p[5], "committerEmail": p[6], "commitTime": int(p[7]),
        "message": p[8].rstrip("\n"),
        "files": files,
        "patch": patch,
        "truncated": truncated,
    }


def api_status(repo):
    out = git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    entries = []
    tok = out.split("\0")
    i = 0
    while i < len(tok):
        t = tok[i]
        if not t:
            i += 1
            continue
        xy, path = t[:2], t[3:]
        e = {"x": xy[0], "y": xy[1], "path": path}
        i += 1
        if xy[0] in "RC":  # rename source follows
            e["old"] = tok[i]
            i += 1
        entries.append(e)
    return entries


def api_worktree(repo):
    head, _ = head_info(repo)
    base = head or empty_tree(repo)
    files, patch, truncated = _diff(repo, base, [])
    return {
        "status": api_status(repo),
        "files": files,
        "patch": patch,
        "truncated": truncated,
    }


def api_contains(repo, h):
    if not HASH_RE.match(h):
        raise GitError("Invalid commit id")
    branches = git(repo, "branch", "-a", "--contains", h, "--format=%(refname)").split()
    tags = git(repo, "tag", "--contains", h, "--format=%(refname:short)").split()
    return {
        "branches": [b[len("refs/heads/"):] for b in branches if b.startswith("refs/heads/")],
        "remotes": [b[len("refs/remotes/"):] for b in branches
                    if b.startswith("refs/remotes/") and not b.endswith("/HEAD")],
        "tags": tags,
    }


def api_fingerprint(repo):
    """Cheap-ish hash of refs + HEAD + working tree state, for auto-refresh."""
    h = hashlib.sha1()
    h.update(git(repo, "for-each-ref", "--format=%(refname) %(objectname)").encode())
    h.update(git(repo, "rev-parse", "-q", "--verify", "HEAD", check=False).encode())
    h.update(git(repo, "symbolic-ref", "-q", "HEAD", check=False).encode())
    h.update(git(repo, "status", "--porcelain=v1", "-z").encode())
    return {"fingerprint": h.hexdigest()}


# ------------------------------------------------------------------ prefs
# Small settings file shared by the browser and desktop modes. (localStorage
# can't be used: the server picks a new port each run, which is a new origin.)

CLIENT_PREF_KEYS = {"theme", "scope", "detailsW"}
APP_PREF_KEYS = CLIENT_PREF_KEYS | {"lastRepo", "winW", "winH", "winMax"}


def prefs_path():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, "ggit", "prefs.json")


_prefs_lock = threading.Lock()


def load_prefs():
    try:
        with open(prefs_path(), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def update_prefs(changes):
    changes = {k: v for k, v in changes.items()
               if k in APP_PREF_KEYS and isinstance(v, (str, int, float, bool))}
    if not changes:
        return
    with _prefs_lock:
        prefs = load_prefs()
        prefs.update(changes)
        path = prefs_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(prefs, f, indent=2)
        os.replace(tmp, path)


# ------------------------------------------------------------------ server

def make_handler(ctx):
    """ctx is a dict with 'repo' and 'limit'; 'repo' may change at runtime."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # keep the terminal quiet
            pass

        def _send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj, code=200):
            self._send(code, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

        def do_GET(self):
            url = urlparse(self.path)
            q = parse_qs(url.query)
            path = url.path
            repo = ctx["repo"]
            try:
                if path == "/api/repo":
                    return self._json(api_repo(repo))
                if path == "/api/refs":
                    return self._json(api_refs(repo))
                if path == "/api/log":
                    scope = q.get("scope", ["all"])[0]
                    limit = int(q.get("limit", [ctx["limit"]])[0])
                    return self._json(api_log(repo, scope, max(1, min(limit, 500000))))
                if path.startswith("/api/commit/"):
                    return self._json(api_commit(repo, unquote(path[len("/api/commit/"):])))
                if path == "/api/worktree":
                    return self._json(api_worktree(repo))
                if path == "/api/status":
                    return self._json(api_status(repo))
                if path.startswith("/api/contains/"):
                    return self._json(api_contains(repo, unquote(path[len("/api/contains/"):])))
                if path == "/api/fingerprint":
                    return self._json(api_fingerprint(repo))
                if path.startswith("/api/"):
                    return self._json({"error": "Not found"}, 404)
                return self._static(path)
            except (GitError, ValueError) as e:
                return self._json({"error": str(e)}, 500)
            except BrokenPipeError:
                pass

        def do_POST(self):
            if urlparse(self.path).path != "/api/prefs":
                return self._json({"error": "Not found"}, 404)
            # Requiring a JSON content type means other websites can't post here
            # without a CORS preflight, which this server never approves.
            if not self.headers.get("Content-Type", "").startswith("application/json"):
                return self._json({"error": "Expected JSON"}, 415)
            length = int(self.headers.get("Content-Length") or 0)
            if length > 10_000:
                return self._json({"error": "Too large"}, 413)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(data, dict):
                    raise ValueError
            except ValueError:
                return self._json({"error": "Bad JSON"}, 400)
            update_prefs({k: v for k, v in data.items() if k in CLIENT_PREF_KEYS})
            return self._json({"ok": True})

        def _static(self, path):
            if path == "/":
                path = "/index.html"
            full = os.path.realpath(os.path.join(STATIC_DIR, path.lstrip("/")))
            if not full.startswith(os.path.realpath(STATIC_DIR) + os.sep) or not os.path.isfile(full):
                return self._send(404, b"Not found", "text/plain")
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            with open(full, "rb") as f:
                body = f.read()
            if path == "/index.html":
                # Inline saved prefs so the theme is right on the very first paint.
                prefs = {k: v for k, v in load_prefs().items() if k in CLIENT_PREF_KEYS}
                js = json.dumps(prefs).replace("<", "\\u003c")
                body = body.replace(b"<!--PREFS-->", ("<script>window.GGIT_PREFS=%s;</script>" % js).encode())
            self._send(200, body, ctype)

    return Handler


def start_server(ctx, port=0):
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(ctx))
    server.daemon_threads = True
    url = "http://127.0.0.1:%d/" % server.server_address[1]
    return server, url


def run_browser(ctx, args):
    server, url = start_server(ctx, args.port)
    print("ggit: viewing %s" % ctx["repo"])
    print("ggit: open %s  (Ctrl+C to quit)" % url, flush=True)
    if not args.no_browser:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nggit: bye")


def self_update():
    """Update ggit in place, using apt for the .deb install or the installer otherwise."""
    here = os.path.realpath(__file__)
    print("ggit: current version " + VERSION)
    if here.startswith("/usr/lib/ggit/"):
        sources = "/etc/apt/sources.list.d/ggit.list"
        if os.path.exists(sources):
            # Refresh only the ggit source so this is quick, then upgrade.
            steps = [
                ["sudo", "apt-get", "update",
                 "-o", "Dir::Etc::sourcelist=" + sources,
                 "-o", "Dir::Etc::sourceparts=-",
                 "-o", "APT::Get::List-Cleanup=0"],
                ["sudo", "apt-get", "install", "--only-upgrade", "-y", "ggit"],
            ]
            for cmd in steps:
                if subprocess.run(cmd).returncode != 0:
                    sys.exit("ggit: update failed while running: " + " ".join(cmd))
        else:
            # Installed from a locally built .deb: rebuild from the latest source.
            run_installer("--deb")
    else:
        run_installer("--user")
    v = subprocess.run(["ggit", "--version"], capture_output=True, text=True)
    print("ggit: now at " + (v.stdout.strip() or "unknown version").replace("ggit ", ""))
    print("Restart any open ggit windows to use the new version.")


def run_installer(mode):
    print("ggit: downloading the latest installer...")
    cmd = "curl -fsSL %s | bash -s -- %s" % (INSTALLER_URL, mode)
    if subprocess.run(["bash", "-c", "set -o pipefail; " + cmd]).returncode != 0:
        sys.exit("ggit: update failed")


def main():
    ap = argparse.ArgumentParser(
        description="A modern, friendly git history viewer.",
        epilog="By default ggit opens as a desktop window (GTK + WebKit). "
               "Use --browser to view it in your web browser instead.")
    ap.add_argument("path", nargs="?", help="path inside a git repository (default: current folder)")
    ap.add_argument("--browser", action="store_true", help="serve the UI to your web browser instead of a window")
    ap.add_argument("--port", type=int, default=0, help="browser mode: port to listen on (default: random)")
    ap.add_argument("--no-browser", action="store_true", help="browser mode: don't open a browser automatically")
    ap.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="max commits to load initially")
    ap.add_argument("--pick", action="store_true", help="ask which repository to open")
    ap.add_argument("--foreground", action="store_true", help="desktop mode: don't detach from the terminal")
    ap.add_argument("--debug", action="store_true", help="desktop mode: enable the web inspector (right-click)")
    ap.add_argument("--install", action="store_true", help="add ggit to your applications menu")
    ap.add_argument("--uninstall", action="store_true", help="remove ggit from your applications menu")
    ap.add_argument("--update", action="store_true", help="update ggit to the latest version")
    ap.add_argument("-v", "--version", action="version", version="ggit " + VERSION)
    args = ap.parse_args()

    if args.update:
        return self_update()

    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    if args.install or args.uninstall:
        import desktop
        return desktop.install() if args.install else desktop.uninstall()

    repo = None if args.pick else find_repo_root(os.path.abspath(args.path or "."))
    if args.path and not repo and not args.pick:
        sys.exit("ggit: '%s' is not inside a git repository" % args.path)

    use_app = not args.browser
    if use_app:
        import desktop
        problem = desktop.unavailable_reason()
        if problem:
            print("ggit: desktop window unavailable (%s); using the browser instead" % problem, file=sys.stderr)
            use_app = False

    if not use_app:
        if not repo:
            sys.exit("ggit: not inside a git repository (pass a path)")
        return run_browser({"repo": repo, "limit": args.limit}, args)

    # Detach so the terminal is free again, like most GUI apps.
    if not args.foreground and sys.stdin.isatty():
        cmd = [sys.executable, os.path.realpath(__file__), "--foreground", "--limit", str(args.limit)]
        if repo:
            cmd.insert(2, repo)
        if args.debug:
            cmd.append("--debug")
        subprocess.Popen(cmd, start_new_session=True, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return

    desktop.run_app({"repo": repo, "limit": args.limit}, debug=args.debug)


if __name__ == "__main__":
    main()
