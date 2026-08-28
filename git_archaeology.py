# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "marimo",
#     "polars==1.35.2",
#     "altair==6.0.0",
#     "pydantic>=2.0.0",
#     "diskcache==5.6.3",
#     "tenacity>=8.0.0",
#     "httpx>=0.27.0",
# ]
# ///

import marimo

__generated_with = "0.20.4"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo

    return (mo,)


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # Git Code Archaeology

    This notebook analyzes a git repository to visualize how code ages over time.
    It creates a stacked area chart showing lines of code broken down by the year
    each line was originally added, revealing how quickly code gets replaced.
    """)
    return


@app.cell
def _():
    import subprocess
    from datetime import datetime
    import polars as pl
    import altair as alt
    alt.data_transformers.disable_max_rows()
    from diskcache import Cache

    cache = Cache("git-research", timeout=300)
    return alt, cache, datetime, pl, subprocess


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Configuration
    """)
    return


@app.cell
def _(mo):
    params_form = (
        mo.md("""
    {repo_url}

    {file_extensions}

    {sample_count}
    """)
        .batch(
            repo_url=mo.ui.text(
                value="https://github.com/marimo-team/marimo",
                label="Repository URL (HTTPS)",
                full_width=True,
            ),
            file_extensions=mo.ui.text(
                value=".py,.js,.ts,.java,.c,.cpp,.h,.go,.rs,.rb,.md,.pyx,.cu,.rst",
                label="File extensions to analyze (comma-separated, leave empty for all)",
                full_width=True,
            ),
            sample_count=mo.ui.slider(
                start=10,
                stop=200,
                value=200,
                step=5,
                label="Number of commits to sample",
            ),
        )
        .form()
    )

    params_form
    return (params_form,)


@app.cell
def _(mo):
    granularity_select = mo.ui.dropdown(
        options=["Year", "Quarter", "Month", "Week", "Day"],
        value="Quarter",
        label="Time granularity",
    )
    return (granularity_select,)


@app.cell
def _(granularity_select, mo):
    version_source = mo.ui.dropdown(
        options=["none", "git tags", "pypi"],
        value="git tags",
        label="Version source",
    )
    show_versions = mo.ui.checkbox(label="show versions")
    invert_layers = mo.ui.checkbox(label="invert layers")
    mo.hstack([version_source, granularity_select, show_versions, invert_layers])
    return invert_layers, show_versions, version_source


@app.cell
def _():
    from pydantic import BaseModel, Field


    class RepoParams(BaseModel):
        repo: str = Field(description="Repository URL (HTTPS)")
        samples: int = Field(default=200, description="Number of commits to sample")
        file_extensions: str = Field(
            default=".py,.js,.ts,.java,.c,.cpp,.h,.go,.rs,.rb,.md,.pyx,.cu,.rst",
            description="Comma-separated file extensions to analyze",
        )
        exclude: str = Field(
            default="",
            description="Comma-separated globs of files to skip (e.g. '*.g.dart,*/Migrations/*'). "
            "Matched against the full repo-relative path; '*' crosses directory separators.",
        )
        version_source: str = Field(
            default="git tags", description="Version source: none, git tags, or pypi"
        )
        pypi_name: str = Field(
            default="", description="PyPI package name (defaults to repo name)"
        )
        granularity: str = Field(
            default="Quarter", description="Time granularity: Year, Quarter, Month, Week, or Day"
        )
        branch: str = Field(
            default="", description="Branch to analyze (default: repo default branch)"
        )
        branch_label: str = Field(
            default="", description="Label for output file (default: same as branch)"
        )
        batch: int = Field(
            default=0,
            description="Max uncached commits to analyze per run (0 = all). "
            "Enables incremental chunking: the process exits after each batch so "
            "the OS reclaims memory; re-invoke until REMAINING=0.",
        )

    return (RepoParams,)


@app.cell
def _(RepoParams, mo):
    cli_args = mo.cli_args()

    if mo.app_meta().mode == "script":
        if "help" in cli_args or len(cli_args) == 0:
            print("Usage: uv run git_archaeology.py --repo <url> [--samples <n>]")
            print()
            for name, field in RepoParams.model_fields.items():
                default = " (required)" if field.is_required() else f" (default: {field.default})"
                print(f"  --{name:12s} {field.description}{default}")
            exit()
        repo_params = RepoParams(**{k.replace("-", "_"): v for k, v in cli_args.items()})
    return (repo_params,)


