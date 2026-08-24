#!/bin/zsh

set -euo pipefail

script_dir=${0:A:h}
project_dir=${script_dir:h}
secrets_file=$(mktemp /tmp/canvas-lms-mcp-secrets.XXXXXX)
chmod 600 "$secrets_file"

cleanup() {
  rm -f "$secrets_file"
  unset pasadena_token canyons_token mcp_access_token
}
trap cleanup EXIT HUP INT TERM

read -r -s 'pasadena_token?Pasadena Canvas API token: '
print
read -r -s 'canyons_token?College of the Canyons Canvas API token (optional; press Enter to leave dormant): '
print
read -r -s 'mcp_access_token?MCP client access token (not a Canvas token): '
print

if [[ -z "$pasadena_token" || -z "$mcp_access_token" ]]; then
  print -u2 'The Pasadena Canvas API token and MCP client access token are required.'
  exit 1
fi

{
  print -r -- "CANVAS_API_TOKEN=$pasadena_token"
  print -r -- "MCP_ACCESS_TOKEN=$mcp_access_token"
  if [[ -n "$canyons_token" ]]; then
    print -r -- "CANVAS_COC_API_TOKEN=$canyons_token"
  fi
} >"$secrets_file"

cd "$project_dir"
WRANGLER_LOG_PATH=/tmp/canvas-lms-mcp-deploy.log pnpm wrangler deploy --secrets-file "$secrets_file"
