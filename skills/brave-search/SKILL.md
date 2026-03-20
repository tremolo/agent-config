---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or general web content with Brave Search.
allowed-tools: Bash, Read
---

# Brave Search

Search the web with Brave Search API and return structured JSON.

## Step 1: Confirm prerequisites

- Ensure `BRAVE_API` is available in the environment. If missing, ask the user to set it.
- Run the helper script in this skill directory.

## Step 2: Run a search

Use the script in `${CLAUDE_SKILL_ROOT}/scripts/search.sh`.

```bash
${CLAUDE_SKILL_ROOT}/scripts/search.sh "<query>"
```

Optional flags:
- `--count <int>` number of results (default 5, max 20)
- `--freshness <pd|pw|pm|py>` past day/week/month/year
- `--country <code>` country code such as `US`, `DE`
- `--search-lang <code>` language such as `en`, `de`
- `--json` raw JSON output

## Step 3: Interpret results

The script outputs normalized JSON:

```json
{
  "ok": true,
  "query": "...",
  "results": [
    {
      "rank": 1,
      "title": "...",
      "url": "...",
      "description": "..."
    }
  ]
}
```

If `ok` is false, report the error and suggest how to fix it.

## Validation

- The command succeeds with `BRAVE_API` set.
- The response JSON includes `ok`, `query`, and `results`.
- Errors are surfaced clearly to the user.
