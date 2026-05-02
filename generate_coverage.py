#!/usr/bin/env python3
"""Generate coverage JSON for GitCharts from Cobertura XML reports.

Usage:
  # Cross-reference coverage XML with git blame (recommended)
  python generate_coverage.py --repo numa-backend --cross-ref TestResults/*/coverage.cobertura.xml --granularity Day

  # Append a single coverage report (with explicit date)
  python generate_coverage.py --repo numa-backend --from-file TestResults/coverage.cobertura.xml --date 2026-04-01

  # Batch-import a directory of reports (filenames: YYYY-MM-DDTHH-MM-SS.xml)
  python generate_coverage.py --repo numa-backend --from-dir ./coverage-history/

Output: charts/{repo}-coverage.json
"""

import argparse
import hashlib
import json
import re
import subprocess
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime
from pathlib import Path


TIMESTAMP_PATTERN = re.compile(r"\(.*?\s+(\d{10})\s+[+-]\d{4}\s+(\d+)\)")


def timestamp_to_period(ts: int, granularity: str) -> str:
    """Convert unix timestamp to period string matching git_archaeology.py format."""
    dt = datetime.fromtimestamp(ts)
    if granularity == "Year":
        return str(dt.year)
    elif granularity == "Quarter":
        q = (dt.month - 1) // 3 + 1
        return f"{dt.year}-Q{q}"
    elif granularity == "Month":
        return f"{dt.year}-{dt.month:02d}"
    elif granularity == "Week":
        _, week, _ = dt.isocalendar()
        return f"{dt.year}-W{week:02d}"
    else:  # Day
        return f"{dt.year}-{dt.month:02d}-{dt.day:02d}"


def parse_cobertura_per_line(path: str) -> tuple[float, dict[str, dict[int, bool]]]:
    """Parse Cobertura XML for global rate and per-file, per-line coverage.

    Returns (global_rate, {filename: {line_number: is_covered}})
    """
    tree = ET.parse(path)
    root = tree.getroot()
    global_rate = float(root.attrib.get("line-rate", 0))

    file_coverage: dict[str, dict[int, bool]] = {}
    for cls in root.findall(".//class"):
        filename = cls.attrib.get("filename", "")
        if not filename:
            continue
        lines = {}
        for line in cls.findall(".//line"):
            line_num = int(line.attrib["number"])
            hits = int(line.attrib.get("hits", 0))
            lines[line_num] = hits > 0
        if lines:
            file_coverage[filename] = lines

    return global_rate, file_coverage


def get_repo_path(repo_name: str) -> Path | None:
    """Find the cached repo path in .downloads/."""
    downloads = Path(".downloads")
    if not downloads.exists():
        return None
    for d in downloads.iterdir():
        if d.is_dir() and d.name.startswith(repo_name + "-"):
            return d
    return None


