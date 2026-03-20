---
name: exa-search
description: Searches the web using Exa AI. Use when asked to "search with exa", "exa search", "search the web with exa", "find sources with exa", or for fast, targeted web results (news, companies, people, research papers, tweets). Returns structured JSON and highlights or full text.
allowed-tools: Bash, Read
---

Search the web with Exa AI using the local CLI script and return structured JSON.

## Step 1: Confirm prerequisites

- Ensure `EXA_API_KEY` is available in the environment. If missing, ask the user to set it.
- Run the CLI via `uv run` from the repository root.

## Step 2: Run a search

Use the script in `${CLAUDE_SKILL_ROOT}/scripts/exa_search.py`.

```bash
uv run ${CLAUDE_SKILL_ROOT}/scripts/exa_search.py "<query>" \
  --num_results 5 \
  --content highlights
```

Optional flags:
- `--category {people|company|news|research paper|tweet}`
- `--content {highlights|text}` (use `text` only when full content is required)
- `--max_age_hours <int>`
- `--include_domains domain1 domain2`
- `--exclude_domains domain1 domain2`
- `--livecrawl`

## Step 3: Interpret results

The script outputs JSON:

```json
{
  "ok": true,
  "query": "...",
  "category": "news",
  "num_results": 5,
  "results": [
    {
      "rank": 1,
      "title": "...",
      "url": "...",
      "score": 0.42,
      "highlights": ["..."]
    }
  ]
}
```

If `ok` is false, report the error and suggest how to fix it (missing API key, invalid category, etc.).

## Step 4: Present results to the user

Summarize the top results with titles, URLs, and key highlights. Offer to:
- refine the query
- change the category
- switch to `--content text` for deeper context
- apply domain filters

## Validation

- The command runs with `uv run` from the repo root.
- The response JSON includes `ok`, `query`, `num_results`, and `results`.
- Errors are surfaced clearly to the user.
