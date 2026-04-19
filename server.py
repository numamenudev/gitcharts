"""GitCharts server with regeneration API."""

import json
import re
import subprocess
import threading
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

CONFIG_PATH = Path("repos_config.json")
SCRIPT_PATH = Path("git_archaeology.py")
HOTSPOT_SCRIPT_PATH = Path("hotspot_analysis.py")

# Track regeneration status
status = {
    "running": False, "repo": None, "progress": "", "error": None,
    "detail": None,  # {stage, label, current, total, elapsed, eta, global_pct}
    "cancelled": False,
}

# Global references for cancel support + progress aggregation
_current_proc = None
_global_plan = {
    "total_weight": 0,
    "done_weight": 0,
    "current_stage_weight": 0,
    "started_at": 0,
}

PROGRESS_RE = re.compile(r"^PROGRESS: (\d+)/(\d+) ?(.*)$")
STAGE_RE = re.compile(r"^STAGE: (\S+) weight=(\d+)$")


def _recompute_global(current_in_stage, total_in_stage):
    """Return global pct (0-100) based on plan state."""
    plan = _global_plan
    if plan["total_weight"] <= 0:
        return 0.0
    stage_frac = (current_in_stage / total_in_stage) if total_in_stage > 0 else 0
    done = plan["done_weight"] + stage_frac * plan["current_stage_weight"]
    return max(0.0, min(100.0, (done / plan["total_weight"]) * 100))


def _stream_with_progress(proc, stage_label):
    """Read proc.stdout line-by-line, parse STAGE/PROGRESS and update status."""
    for raw in proc.stdout:
        if status.get("cancelled"):
            try: proc.terminate()
            except Exception: pass
            break
        line = raw.rstrip("\r\n")
        ms = STAGE_RE.match(line)
        if ms:
            # Advance plan: finish current stage, start a new one
            _global_plan["done_weight"] += _global_plan["current_stage_weight"]
            _global_plan["current_stage_weight"] = int(ms.group(2))
            status["detail"] = {
                "stage": stage_label,
                "label": f"starting {ms.group(1)}",
                "current": 0, "total": 1,
                "elapsed": round(time.time() - _global_plan["started_at"], 1),
                "eta": None,
                "global_pct": round(_recompute_global(0, 1), 1),
            }
            continue
        mp = PROGRESS_RE.match(line)
        if mp:
            current = int(mp.group(1))
            total = int(mp.group(2))
            label = mp.group(3).strip()
            elapsed = time.time() - _global_plan["started_at"]
            gpct = _recompute_global(current, total)
            # Global ETA based on elapsed vs global completion
            frac = gpct / 100
            eta = (elapsed / frac * (1 - frac)) if frac > 0.01 else None
            status["detail"] = {
                "stage": stage_label,
                "label": label,
                "current": current, "total": total,
                "elapsed": round(elapsed, 1),
                "eta": round(eta, 1) if eta is not None else None,
                "global_pct": round(gpct, 1),
            }
    proc.wait()
    # Finalize: assume the last stage of this subprocess is done
    _global_plan["done_weight"] += _global_plan["current_stage_weight"]
    _global_plan["current_stage_weight"] = 0


def run_hotspot(repo_name, config, branch="", save_as="", path_prefix="", timeline=0, timeline_granularity="snapshot"):
    """Run hotspot_analysis.py for a single repo/branch. Streams progress."""
    cmd = [
        "uv", "run", str(HOTSPOT_SCRIPT_PATH),
        "--repo", config["url"],
        "--file-extensions", config.get("extensions", ".py,.js,.ts,.java,.c,.cpp,.h,.go,.rs"),
    ]
    if branch:
        cmd += ["--branch", branch]
        if save_as and save_as != branch:
            cmd += ["--branch-label", save_as]
    if path_prefix:
        cmd += ["--path-prefix", path_prefix]
    if timeline and timeline > 0:
        cmd += ["--timeline", str(timeline)]
    if timeline_granularity and timeline_granularity != "snapshot":
        cmd += ["--timeline-granularity", timeline_granularity]

    global _current_proc
    stage_label = f"hotspot {branch or 'main'}" + (f" @ {path_prefix}" if path_prefix else "")
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    _current_proc = proc
    try:
        _stream_with_progress(proc, stage_label)
    finally:
        _current_proc = None