@app.cell(hide_code=True)
def _(subprocess):
    from pathlib import Path
    import hashlib

    DOWNLOADS_DIR = Path(".downloads")


    def get_cached_repo_path(repo_url: str) -> Path:
        """Get the cached path for a repo URL, using a hash for uniqueness."""
        repo_name = repo_url.rstrip("/").split("/")[-1].replace(".git", "")
        url_hash = hashlib.md5(repo_url.encode(), usedforsecurity=False).hexdigest()[:8]
        return DOWNLOADS_DIR / f"{repo_name}-{url_hash}"


    def clone_or_update_repo(repo_url: str) -> Path:
        """Clone repo if not cached, otherwise return cached path."""
        DOWNLOADS_DIR.mkdir(exist_ok=True)
        repo_path = get_cached_repo_path(repo_url)

        if repo_path.exists():
            # Repo already cached, fetch latest and update working tree
            subprocess.run(
                ["git", "fetch", "--all"],
                cwd=repo_path,
                capture_output=True,
            )
            subprocess.run(
                ["git", "reset", "--hard", "origin/HEAD"],
                cwd=repo_path,
                capture_output=True,
            )
        else:
            # Clone fresh
            subprocess.run(
                ["git", "clone", repo_url, str(repo_path)],
                capture_output=True,
                check=True,
            )
        return repo_path

    return Path, clone_or_update_repo, hashlib


