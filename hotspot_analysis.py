# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Hotspot analysis: identify risky files using git history and LOC."""

import argparse
import hashlib
import json
import math
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path


def progress(current: int, total: int, label: str = "") -> None:
    """Emit a machine-parseable progress line consumed by server.py."""
    print(f"PROGRESS: {current}/{total} {label}", flush=True)


def stage(name: str, weight: int) -> None:
    """Declare the start of a work stage with a relative weight."""
    print(f"STAGE: {name} weight={weight}", flush=True)


DOWNLOADS_DIR = Path(".downloads")


def get_cached_repo_path(repo_url: str) -> Path:
    repo_name = repo_url.rstrip("/").split("/")[-1].replace(".git", "")
    url_hash = hashlib.md5(repo_url.encode(), usedforsecurity=False).hexdigest()[:8]
    return DOWNLOADS_DIR / f"{repo_name}-{url_hash}"


def collect_file_metrics(
    repo_path: Path,
    extensions: list[str] | None,
    ref: str = "HEAD",
    path_prefix: str = "",
) -> dict[str, dict]:
    """Return per-file metrics: loc, changes, primary_author, hotspot_score."""
    ls_result = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", ref],
        cwd=repo_path, capture_output=True, text=True, encoding="utf-8",
    )
    all_files = {f for f in ls_result.stdout.splitlines() if f}
    if extensions:
        all_files = {f for f in all_files if any(f.endswith(ext) for ext in extensions)}
    if path_prefix:
        prefix = path_prefix.rstrip("/") + "/"
        all_files = {f for f in all_files if f.startswith(prefix) or f == path_prefix.rstrip("/")}

    # One git-log pass to get author + changed files per commit.
    # \x1f prefix/suffix around author name avoids collision with any filename.
    log_result = subprocess.run(
        ["git", "log", "--format=\x1f%an\x1f", "--name-only", ref],
        cwd=repo_path, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    changes_per_file: Counter = Counter()
    authors_per_file: dict[str, Counter] = defaultdict(Counter)
    current_author = "Unknown"

    for line in log_result.stdout.splitlines():
        # Do NOT call .strip() — Python treats \x1f as whitespace and would eat the markers.
        if line.startswith("\x1f") and line.endswith("\x1f") and len(line) > 1:
            current_author = line[1:-1].strip() or "Unknown"
        elif line and "\x1f" not in line:
            if line in all_files:
                changes_per_file[line] += 1
                authors_per_file[line][current_author] += 1

    # LOC: read directly from working tree (already checked out at correct ref)
    loc_per_file: dict[str, int] = {}
    file_list = sorted(all_files)
    n_files = len(file_list)
    for i, fname in enumerate(file_list):
        if i % 100 == 0 or i == n_files - 1:
            progress(i + 1, n_files, "reading LOC")
        fpath = repo_path / fname
        try:
            data = fpath.read_bytes()
            loc_per_file[fname] = data.count(b"\n") + (1 if data and not data.endswith(b"\n") else 0)
        except OSError:
            loc_per_file[fname] = 0

    metrics: dict[str, dict] = {}
    for fname in all_files:
        loc = loc_per_file.get(fname, 0)
        changes = changes_per_file.get(fname, 0)
        primary_author = authors_per_file[fname].most_common(1)[0][0] if authors_per_file[fname] else "Unknown"
        hotspot_score = round(changes * math.log(loc + 1), 2)
        metrics[fname] = {
            "loc": loc,
            "changes": changes,
            "primary_author": primary_author,
            "hotspot_score": hotspot_score,
        }
    return metrics


def build_tree_nodes(metrics: dict[str, dict]) -> list[dict]:
    """Build flat node list for Vega stratify+treemap transform."""
    nodes: list[dict] = [
        {"id": "root", "parent": None, "name": "root",
         "loc": 0, "changes": 0, "hotspot_score": 0.0, "primary_author": ""}
    ]
    seen_dirs: set[str] = set()

    for fpath in sorted(metrics):
        m = metrics[fpath]
        parts = fpath.replace("\\", "/").split("/")

        for depth in range(1, len(parts)):
            dir_id = "/".join(parts[:depth])
            if dir_id not in seen_dirs:
                parent = "/".join(parts[:depth - 1]) if depth > 1 else "root"
                nodes.append({
                    "id": dir_id, "parent": parent, "name": parts[depth - 1],
                    "loc": 0, "changes": 0, "hotspot_score": 0.0, "primary_author": "",
                })
                seen_dirs.add(dir_id)

        parent = "/".join(parts[:-1]) if len(parts) > 1 else "root"
        nodes.append({
            "id": fpath, "parent": parent, "name": parts[-1],
            "loc": max(m["loc"], 1),
            "changes": m["changes"],
            "hotspot_score": m["hotspot_score"],
            "primary_author": m["primary_author"],
        })
    return nodes


def build_vega_spec(nodes: list[dict], title: str) -> dict:
    """Generate a Vega v5 treemap spec with color = hotspot risk, size = LOC."""
    return {
        "$schema": "https://vega.github.io/schema/vega/v5.json",
        "description": f"Code Hotspot Map — {title}",
        "width": 900,
        "height": 540,
        "padding": 2.5,
        "autosize": "none",
        "data": [
            {
                "name": "tree",
                "values": nodes,
                "transform": [
                    {"type": "stratify", "key": "id", "parentKey": "parent"},
                    {
                        "type": "treemap",
                        "field": "loc",
                        "sort": {"field": "value", "order": "descending"},
                        "round": True,
                        "method": "squarify",
                        "ratio": 1.618,
                        "size": [{"signal": "width"}, {"signal": "height"}],
                        "paddingInner": 2,
                        "paddingTop": 16,
                        "paddingOuter": 3,
                    },
                ],
            },
            {
                "name": "leaves",
                "source": "tree",
                "transform": [{"type": "filter", "expr": "!datum.children"}],
            },
            {
                "name": "dirs",
                "source": "tree",
                "transform": [{"type": "filter", "expr": "datum.depth > 0 && datum.children"}],
            },
        ],
        "scales": [
            {
                "name": "color",
                "type": "linear",
                "domain": {"data": "leaves", "field": "hotspot_score"},
                "range": {"scheme": "redyellowgreen"},
                "reverse": True,
                "zero": True,
            }
        ],
        "legends": [
            {
                "fill": "color",
                "title": "Risk (changes \u00d7 log LOC)",
                "type": "gradient",
                "orient": "right",
                "gradientLength": 200,
                "gradientThickness": 14,
                "titleFontSize": 11,
                "labelFontSize": 10,
                "titleLimit": 200,
            }
        ],
        "marks": [
            # Directory background boxes
            {
                "type": "rect",
                "from": {"data": "dirs"},
                "encode": {
                    "enter": {
                        "x": {"field": "x0"}, "y": {"field": "y0"},
                        "x2": {"field": "x1"}, "y2": {"field": "y1"},
                        "fill": {"value": "#e8e8e8"},
                        "stroke": {"value": "#bbb"},
                        "strokeWidth": {"value": 1.5},
                    }
                },
            },
            # Directory name labels
            {
                "type": "text",
                "from": {"data": "dirs"},
                "encode": {
                    "enter": {
                        "x": {"field": "x0", "offset": 4},
                        "y": {"field": "y0", "offset": 12},
                        "text": {"field": "name"},
                        "fontSize": {"value": 12},
                        "fontWeight": {"value": "bold"},
                        "fill": {"value": "#222"},
                        "clip": {"value": True},
                        "limit": {"signal": "datum.x1 - datum.x0 - 8"},
                    }
                },
            },
            # File cells (colored by hotspot score)
            {
                "type": "rect",
                "from": {"data": "leaves"},
                "encode": {
                    "enter": {
                        "x": {"field": "x0"}, "y": {"field": "y0"},
                        "x2": {"field": "x1"}, "y2": {"field": "y1"},
                        "fill": {"scale": "color", "field": "hotspot_score"},
                        "tooltip": {
                            "signal": (
                                "{'File': datum.id, 'Lines of Code': datum.loc, "
                                "'Changes': datum.changes, 'Main Author': datum.primary_author, "
                                "'Risk Score': datum.hotspot_score}"
                            )
                        },
                    },
                    "update": {
                        "stroke": {"value": "white"},
                        "strokeWidth": {"value": 0.5},
                        "fillOpacity": {"value": 1},
                    },
                    "hover": {
                        "stroke": {"value": "#222"},
                        "strokeWidth": {"value": 2},
                        "fillOpacity": {"value": 0.85},
                        "cursor": {"value": "pointer"},
                    },
                },
            },
            # File name labels (only when cell is wide/tall enough to fit)
            {
                "type": "text",
                "from": {"data": "leaves"},
                "encode": {
                    "enter": {
                        "x": {"signal": "(datum.x0 + datum.x1) / 2"},
                        "y": {"signal": "(datum.y0 + datum.y1) / 2"},
                        "text": {
                            "signal": (
                                "(datum.x1 - datum.x0 > 55 && datum.y1 - datum.y0 > 20)"
                                " ? datum.name : ''"
                            )
                        },
                        "align": {"value": "center"},
                        "baseline": {"value": "middle"},
                        "fontSize": {"value": 11},
                        # Adaptive text color: dark on light fills, white on dark fills
                        "fill": {
                            "signal": (
                                "luminance(scale('color', datum.hotspot_score)) > 0.5"
                                " ? '#111' : '#fff'"
                            )
                        },
                        "fontWeight": {"value": "bold"},
                        "clip": {"value": True},
                        "limit": {"signal": "datum.x1 - datum.x0 - 6"},
                    }
                },
            },
        ],
    }


def generate_insights(metrics: dict[str, dict], repo_name: str) -> dict:
    """Produce specific, data-driven insights — no generic boilerplate."""
    if not metrics:
        return {
            "hotspots": [], "stable": [], "warnings": [], "suggestions": [],
            "total_files": 0, "total_changes": 0, "repo": repo_name,
        }

    total_changes = sum(m["changes"] for m in metrics.values())
    total_files = len(metrics)
    files_sorted = sorted(metrics.items(), key=lambda x: x[1]["hotspot_score"], reverse=True)

    hotspots = []
    for fpath, m in files_sorted:
        if m["hotspot_score"] <= 0:
            continue
        pct = round(m["changes"] / total_changes * 100) if total_changes > 0 else 0
        pct_str = f" ({pct}% of all repo modifications)" if pct >= 5 else ""
        reason = (
            f"Modified {m['changes']} times, {m['loc']:,} lines{pct_str}"
            " — strong indicator of accumulated technical debt."
        )
        hotspots.append({
            "file": fpath,
            "loc": m["loc"],
            "changes": m["changes"],
            "score": m["hotspot_score"],
            "primary_author": m["primary_author"],
            "reason": reason,
        })
        if len(hotspots) == 3:
            break

    dir_changes: Counter = Counter()
    dir_files: Counter = Counter()
    for fpath, m in metrics.items():
        top_dir = fpath.split("/")[0] if "/" in fpath else "(root)"
        dir_changes[top_dir] += m["changes"]
        dir_files[top_dir] += 1

    stable = []
    for dname, total in dir_changes.most_common()[::-1]:
        avg = total / dir_files[dname] if dir_files[dname] > 0 else 0
        if avg <= 2 and dir_files[dname] >= 3:
            stable.append({
                "path": dname,
                "total_changes": total,
                "file_count": dir_files[dname],
                "reason": (
                    f"{dir_files[dname]} files, {total} total changes "
                    f"(avg {avg:.1f}/file) — stable, rarely modified code."
                ),
            })
        if len(stable) >= 3:
            break

    warnings = []
    if files_sorted and total_changes > 0:
        top_file, top_m = files_sorted[0]
        top_pct = round(top_m["changes"] / total_changes * 100)
        if top_pct >= 20:
            warnings.append(
                f"'{top_file}' alone accounts for {top_pct}% of all {total_changes:,}"
                " modifications — extreme change concentration, consider restructuring."
            )

    never_changed = sum(1 for m in metrics.values() if m["changes"] == 0)
    if total_files > 0:
        never_pct = round(never_changed / total_files * 100)
        if never_pct > 30:
            warnings.append(
                f"{never_pct}% of files ({never_changed}/{total_files}) were never modified "
                "after creation — verify these are intentionally stable and not dead code."
            )

    suggestions = []
    if hotspots:
        top = hotspots[0]
        if top["loc"] > 500:
            suggestions.append(
                f"Split '{top['file']}' into smaller focused modules — "
                f"{top['loc']:,} lines and {top['changes']} modifications make it "
                "the biggest maintenance burden in the repo."
            )
        else:
            suggestions.append(
                f"Add comprehensive tests for '{top['file']}' — "
                f"it changes frequently ({top['changes']} times) "
                "and a regression here could have wide impact."
            )

    if len(hotspots) >= 2:
        suggestions.append(
            f"Prioritize code review for '{hotspots[0]['file']}' and '{hotspots[1]['file']}'"
            " — they carry the highest risk scores and are the most likely sources of future bugs."
        )

    return {
        "hotspots": hotspots,
        "stable": stable,
        "warnings": warnings,
        "suggestions": suggestions,
        "total_files": total_files,
        "total_changes": total_changes,
        "repo": repo_name,
    }


def _sample_commits(commits: list[dict], n_snapshots: int) -> list[dict]:
    """Evenly-spaced sampling across commit list."""
    if not commits:
        return []
    n = min(n_snapshots, len(commits))
    if n <= 1:
        return [commits[-1]]
    indices = [round(i * (len(commits) - 1) / (n - 1)) for i in range(n)]
    return [commits[i] for i in indices]


def _bucket_commits(commits: list[dict], granularity: str) -> list[dict]:
    """Keep the LAST commit of each time bucket (day/week/month)."""
    from datetime import datetime, timezone
    buckets: dict[str, dict] = {}
    for c in commits:
        dt = datetime.fromtimestamp(c["ts"], tz=timezone.utc)
        if granularity == "day":
            key = dt.strftime("%Y-%m-%d")
        elif granularity == "week":
            y, w, _ = dt.isocalendar()
            key = f"{y}-W{w:02d}"
        elif granularity == "month":
            key = dt.strftime("%Y-%m")
        else:
            raise ValueError(f"Unknown granularity: {granularity}")
        if key not in buckets or buckets[key]["ts"] < c["ts"]:
            buckets[key] = c
    return sorted(buckets.values(), key=lambda c: c["ts"])


def collect_timeline_metrics(
    repo_path: Path,
    extensions: list[str] | None,
    ref: str,
    n_snapshots: int,
    path_prefix: str = "",
    granularity: str = "snapshot",
) -> list[dict]:
    """Sample n_snapshots commits along history and collect per-file metrics at each.

    Uses git cat-file --batch-check to get approximate LOC (byte size / 25)
    to avoid N*M expensive git show calls.
    """
    # List commits with timestamp + author, oldest first
    log_result = subprocess.run(
        ["git", "log", "--reverse", f"--format=%H\t%ct\t%an", ref],
        cwd=repo_path, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    commits = []
    for line in log_result.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        commits.append({"sha": parts[0], "ts": int(parts[1]), "author": parts[2]})

    if not commits:
        return []

    # Walk forward computing cumulative change count + author per file
    name_only = subprocess.run(
        ["git", "log", "--reverse", "--name-only", "--format=::%H::%an", ref],
        cwd=repo_path, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )

    changes_so_far: dict[str, Counter] = {}  # per-commit snapshot
    authors_so_far: dict[str, dict[str, Counter]] = {}
    current_changes: Counter = Counter()
    current_authors: dict[str, Counter] = defaultdict(Counter)
    current_author = "Unknown"
    current_sha = None

    for line in name_only.stdout.splitlines():
        if line.startswith("::"):
            parts = line[2:].split("::", 1)
            if len(parts) == 2:
                current_sha = parts[0]
                current_author = parts[1].strip() or "Unknown"
        elif line and current_sha:
            current_changes[line] += 1
            current_authors[line][current_author] += 1

    # Pick sampled snapshots based on granularity
    if granularity == "snapshot":
        sampled = _sample_commits(commits, n_snapshots)
    else:
        sampled = _bucket_commits(commits, granularity)

    # Re-walk log keeping running counters, and at each sampled index snapshot state
    progress(0, n, "starting timeline")
    current_changes = Counter()
    current_authors = defaultdict(Counter)
    current_author = "Unknown"
    current_sha = None
    sampled_shas = {c["sha"] for c in sampled}
    snapshots_state = {}

    for line in name_only.stdout.splitlines():
        if line.startswith("::"):
            parts = line[2:].split("::", 1)
            if len(parts) == 2:
                # Before moving to new commit, check if previous was a sample point
                if current_sha and current_sha in sampled_shas and current_sha not in snapshots_state:
                    snapshots_state[current_sha] = (
                        Counter(current_changes),
                        {k: Counter(v) for k, v in current_authors.items()},
                    )
                current_sha = parts[0]
                current_author = parts[1].strip() or "Unknown"
        elif line and current_sha:
            current_changes[line] += 1
            current_authors[line][current_author] += 1
    # Final commit
    if current_sha and current_sha in sampled_shas and current_sha not in snapshots_state:
        snapshots_state[current_sha] = (
            Counter(current_changes),
            {k: Counter(v) for k, v in current_authors.items()},
        )

    # For each sampled commit, get file tree + sizes, then compute metrics
    from datetime import datetime, timezone
    snapshots = []
    for idx, c in enumerate(sampled):
        progress(idx + 1, n, f"snapshot {idx + 1}/{n}")
        sha = c["sha"]
        ls_tree = subprocess.run(
            ["git", "ls-tree", "-r", "--long", sha],
            cwd=repo_path, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        files_in_tree = {}  # fname -> size_bytes
        for line in ls_tree.stdout.splitlines():
            # Format: <mode> <type> <sha> <size>\t<name>
            if "\t" not in line:
                continue
            left, fname = line.split("\t", 1)
            parts = left.split()
            if len(parts) < 4:
                continue
            try:
                size = int(parts[3])
            except ValueError:
                continue
            if extensions and not any(fname.endswith(ext) for ext in extensions):
                continue
            if path_prefix:
                pfx = path_prefix.rstrip("/") + "/"
                if not (fname.startswith(pfx) or fname == path_prefix.rstrip("/")):
                    continue
            files_in_tree[fname] = size

        changes_counter, authors_counter = snapshots_state.get(sha, (Counter(), {}))
        metrics: dict[str, dict] = {}
        for fname, size in files_in_tree.items():
            loc_approx = max(1, size // 25)  # rough LOC from byte size
            changes = changes_counter.get(fname, 0)
            primary_author = "Unknown"
            if fname in authors_counter and authors_counter[fname]:
                primary_author = authors_counter[fname].most_common(1)[0][0]
            score = round(changes * math.log(loc_approx + 1), 2)
            metrics[fname] = {
                "loc": loc_approx,
                "changes": changes,
                "primary_author": primary_author,
                "hotspot_score": score,
            }

        nodes = build_tree_nodes(metrics)
        snapshots.append({
            "commit": sha,
            "date": datetime.fromtimestamp(c["ts"], tz=timezone.utc).strftime("%Y-%m-%d"),
            "timestamp": c["ts"],
            "file_count": len(metrics),
            "total_changes": sum(m["changes"] for m in metrics.values()),
            "nodes": nodes,
        })

    return snapshots


def main() -> None:
    parser = argparse.ArgumentParser(description="Hotspot analysis for git repositories")
    parser.add_argument("--repo", required=True, help="Repository URL (HTTPS) or user/repo shorthand")
    parser.add_argument(
        "--file-extensions",
        default=".py,.js,.ts,.java,.c,.cpp,.h,.go,.rs,.rb,.md,.pyx,.cu,.rst",
        help="Comma-separated file extensions to analyze",
    )
    parser.add_argument("--branch", default="", help="Branch to analyze (default: HEAD)")
    parser.add_argument("--branch-label", default="", help="Label for output file (default: same as branch)")
    parser.add_argument("--path-prefix", default="", help="Only analyze files under this path prefix (e.g. 'src/core/')")
    parser.add_argument("--timeline", type=int, default=0, help="Also generate N timeline snapshots (0 = disabled)")
    parser.add_argument(
        "--timeline-granularity", default="snapshot",
        choices=["snapshot", "day", "week", "month"],
        help="Timeline sampling: 'snapshot' = N evenly-spaced (default); otherwise one per time bucket",
    )
    args = parser.parse_args()

    if "/" in args.repo and not args.repo.startswith(("http://", "https://", "git@")):
        args.repo = f"https://github.com/{args.repo}"

    repo_path = get_cached_repo_path(args.repo)
    if not repo_path.exists():
        print(f"Repo not found locally, cloning {args.repo}...")
        subprocess.run(["git", "clone", args.repo, str(repo_path)], check=True)

    repo_name = args.repo.rstrip("/").split("/")[-1].replace(".git", "")
    branch_label = args.branch_label or args.branch
    suffix = f"-{branch_label}" if branch_label else ""

    if args.branch:
        subprocess.run(["git", "checkout", args.branch], cwd=repo_path, capture_output=True)
        subprocess.run(
            ["git", "reset", "--hard", f"origin/{args.branch}"],
            cwd=repo_path, capture_output=True,
        )
        ref = f"origin/{args.branch}"
    else:
        ref = "HEAD"

    extensions_str = args.file_extensions.strip()
    extensions = [e.strip() for e in extensions_str.split(",")] if extensions_str else None

    scope_note = f" (scope: {args.path_prefix})" if args.path_prefix else ""
    print(f"  Collecting file metrics for {repo_name}{suffix}{scope_note}...")
    stage("snapshot", 5)
    metrics = collect_file_metrics(repo_path, extensions, ref, path_prefix=args.path_prefix)
    print(f"  Analyzed {len(metrics)} files")

    nodes = build_tree_nodes(metrics)
    spec = build_vega_spec(nodes, f"{repo_name}{suffix}{scope_note}")

    Path("charts").mkdir(exist_ok=True)
    hotspot_path = Path("charts") / f"{repo_name}{suffix}-hotspot.json"
    hotspot_path.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
    print(f"  Written: {hotspot_path}")

    insights = generate_insights(metrics, f"{repo_name}{suffix}")
    insights_path = Path("charts") / f"{repo_name}{suffix}-insights.json"
    insights_path.write_text(json.dumps(insights, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  Written: {insights_path}")

    tl_granularity = args.timeline_granularity
    run_timeline = (args.timeline and args.timeline > 0) or tl_granularity != "snapshot"
    if run_timeline:
        label = f"{args.timeline} snapshots" if tl_granularity == "snapshot" else f"one per {tl_granularity}"
        print(f"  Generating timeline ({label})...")
        # Weight: unknown total for bucket modes; guess 30 (typical month count)
        guess = args.timeline if tl_granularity == "snapshot" else 30
        stage("timeline", max(1, guess) * 3)
        snapshots = collect_timeline_metrics(
            repo_path, extensions, ref, args.timeline, path_prefix=args.path_prefix,
            granularity=tl_granularity,
        )
        timeline_path = Path("charts") / f"{repo_name}{suffix}-timeline.json"
        timeline_path.write_text(
            json.dumps({"snapshots": snapshots}, ensure_ascii=False),
            encoding="utf-8",
        )
        print(f"  Written: {timeline_path}")


if __name__ == "__main__":
    main()
