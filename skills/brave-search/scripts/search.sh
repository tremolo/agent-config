#!/usr/bin/env bash
set -euo pipefail

[ -f "$HOME/.config/pi-secrets.sh" ] && source "$HOME/.config/pi-secrets.sh"

COUNT=5
FRESHNESS=""
COUNTRY=""
SEARCH_LANG=""
RAW_JSON=0

usage() {
  cat <<'EOF'
Usage: search.sh [--count N] [--freshness pd|pw|pm|py] [--country CC] [--search-lang LANG] [--json] <query>
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --count)
      COUNT="$2"
      shift 2
      ;;
    --freshness)
      FRESHNESS="$2"
      shift 2
      ;;
    --country)
      COUNTRY="$2"
      shift 2
      ;;
    --search-lang)
      SEARCH_LANG="$2"
      shift 2
      ;;
    --json)
      RAW_JSON=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 1
fi

if [[ -z "${BRAVE_API:-}" ]]; then
  jq -n '{ok:false,error:"BRAVE_API is not set in the environment."}'
  exit 0
fi

QUERY="$*"
URL="https://api.search.brave.com/res/v1/web/search"
ARGS=(--get --data-urlencode "q=${QUERY}" --data-urlencode "count=${COUNT}")
[[ -n "$FRESHNESS" ]] && ARGS+=(--data-urlencode "freshness=${FRESHNESS}")
[[ -n "$COUNTRY" ]] && ARGS+=(--data-urlencode "country=${COUNTRY}")
[[ -n "$SEARCH_LANG" ]] && ARGS+=(--data-urlencode "search_lang=${SEARCH_LANG}")

RESPONSE=$(curl -sS "$URL" \
  -H "Accept: application/json" \
  -H "X-Subscription-Token: ${BRAVE_API}" \
  "${ARGS[@]}")

if [[ "$RAW_JSON" -eq 1 ]]; then
  printf '%s\n' "$RESPONSE"
  exit 0
fi

printf '%s' "$RESPONSE" | jq --arg query "$QUERY" '
  if .web and .web.results then
    {
      ok: true,
      query: $query,
      results: (
        .web.results
        | to_entries
        | map({
            rank: (.key + 1),
            title: .value.title,
            url: .value.url,
            description: (.value.description // "")
          })
      )
    }
  else
    {
      ok: false,
      query: $query,
      error: (.error?.message // .message // "Unexpected Brave Search API response"),
      raw: .
    }
  end
'
