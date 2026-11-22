#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/dist/server" "$ROOT/dist/.openai"
APP_JSON="$(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1], "utf8")))' "$ROOT/public/index.html")"
node -e 'const fs=require("fs");const input=fs.readFileSync(process.argv[1],"utf8");fs.writeFileSync(process.argv[2],input.replace("__APP_HTML__",process.argv[3]))' "$ROOT/worker/index.template.js" "$ROOT/dist/server/index.js" "$APP_JSON"
cp "$ROOT/.openai/hosting.json" "$ROOT/dist/.openai/hosting.json"