def regenerate_repo(repo_name, config, granularity, branch="", save_as=""):
    """Run git_archaeology.py for a single repo/branch. Cancellable."""
    global _current_proc
    cmd = [
        "uv", "run", str(SCRIPT_PATH),
        "--repo", config["url"],
        "--samples", str(config["samples"]),
        "--file-extensions", config["extensions"],
        "--granularity", granularity,
    ]
    if branch:
        cmd += ["--branch", branch]
        if save_as and save_as != branch:
            cmd += ["--branch-label", save_as]
    # Treat whole archaeology run as a single coarse stage
    _global_plan["done_weight"] += _global_plan["current_stage_weight"]
    _global_plan["current_stage_weight"] = 15
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    _current_proc = proc
    try:
        for _ in proc.stdout:
            if status.get("cancelled"):
                try: proc.terminate()
                except Exception: pass
                break
        proc.wait()
    finally:
        _current_proc = None
    _global_plan["done_weight"] += _global_plan["current_stage_weight"]
    _global_plan["current_stage_weight"] = 0
    if proc.returncode != 0 and not status.get("cancelled"):
        raise RuntimeError(f"archaeology exited {proc.returncode}")


_BRANCH_CACHE = {}


def list_remote_branches(config):
    """Return sorted list of all remote branches. Cached per URL for ~10 min."""
    url = config["url"]
    now = time.time()
    entry = _BRANCH_CACHE.get(url)
    if entry and now - entry[0] < 600:
        return entry[1]
    result = subprocess.run(
        ["git", "ls-remote", "--heads", url],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        return []
    branches = sorted(set(re.findall(r"refs/heads/(\S+)", result.stdout)))
    _BRANCH_CACHE[url] = (now, branches)
    return branches


def get_develop_branch(config):
    """Find the develop branch (develop, development, dev) for this repo."""
    branches = list_remote_branches(config)
    for candidate in ("develop", "development", "dev"):
        if candidate in branches:
            return candidate
    return None


def sanitize_branch_label(branch):
    """Turn a branch name into a filename-safe suffix."""
    return re.sub(r"[^a-zA-Z0-9._-]+", "-", branch).strip("-") or "branch"


def regenerate_single(repo_name, granularity, path_prefix="", timeline=0, skip_archaeology=False, timeline_granularity="snapshot", branch=""):
    """Regenerate a single repo. If branch is set, run only that branch; else run main + develop if exists."""
    global status
    status = {
        "running": True, "repo": repo_name, "progress": "", "error": None,
        "detail": None, "cancelled": False,
    }

    # Initialize plan. We don't know upfront if develop exists, so conservative:
    # main + maybe develop × (archaeology + hotspot[+timeline])
    # Each branch: archaeology=15 + snapshot=5 + (timeline*3 if timeline)
    # We guess develop exists; if not, weights still work out since we finalize per-stage.
    per_branch = (15 if not (skip_archaeology or path_prefix) else 0) + 5
    if timeline and timeline > 0:
        per_branch += timeline * 3
    _global_plan["total_weight"] = per_branch * 2  # assume dev exists; tighten later
    _global_plan["done_weight"] = 0
    _global_plan["current_stage_weight"] = 0
    _global_plan["started_at"] = time.time()

    try:
        with open(CONFIG_PATH) as f:
            repos = json.load(f)

        if repo_name not in repos:
            raise RuntimeError(f"Unknown repo: {repo_name}")

        config = repos[repo_name]

        if branch:
            # Custom-branch mode: only run the one requested branch
            _global_plan["total_weight"] = per_branch
            label = sanitize_branch_label(branch)
            status["progress"] = branch
            if status.get("cancelled"): return
            if not skip_archaeology and not path_prefix:
                regenerate_repo(repo_name, config, granularity, branch=branch, save_as=label)
            if status.get("cancelled"): return
            run_hotspot(repo_name, config, branch=branch, save_as=label,
                        path_prefix=path_prefix, timeline=timeline,
                        timeline_granularity=timeline_granularity)
        else:
            # Legacy main + develop pair
            dev_branch = get_develop_branch(config)
            if not dev_branch:
                _global_plan["total_weight"] = per_branch

            status["progress"] = "main"
            if status.get("cancelled"): return
            if not skip_archaeology and not path_prefix:
                regenerate_repo(repo_name, config, granularity)
            if status.get("cancelled"): return
            run_hotspot(repo_name, config, path_prefix=path_prefix, timeline=timeline, timeline_granularity=timeline_granularity)

            if dev_branch and not status.get("cancelled"):
                status["progress"] = "develop"
                if not skip_archaeology and not path_prefix:
                    regenerate_repo(repo_name, config, granularity, branch=dev_branch, save_as="develop")
                if status.get("cancelled"): return
                run_hotspot(repo_name, config, branch=dev_branch, save_as="develop",
                            path_prefix=path_prefix, timeline=timeline,
                            timeline_granularity=timeline_granularity)

        subprocess.run(
            ["uv", "run", "python", "generate_repos_list.py"],
            capture_output=True, text=True,
        )
        status["repo"] = None
    except Exception as e:
        status["error"] = str(e)
    finally:
        status["running"] = False


def regenerate_all(granularity):
    """Regenerate all repos in background."""
    global status
    status = {"running": True, "repo": None, "progress": "", "error": None}

    try:
        with open(CONFIG_PATH) as f:
            repos = json.load(f)

        total = len(repos)
        for i, (name, config) in enumerate(repos.items(), 1):
            status["repo"] = name
            status["progress"] = f"{i}/{total} main"
            regenerate_repo(name, config, granularity)
            run_hotspot(name, config)

            dev_branch = get_develop_branch(config)
            if dev_branch:
                status["progress"] = f"{i}/{total} develop"
                regenerate_repo(name, config, granularity, branch=dev_branch, save_as="develop")
                run_hotspot(name, config, branch=dev_branch, save_as="develop")

        subprocess.run(
            ["uv", "run", "python", "generate_repos_list.py"],
            capture_output=True, text=True,
        )
        status["progress"] = f"{total}/{total}"
        status["repo"] = None
    except Exception as e:
        status["error"] = str(e)
    finally:
        status["running"] = False


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/status":
            self._json_response(status)
        elif self.path == "/api/config":
            with open(CONFIG_PATH) as f:
                self._json_response(json.load(f))
        elif self.path.startswith("/api/branches"):
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            repo_name = (qs.get("repo") or [""])[0]
            if not repo_name:
                self._json_response({"error": "missing repo"}, code=400)
                return
            with open(CONFIG_PATH) as f:
                repos = json.load(f)
            config = repos.get(repo_name)
            if not config:
                self._json_response({"error": "unknown repo"}, code=404)
                return
            branches = list_remote_branches(config)
            self._json_response({"branches": branches})
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == "/api/cancel":
            if not status["running"]:
                self._json_response({"error": "Nothing running"}, code=409)
                return
            status["cancelled"] = True
            try:
                if _current_proc is not None:
                    _current_proc.terminate()
            except Exception:
                pass
            self._json_response({"cancelling": True})
            return
        if self.path == "/api/regenerate":
            if status["running"]:
                self._json_response({"error": "Already running"}, code=409)
                return

            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            granularity = body.get("granularity", "Week")
            repo = body.get("repo")
            path_prefix = body.get("path_prefix", "")
            timeline = int(body.get("timeline", 0) or 0)
            timeline_granularity = body.get("timeline_granularity", "snapshot")
            branch = body.get("branch", "")

            if repo:
                target = regenerate_single
                args = (repo, granularity, path_prefix, timeline, bool(path_prefix), timeline_granularity, branch)
            else:
                target = regenerate_all
                args = (granularity,)

            thread = threading.Thread(target=target, args=args, daemon=True)
            thread.start()
            self._json_response({"started": True})
        else:
            self.send_error(404)

    def do_PUT(self):
        if self.path == "/api/config":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            with open(CONFIG_PATH, "w") as f:
                json.dump(body, f, indent=2)
                f.write("\n")
            self._json_response({"saved": True})
        else:
            self.send_error(404)

    def _json_response(self, data, code=200):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # Prevent caching of JS/HTML files during development
        if self.path.endswith(('.js', '.html')) or self.path == '/':
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def log_message(self, format, *args):
        pass  # Silence request logs


if __name__ == "__main__":
    import sys
    host = sys.argv[1] if len(sys.argv) > 1 else "0.0.0.0"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8000
    server = HTTPServer((host, port), Handler)
    print(f"GitCharts server running on http://{host}:{port}")
    server.serve_forever()
