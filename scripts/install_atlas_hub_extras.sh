#!/bin/sh
# Freeze the Git-backed weather MCP once in the Hub image, without changing Atlas direct mode.
set -eu
revision=3474c7841d00f5f40c087c5d2188a5c0f41bd134
build_dir=$(mktemp -d)
git init "$build_dir"
git -C "$build_dir" remote add origin https://github.com/geobio/smitheryai-mcp-servers-weather.git
git -C "$build_dir" fetch --depth 1 origin "$revision"
git -C "$build_dir" checkout --detach FETCH_HEAD
# Upstream omitted build-only dependencies from its lockfile; pin them while
# reconciling the lock, preserving its locked runtime dependencies.
(cd "$build_dir" && npm install --ignore-scripts --save-dev --save-exact typescript@5.8.3 @types/node@20.17.30 && npm run build && npm prune --omit=dev --ignore-scripts && rm -rf .git src)
printf '%s\n' "$revision" > "$build_dir/.atlas-revision"
mkdir -p /agent-environment/node_modules/@smithery
mv "$build_dir" /agent-environment/node_modules/@smithery/weather
test -f /agent-environment/node_modules/@smithery/weather/dist/index.js
