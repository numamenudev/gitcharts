#!/bin/sh
# Configure git to use GITHUB_TOKEN for private repos
if [ -n "$GITHUB_TOKEN" ]; then
  git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
fi

# Pull latest application code from main on startup.
# Volumes (charts/, .downloads/, git-research/) and the repos_config.json
# bind mount are NOT touched — only source code files are refreshed.
REPO_URL="${GITCHARTS_REPO_URL:-https://github.com/numamenudev/gitcharts.git}"
BRANCH="${GITCHARTS_BRANCH:-main}"
UPDATE_DIR=/tmp/gitcharts-update

echo "==> Updating gitcharts from ${REPO_URL} (${BRANCH})"
rm -rf "$UPDATE_DIR"
if git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$UPDATE_DIR"; then
  # Copy all top-level Python files + static entry points
  for f in "$UPDATE_DIR"/*.py; do
    [ -f "$f" ] && cp "$f" "/app/$(basename "$f")"
  done
  for f in index.html Dockerfile entrypoint.sh Makefile; do
    [ -f "$UPDATE_DIR/$f" ] && cp "$UPDATE_DIR/$f" "/app/$f"
  done
  chmod +x /app/entrypoint.sh 2>/dev/null || true
  # Replace frontend asset dirs
  for d in js css; do
    if [ -d "$UPDATE_DIR/$d" ]; then
      rm -rf "/app/$d"
      cp -r "$UPDATE_DIR/$d" "/app/$d"
    fi
  done
  rm -rf "$UPDATE_DIR"
  echo "==> Update complete"
else
  echo "==> WARNING: update failed, continuing with baked-in version" >&2
  rm -rf "$UPDATE_DIR"
fi

exec "$@"
