#!/usr/bin/env bash
set -euo pipefail

integration_dir="$(cd "$(dirname "$0")" && pwd)"
upstream_commit=838965c5a18d2c61b73ec30c6e288057aaa08b63
output="$(realpath -m "${1:?Usage: bash build.sh NEW_OUTPUT_DIRECTORY}")"
if [[ -e "$output" ]]; then
  printf 'Choose a new output directory.\n' >&2
  exit 1
fi

source_dir="$(mktemp -d)"
trap 'rm -rf -- "$source_dir"' EXIT
git -C "$source_dir" init -q
git -C "$source_dir" fetch --quiet --depth 1 https://github.com/yangzongzhuan/RuoYi-Vue3.git "$upstream_commit"
git -C "$source_dir" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$source_dir" rev-parse HEAD)" = "$upstream_commit"
cp "$integration_dir/leet-index.html" "$source_dir/index.html"
cp "$integration_dir/leet-main.js" "$source_dir/src/leet-main.js"
cp -R "$integration_dir/src/views/leet" "$source_dir/src/views/"
cd "$source_dir"
npm install --ignore-scripts --no-audit --no-fund --save-exact jsqr@1.4.0
npm run build:prod -- --base /admin/
# The custom entry does not use the upstream project favicon.
rm -f dist/favicon.ico
cp LICENSE dist/RuoYi-LICENSE.txt
cp node_modules/jsqr/LICENSE dist/jsQR-LICENSE.txt
mkdir -- "$output"
cp -R dist/. "$output/"

node "$integration_dir/../../scripts/verify-ruoyi-bundle.mjs" seal "$output"
