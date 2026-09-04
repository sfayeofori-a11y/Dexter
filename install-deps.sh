#!/usr/bin/env bash
# Installs npm dependencies for every Dexter sub-server that declares them.
# Root (index.html/project.html/server.js) and /server have no npm
# dependencies — Node built-ins only — so they're skipped.
set -e

for dir in claude-mcp-server mcp-server ops-mcp-server; do
  if [ -f "$dir/package.json" ]; then
    echo "Installing dependencies in $dir..."
    (cd "$dir" && npm install)
  fi
done

echo "Done."
