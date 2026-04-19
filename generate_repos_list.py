#!/usr/bin/env python3
"""Generate repos.json from available chart files.

Variants recognised per repo:
  clean             -> {repo}-clean.json
  versioned         -> {repo}-versioned.json
  hotspot           -> {repo}-hotspot.json          (main branch)
  hotspot-develop   -> {repo}-develop-hotspot.json  (legacy develop)
  hotspot-<branch>  -> {repo}-<branch>-hotspot.json (any custom branch)
"""

import json
from pathlib import Path

CONFIG_PATH = Path("repos_config.json")


def main():
    charts_dir = Path("charts")
    if not charts_dir.exists():
        print("charts/ directory not found")
        return

    # Canonical repo names come from repos_config.json so we can disambiguate
    # stems like "foo-feat-bar-hotspot" -> repo="foo", branch="feat-bar".
    if CONFIG_PATH.exists():
        cfg = json.loads(CONFIG_PATH.read_text())
        base_names = sorted(cfg.keys(), key=lambda x: -len(x))
    else:
        base_names = []

    repos: dict[str, list[str]] = {}

    def add(repo: str, variant: str) -> None:
        repos.setdefault(repo, [])
        if variant not in repos[repo]:
            repos[repo].append(variant)

    for file in charts_dir.glob("*.json"):
        stem = file.stem
        if stem == "repos":
            continue

        matched_repo = None
        rest = ""
        # Longest-prefix match against known repo names
        for name in base_names:
            if stem == name:
                matched_repo = name
                rest = ""
                break
            if stem.startswith(name + "-"):
                matched_repo = name
                rest = stem[len(name):]  # starts with "-"
                break

        if matched_repo is None:
            # Fallback: treat stem minus trailing known variant as repo name
            for v in ("-clean", "-versioned", "-hotspot"):
                if stem.endswith(v):
                    matched_repo = stem[: -len(v)]
                    rest = v
                    break
            if matched_repo is None:
                continue

        if rest == "-clean":
            add(matched_repo, "clean")
        elif rest == "-versioned":
            add(matched_repo, "versioned")
        elif rest == "-hotspot":
            add(matched_repo, "hotspot")
        elif rest.endswith("-hotspot"):
            branch = rest[1:-len("-hotspot")]
            if branch == "develop":
                add(matched_repo, "hotspot-develop")
            else:
                add(matched_repo, f"hotspot-{branch}")
        elif rest.endswith("-insights") or rest.endswith("-timeline"):
            # Sidecars (don't contribute variants on their own)
            pass

    # Make sure every configured repo appears even if no charts exist yet
    for name in base_names:
        repos.setdefault(name, [])

    repos = dict(sorted(repos.items()))
    output_path = charts_dir / "repos.json"
    output_path.write_text(json.dumps(repos, indent=2))
    print(f"Generated {output_path} with {len(repos)} repositories")
    for repo, variants in repos.items():
        print(f"  - {repo} ({', '.join(variants) or 'empty'})")


if __name__ == "__main__":
    main()
