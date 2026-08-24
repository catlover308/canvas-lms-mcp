#!/bin/zsh

set -euo pipefail

script_dir=${0:A:h}
project_dir=${script_dir:h}
secrets_file=$(mktemp /tmp/canvas-lms-mcp-secrets.XXXXXX)
chmod 600 "$secrets_file"

cleanup() {
  rm -f "$secrets_file"
  unset pasadena_token canyons_token mcp_access_token owner_secret
}
trap cleanup EXIT HUP INT TERM

read -r -s 'pasadena_token?Pasadena Canvas API token: '
print
read -r -s 'canyons_token?College of the Canyons Canvas API token (optional; press Enter to leave dormant): '
print
read -r -s 'mcp_access_token?MCP client access token (not a Canvas token): '
print
read -r -s 'owner_secret?OAuth owner approval secret (at least 32 characters): '
print

if [[ -z "$pasadena_token" || -z "$mcp_access_token" || ${#owner_secret} -lt 32 ]]; then
  print -u2 'The Canvas and MCP tokens are required; the OAuth owner secret must be at least 32 characters.'
  exit 1
fi

{
  print -r -- "CANVAS_API_TOKEN=$pasadena_token"
  print -r -- "MCP_ACCESS_TOKEN=$mcp_access_token"
  print -r -- "OWNER_SECRET=$owner_secret"
  if [[ -n "$canyons_token" ]]; then
    print -r -- "CANVAS_COC_API_TOKEN=$canyons_token"
  fi
} >"$secrets_file"

cd "$project_dir"
WRANGLER_LOG_PATH=/tmp/canvas-lms-mcp-deploy.log pnpm wrangler deploy --secrets-file "$secrets_file"
