#!/usr/bin/env python3
"""Generate repos.json from available chart files."""

import json
from pathlib import Path


def main():
    charts_dir = Path("charts")

    if not charts_dir.exists():
        print("charts/ directory not found")
        return

    # Collect unique repo names from any available chart file (clean OR hotspot)
    names = set()
    for pattern in ("*-clean.json", "*-hotspot.json"):
        for file in charts_dir.glob(pattern):
            stem = file.stem
            name = stem.replace("-clean", "").replace("-hotspot", "")
            # Strip develop/dev/development branch suffix
            for branch_suffix in ("-develop", "-development", "-dev"):
                if name.endswith(branch_suffix):
                    name = name[: -len(branch_suffix)]
                    break
            if name and name != "repos":
                names.add(name)

    repos = {}
    for name in names:
        variants = []
        if (charts_dir / f"{name}-clean.json").exists():
            variants.append("clean")
        if (charts_dir / f"{name}-versioned.json").exists():
            variants.append("versioned")
        if (charts_dir / f"{name}-hotspot.json").exists():
            variants.append("hotspot")
        if (charts_dir / f"{name}-develop-hotspot.json").exists():
            variants.append("hotspot-develop")
        repos[name] = variants

    # Sort by name for consistency
    repos = dict(sorted(repos.items()))

    # Write to charts/repos.json
    output_path = charts_dir / "repos.json"
    output_path.write_text(json.dumps(repos, indent=2))

    print(f"Generated {output_path} with {len(repos)} repositories")
    for repo, variants in repos.items():
        print(f"  - {repo} ({', '.join(variants)})")


if __name__ == "__main__":
    main()