def run_blame(repo_path: Path, file_path: str) -> dict[int, int]:
    """Run git blame on a file, return {line_number: unix_timestamp}."""
    result = subprocess.run(
        ["git", "blame", "-t", "HEAD", "--", file_path],
        cwd=repo_path,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if result.returncode != 0:
        return {}

    line_timestamps = {}
    for line in result.stdout.split("\n"):
        if not line:
            continue
        m = TIMESTAMP_PATTERN.search(line)
        if m:
            ts = int(m.group(1))
            line_num = int(m.group(2))
            line_timestamps[line_num] = ts
    return line_timestamps


def cross_reference(repo: str, coverage_file: str, granularity: str):
    """Cross-reference Cobertura XML with git blame to compute per-period coverage rates."""
    repo_path = get_repo_path(repo)
    if not repo_path:
        print(f"Error: repo '{repo}' not found in .downloads/")
        return

    print(f"Parsing coverage: {coverage_file}")
    global_rate, file_coverage = parse_cobertura_per_line(coverage_file)
    print(f"  Global rate: {global_rate*100:.2f}%")
    print(f"  Files with coverage: {len(file_coverage)}")

    # Map absolute paths to repo-relative paths
    repo_abs = str(repo_path.resolve())
    relative_coverage: dict[str, dict[int, bool]] = {}
    for abs_path, lines in file_coverage.items():
        if abs_path.startswith(repo_abs):
            rel = abs_path[len(repo_abs):].lstrip("/")
        else:
            rel = abs_path
        relative_coverage[rel] = lines

    # Run git blame on each file and cross-reference
    period_stats: dict[str, dict[str, int]] = defaultdict(lambda: {"covered": 0, "total": 0})
    total_matched = 0

    for rel_path, cov_lines in relative_coverage.items():
        blame_timestamps = run_blame(repo_path, rel_path)
        if not blame_timestamps:
            continue

        for line_num, is_covered in cov_lines.items():
            ts = blame_timestamps.get(line_num)
            if ts is None:
                continue
            period = timestamp_to_period(ts, granularity)
            period_stats[period]["total"] += 1
            if is_covered:
                period_stats[period]["covered"] += 1
            total_matched += 1

    # Compute rates per period
    rates = {}
    for period, stats in sorted(period_stats.items()):
        rate = stats["covered"] / stats["total"] if stats["total"] > 0 else 0
        rates[period] = round(rate, 4)
        print(f"  {period}: {rate*100:.1f}% ({stats['covered']}/{stats['total']})")

    output = {
        "global_rate": round(global_rate, 4),
        "rates": rates,
    }

    output_path = Path("charts") / f"{repo}-coverage.json"
    output_path.write_text(json.dumps(output, indent=2) + "\n")
    print(f"\nSaved to {output_path} ({total_matched} lines matched, {len(rates)} periods)")


# === Legacy functions for simple time-series mode ===

def parse_cobertura_xml(path: str) -> float:
    """Extract overall line coverage % from a Cobertura XML file."""
    tree = ET.parse(path)
    root = tree.getroot()
    return round(float(root.attrib.get("line-rate", 0)) * 100, 2)


def load_existing(output_path: Path) -> list[dict]:
    if output_path.exists():
        data = json.loads(output_path.read_text())
        if isinstance(data, list):
            return data
    return []


def save_coverage(output_path: Path, data: list[dict]):
    seen = set()
    unique = []
    for entry in sorted(data, key=lambda d: d["commit_date"]):
        if entry["commit_date"] not in seen:
            seen.add(entry["commit_date"])
            unique.append(entry)
    output_path.write_text(json.dumps(unique, indent=2) + "\n")
    print(f"Saved {len(unique)} entries to {output_path}")


def from_file(repo: str, file_path: str, date_str: str | None):
    coverage_pct = parse_cobertura_xml(file_path)
    commit_date = date_str or datetime.now().isoformat(timespec="seconds")
    output_path = Path("charts") / f"{repo}-coverage.json"
    data = load_existing(output_path)
    data.append({"commit_date": commit_date, "coverage_pct": coverage_pct})
    save_coverage(output_path, data)
    print(f"  {commit_date}: {coverage_pct}%")


def from_dir(repo: str, dir_path: str):
    xml_files = sorted(Path(dir_path).glob("*.xml"))
    if not xml_files:
        print(f"No XML files found in {dir_path}")
        return
    output_path = Path("charts") / f"{repo}-coverage.json"
    data = load_existing(output_path)
    for xml_file in xml_files:
        coverage_pct = parse_cobertura_xml(str(xml_file))
        stem = xml_file.stem.replace("-", ":", 2)
        try:
            dt = datetime.fromisoformat(stem)
            commit_date = dt.isoformat(timespec="seconds")
        except ValueError:
            mtime = xml_file.stat().st_mtime
            commit_date = datetime.fromtimestamp(mtime).isoformat(timespec="seconds")
        data.append({"commit_date": commit_date, "coverage_pct": coverage_pct})
        print(f"  {commit_date}: {coverage_pct}% ({xml_file.name})")
    save_coverage(output_path, data)


def main():
    parser = argparse.ArgumentParser(description="Generate coverage JSON for GitCharts")
    parser.add_argument("--repo", required=True, help="Repository name (e.g. numa-backend)")

    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--cross-ref", help="Cobertura XML to cross-reference with git blame")
    group.add_argument("--from-file", help="Path to a single Cobertura XML file")
    group.add_argument("--from-dir", help="Directory containing Cobertura XML files")

    parser.add_argument("--granularity", default="Day",
                        choices=["Year", "Quarter", "Month", "Week", "Day"],
                        help="Period granularity (must match chart granularity)")
    parser.add_argument("--date", help="ISO date for --from-file (default: now)")

    args = parser.parse_args()
    Path("charts").mkdir(exist_ok=True)

    if args.cross_ref:
        cross_reference(args.repo, args.cross_ref, args.granularity)
    elif args.from_file:
        from_file(args.repo, args.from_file, args.date)
    elif args.from_dir:
        from_dir(args.repo, args.from_dir)


if __name__ == "__main__":
    main()