@app.cell(hide_code=True)
def _(Path, cache, datetime, hashlib, pl, subprocess):
    from concurrent.futures import ThreadPoolExecutor, as_completed
    import fnmatch
    import re

    # Pre-compile regex for timestamp extraction (used in get_blame_info)
    TIMESTAMP_PATTERN = re.compile(r"\(.*?\s+(\d{10})\s+[+-]\d{4}\s+\d+\)")

    # Single shared pool for file-level blame — avoids spinning up/down per commit
    _file_executor = ThreadPoolExecutor(max_workers=32)


    def run_git_command(cmd: list[str], repo_path: str) -> str:
        """Run a git command and return stdout."""
        result = subprocess.run(
            cmd,
            cwd=repo_path,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        if result.returncode != 0:
            raise RuntimeError(f"Git command failed: {result.stderr}")
        return result.stdout


    def get_commit_list(repo_path: str, ref: str = "HEAD") -> list[tuple[str, datetime]]:
        """Get list of all commits with their dates.

        Not memoized: the cache key (repo_path, ref) is stable, so once a
        regen populates the cache, later regens never see new commits even
        after `git fetch` advances the ref. Calling git log is sub-second.
        """
        output = run_git_command(
            ["git", "log", "--format=%H %at", "--reverse", ref],
            repo_path,
        )
        commits = []
        for line in output.strip().split("\n"):
            if line:
                parts = line.split()
                commit_hash = parts[0]
                timestamp = int(parts[1])
                commit_date = datetime.fromtimestamp(timestamp)
                commits.append((commit_hash, commit_date))
        return commits


    @cache.memoize()
    def get_tracked_files(
        repo_path: str,
        commit_hash: str,
        extensions: list[str] | None = None,
        exclude: tuple[str, ...] | None = None,
    ) -> list[tuple[str, str]]:
        """Get list of (file_path, blob_hash) pairs at a specific commit."""
        output = run_git_command(
            ["git", "ls-tree", "-r", commit_hash],
            repo_path,
        )
        results = []
        for line in output.strip().split("\n"):
            if not line:
                continue
            # Format: <mode> <type> <blob_hash>\t<path>
            meta, file_path = line.split("\t", 1)
            blob_hash = meta.split()[2]
            if extensions and not any(file_path.endswith(ext) for ext in extensions):
                continue
            # Generated files (l10n, migrations, lockfiles) would date every line
            # to the moment the generator ran, not to human work.
            if exclude and any(fnmatch.fnmatch(file_path, pat) for pat in exclude):
                continue
            results.append((file_path, blob_hash))
        return results


    def get_blame_info(repo_path: str, commit_hash: str, file_path: str) -> list[int]:
        """Get blame timestamps for a file. Uses -t for raw timestamp output."""
        try:
            output = run_git_command(
                ["git", "blame", "-t", commit_hash, "--", file_path],
                repo_path,
            )
        except (RuntimeError, UnicodeDecodeError):
            return []

        return [
            int(m.group(1))
            for line in output.split("\n")
            if line and (m := TIMESTAMP_PATTERN.search(line))
        ]


    def get_blame_by_blob(
        blob_hash: str, repo_path: str, commit_hash: str, file_path: str
    ) -> list[int]:
        """Cache blame results by blob hash — identical blob = identical blame."""
        cache_key = ("blame_v1", blob_hash)
        cached = cache.get(cache_key)
        if cached is not None:
            return cached
        result = get_blame_info(repo_path, commit_hash, file_path)
        cache.set(cache_key, result)
        return result


    @cache.memoize()
    def sample_commits(
        commits: list[tuple[str, datetime]], n_samples: int
    ) -> list[tuple[str, datetime]]:
        """Sample n commits evenly distributed across history."""
        if len(commits) <= n_samples:
            return commits
        step = len(commits) / n_samples
        indices = [int(i * step) for i in range(n_samples)]
        # Always include the last commit
        if indices[-1] != len(commits) - 1:
            indices[-1] = len(commits) - 1
        return [commits[i] for i in indices]


    def analyze_single_commit(
        repo_path: str,
        commit_hash: str,
        commit_timestamp: int,
        extensions: list[str] | None,
        exclude: tuple[str, ...] | None = None,
    ) -> list[tuple[int, int, int]]:
        """Analyze a commit, returning day-aggregated line counts.

        Aggregates per-line blame timestamps into (commit_timestamp, epoch_day,
        count) rows INSIDE the worker, so peak memory per commit is O(distinct
        days) not O(lines). Without this, many concurrent commits each hold the
        full per-line list and blow up RAM (OOM on large repos).
        """
        from collections import Counter

        files = get_tracked_files(repo_path, commit_hash, extensions, exclude)

        # Blame files SEQUENTIALLY and fold each into the day-counter immediately.
        # The outer commit-level pool already gives 16-way parallelism; a nested
        # file executor let 32 workers race ahead and pile up completed per-file
        # blame lists faster than they were consumed → O(repo lines) per commit
        # × concurrent commits → OOM. Sequential keeps peak at one file's blame.
        day_counts: Counter = Counter()
        for file_path, blob_hash in files:
            for ts in get_blame_by_blob(blob_hash, repo_path, commit_hash, file_path):
                day_counts[ts // 86400] += 1  # bucket by epoch-day
        return [(commit_timestamp, day, count) for day, count in day_counts.items()]


    def _parquet_dir_for_repo(repo_path, extensions, exclude=None):
        """Deterministic per-repo directory for parquet chunks.

        Keyed only by (repo_path, extensions, exclude) — NOT the sampled commit
        set — so per-commit parquets (named by immutable commit_hash) are reused
        across runs. Extensions and excludes stay in the key because they
        determine which files are blamed, hence the line set.
        """
        key = repr((str(repo_path), extensions, exclude))
        run_hash = hashlib.sha256(key.encode()).hexdigest()[:12]
        out = Path("git-research") / "parquet-chunks" / run_hash
        out.mkdir(parents=True, exist_ok=True)
        return out

    def collect_blame_data(
        repo_path: str,
        sampled_commits: list[tuple[str, datetime]],
        extensions: list[str] | None,
        progress_bar=None,
        is_script: bool = False,
        max_workers: int = 16,
        batch: int = 0,
        exclude: tuple[str, ...] | None = None,
    ) -> Path:
        """Collect blame data, spilling each commit to a per-day-aggregated parquet.

        Incremental: commits whose parquet already exists are skipped before
        submission — never recomputed, never materialized in RAM. Each parquet
        stores day-level counts (commit_date, line_day, line_count) instead of
        one row per line, bounding disk and downstream aggregation memory.

        Chunking: if `batch` > 0, only the first `batch` uncached commits are
        analyzed this run, then the process exits (freeing all heap the C
        allocator never returns to the OS). Prints `REMAINING=<n>` so the caller
        can re-invoke until 0. Commits are processed oldest-first (git log
        --reverse order), so the chart fills in chronologically.
        """
        parquet_dir = _parquet_dir_for_repo(repo_path, extensions, exclude)
        # Empty-but-typed schema, reused for negatives (commits with 0 lines).
        empty_schema = {
            "commit_date": pl.Int64,
            "line_day": pl.Date,
            "line_count": pl.UInt32,
        }
        # Skip commits already cached — the core of "compute each commit once".
        pending = [(h, d) for h, d in sampled_commits
                   if not (parquet_dir / f"{h}.parquet").exists()]
        remaining = 0
        if batch and len(pending) > batch:
            remaining = len(pending) - batch
            pending = pending[:batch]
        if is_script:
            print(f"REMAINING={remaining}")
        total = len(pending)
        done = 0

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(
                    analyze_single_commit, str(repo_path), h, int(d.timestamp()), extensions, exclude
                ): (h, d)
                for h, d in pending
            }
            for future in as_completed(futures):
                commit_hash, _ = futures[future]
                done += 1
                if progress_bar:
                    progress_bar.update(title=f"Analyzed {commit_hash[:8]}...")
                if is_script:
                    print(f"  [{done}/{total}] Analyzed {commit_hash[:8]}")
                out_path = parquet_dir / f"{commit_hash}.parquet"
                rows = future.result()  # already (commit_ts, epoch_day, count)
                if rows:
                    commit_ts, days, counts = zip(*rows)
                    pl.DataFrame({
                        "commit_date": list(commit_ts),
                        # pl.Date is days-since-epoch, exactly ts // 86400.
                        "line_day": pl.Series(list(days), dtype=pl.Int32).cast(pl.Date),
                        "line_count": pl.Series(list(counts), dtype=pl.UInt32),
                    }).write_parquet(out_path)
                else:
                    # Cache the negative so it isn't re-analyzed every run.
                    pl.DataFrame(schema=empty_schema).write_parquet(out_path)

        return parquet_dir

    return collect_blame_data, get_commit_list, re, sample_commits


@app.cell
def _(
    clone_or_update_repo,
    get_commit_list,
    mo,
    params_form,
    repo_params,
    sample_commits,
):
    mo.stop(
        mo.app_meta().mode != "script" and params_form.value is None,
        mo.md("Fill in the form above and click **Submit** to start."),
    )

    # Clone or use cached repo
    repo_url = (
        repo_params.repo
        if mo.app_meta().mode == "script"
        else params_form.value["repo_url"].strip()
    )
    # Accept short GitHub references like "koaning/scikit-lego"
    if "/" in repo_url and not repo_url.startswith(("http://", "https://", "git@")):
        repo_url = f"https://github.com/{repo_url}"
    with mo.status.spinner(f"Cloning/updating repository..."):
        repo_path = clone_or_update_repo(repo_url)

    # Checkout specific branch if requested
    _branch = repo_params.branch if mo.app_meta().mode == "script" else ""
    if _branch:
        subprocess.run(
            ["git", "checkout", _branch],
            cwd=repo_path,
            capture_output=True,
        )
        subprocess.run(
            ["git", "reset", "--hard", f"origin/{_branch}"],
            cwd=repo_path,
            capture_output=True,
        )

    # Parse configuration
    n_samples = (
        repo_params.samples if mo.app_meta().mode == "script" else params_form.value["sample_count"]
    )
    extensions_str = (
        repo_params.file_extensions
        if mo.app_meta().mode == "script"
        else params_form.value["file_extensions"]
    )
    extensions_str = extensions_str.strip()
    extensions = [ext.strip() for ext in extensions_str.split(",")] if extensions_str else None

    _exclude_str = repo_params.exclude.strip() if mo.app_meta().mode == "script" else ""
    exclude = (
        tuple(p.strip() for p in _exclude_str.split(",") if p.strip()) if _exclude_str else None
    )

    # Get commits — pass branch ref so the cache key differs per branch
    _ref = f"origin/{_branch}" if _branch else "HEAD"
    with mo.status.spinner("Getting commit history..."):
        all_commits = get_commit_list(str(repo_path), _ref)
        sampled = sample_commits(all_commits, n_samples)

    mo.md(f"Found **{len(all_commits)}** commits, sampling **{len(sampled)}** for analysis")
    return exclude, extensions, repo_path, sampled


@app.cell
def _(collect_blame_data, exclude, extensions, mo, pl, repo_params, repo_path, sampled):
    _batch = repo_params.batch if mo.app_meta().mode == "script" else 0
    with mo.status.progress_bar(
        total=len(sampled),
        title="Analyzing commits",
        show_rate=True,
        show_eta=True,
    ) as bar:
        parquet_dir = collect_blame_data(
            repo_path,
            sampled,
            extensions,
            progress_bar=bar,
            is_script=mo.app_meta().mode == "script",
            batch=_batch,
            exclude=exclude,
        )

    # Read ONLY the parquets for the currently-sampled commits. The dir is now
    # per-repo (shared across runs/branches), so globbing would pull the entire
    # history ever cached and reintroduce the OOM.
    parquet_files = [parquet_dir / f"{h}.parquet" for h, _ in sampled
                     if (parquet_dir / f"{h}.parquet").exists()]
    if parquet_files:
        raw_df = pl.read_parquet(parquet_files).with_columns(
            pl.from_epoch("commit_date", time_unit="s").alias("commit_date")
        )
    else:
        raw_df = pl.DataFrame({
            "commit_date": pl.Series([], dtype=pl.Datetime),
            "line_day": pl.Series([], dtype=pl.Date),
            "line_count": pl.Series([], dtype=pl.UInt32),
        })
    return (raw_df,)


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Visualization
    """)
    return


@app.cell
def _(granularity_select, mo, pl, raw_df, repo_params):
    granularity = repo_params.granularity if mo.app_meta().mode == "script" else granularity_select.value

    # Vectorized period derivation using native Polars dt ops.
    # line_day is a pre-aggregated pl.Date (day granularity is the finest view),
    # so dt ops roll it up to any coarser period.
    ts_col = pl.col("line_day")

    if granularity == "Year":
        period_expr = ts_col.dt.year().cast(pl.Utf8).alias("period")
    elif granularity == "Quarter":
        period_expr = pl.concat_str(
            ts_col.dt.year().cast(pl.Utf8),
            pl.lit("-Q"),
            ((ts_col.dt.month() - 1) // 3 + 1).cast(pl.Utf8),
        ).alias("period")
    elif granularity == "Month":
        period_expr = pl.concat_str(
            ts_col.dt.year().cast(pl.Utf8),
            pl.lit("-"),
            ts_col.dt.month().cast(pl.Utf8).str.zfill(2),
        ).alias("period")
    elif granularity == "Week":
        period_expr = pl.concat_str(
            ts_col.dt.year().cast(pl.Utf8),
            pl.lit("-W"),
            ts_col.dt.week().cast(pl.Utf8).str.zfill(2),
        ).alias("period")
    else:  # Day
        period_expr = pl.concat_str(
            ts_col.dt.year().cast(pl.Utf8),
            pl.lit("-"),
            ts_col.dt.month().cast(pl.Utf8).str.zfill(2),
            pl.lit("-"),
            ts_col.dt.day().cast(pl.Utf8).str.zfill(2),
        ).alias("period")

    df = (
        raw_df.with_columns(period_expr)
        .group_by(["commit_date", "period"])
        .agg(pl.col("line_count").sum())
        .sort(["commit_date", "period"])
    )
    return (df,)


@app.cell
def _(
    datetime,
    mo,
    params_form,
    re,
    repo_params,
    repo_path,
    subprocess,
    version_source,
):

    repo = repo_params.repo if mo.app_meta().mode == "script" else params_form.value["repo_url"]
    parts = repo.rstrip("/").split("/")
    repo_name = parts[-1].replace(".git", "")

    source = repo_params.version_source if mo.app_meta().mode == "script" else version_source.value
    version_rows = []

    _tag_ref = f"origin/{repo_params.branch}" if (mo.app_meta().mode == "script" and repo_params.branch) else "HEAD"
    if source == "git tags":
        result = subprocess.run(
            [
                "git",
                "tag",
                "--merged", _tag_ref,
                "--sort=creatordate",
                "--format=%(refname:short)|%(creatordate:unix)",
            ],
            cwd=repo_path,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        VERSION_RE = re.compile(r"^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.\d+.*$")
        for line in result.stdout.strip().split("\n"):
            if line and VERSION_RE.match(line.split("|")[0]):
                tag, ts = line.split("|", 1)
                if ts.strip():
                    version_rows.append(
                        {"version": tag, "datetime": datetime.fromtimestamp(int(ts))}
                    )

    elif source == "pypi":
        import httpx
        from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

        @retry(
            stop=stop_after_attempt(3),
            wait=wait_exponential(multiplier=1, min=1, max=10),
            retry=retry_if_exception_type((httpx.ConnectError, httpx.TimeoutException)),
        )
        def fetch_pypi(name):
            return httpx.get(f"https://pypi.org/pypi/{name}/json")

        pypi_name = (repo_params.pypi_name if mo.app_meta().mode == "script" else "") or repo_name
        try:
            resp = fetch_pypi(pypi_name)
            if resp.status_code == 200:
                for key, value in resp.json().get("releases", {}).items():
                    if key.endswith(".0") and key != "0.0.0" and len(value) > 0:
                        version_rows.append(
                            {
                                "version": key,
                                "datetime": datetime.fromisoformat(value[0]["upload_time"]),
                            }
                        )
        except Exception:
            pass
    return repo_name, version_rows


@app.cell
def _(alt, pl, version_rows):
    date_lines = None
    date_text = None
    if version_rows:
        df_versions = pl.DataFrame(
            version_rows, schema={"version": pl.Utf8, "datetime": pl.Datetime}
        )
        base_chart = alt.Chart(df_versions)

        date_lines = base_chart.mark_rule(strokeDash=[5, 5]).encode(
            x=alt.X("datetime:T", title="Date"), tooltip=["version:N", "datetime:T"]
        )

        date_text = base_chart.mark_text(angle=270, align="left", dx=15, dy=0).encode(
            x="datetime:T", y=alt.value(10), text="version:N"
        )
    return date_lines, date_text


@app.cell
def _(
    alt,
    date_lines,
    date_text,
    df,
    granularity_select,
    invert_layers,
    mo,
    repo_params,
    show_versions,
):
    granularity_labels = {
        "Year": "Year Added",
        "Quarter": "Quarter Added",
        "Month": "Month Added",
        "Week": "Week Added",
        "Day": "Day Added",
    }
    _gran = repo_params.granularity if mo.app_meta().mode == "script" else granularity_select.value
    color_title = granularity_labels.get(_gran, "Period Added")
    sort_order = "descending" if invert_layers.value else "ascending"

    chart = (
        alt.Chart(df)
        .mark_area()
        .encode(
            x=alt.X("commit_date:T", title="Date"),
            y=alt.Y("line_count:Q", title="Lines of Code"),
            color=alt.Color(
                "period:O",
                scale=alt.Scale(scheme="viridis"),
                title=color_title,
            ),
            order=alt.Order("period:O", sort=sort_order),
            tooltip=["commit_date:T", "period:O", "line_count:Q"],
        )
    )

    out = chart
    if show_versions.value and date_lines is not None:
        out += date_lines + date_text

    out = out.properties(
        title="Code Archaeology: Lines of Code by Period Added",
        width=800,
        height=500,
    )

    out
    return chart, out


@app.cell
def _(Path, alt, chart, date_lines, date_text, mo, out, repo_name, repo_params):
    Path("charts").mkdir(exist_ok=True)

    _branch_label = (repo_params.branch_label or repo_params.branch) if mo.app_meta().mode == "script" else ""
    suffix = f"-{_branch_label}" if _branch_label else ""

    clean_path = Path("charts") / (repo_name + suffix + "-clean.json")
    clean_path.write_text(out.to_json())

    versioned_path = Path("charts") / (repo_name + suffix + "-versioned.json")
    if date_lines is not None:
        versioned_chart = (
            (chart + date_lines + date_text)
            .properties(
                title="Code Archaeology: Lines of Code by Period Added",
                width=800,
                height=500,
            )
            .to_dict()
        )
        versioned_path.write_text(alt.Chart.from_dict(versioned_chart).to_json())
    return


if __name__ == "__main__":
    app.run()
