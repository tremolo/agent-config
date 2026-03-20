#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["exa-py"]
# ///
"""
Exa AI Search CLI.
Outputs structured JSON for agent consumption.
"""

import argparse
import json
import os
import sys
from typing import Optional

from exa_py import Exa


def _load_pi_secrets() -> None:
    secrets_path = os.path.expanduser("~/.config/pi-secrets.sh")
    if not os.path.exists(secrets_path):
        return

    try:
        with open(secrets_path, "r", encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#") or not line.startswith("export "):
                    continue
                key_value = line[len("export ") :]
                if "=" not in key_value:
                    continue
                key, value = key_value.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except OSError:
        pass


_load_pi_secrets()


def _error(message: str) -> dict:
    return {"ok": False, "error": message}


def search_exa(
    query: str,
    category: Optional[str],
    content_type: str,
    num_results: int,
    max_age_hours: Optional[int],
    include_domains: Optional[list[str]],
    exclude_domains: Optional[list[str]],
    use_livecrawl: bool,
) -> dict:
    api_key = os.environ.get("EXA_API_KEY")
    if not api_key:
        return _error("EXA_API_KEY is not set in the environment.")

    exa = Exa(api_key=api_key)

    contents_config: dict = {}
    if content_type == "highlights":
        contents_config = {"highlights": {"max_characters": 2000}}
    elif content_type == "text":
        contents_config = {"text": {"max_characters": 20000}}

    params: dict = {
        "query": query,
        "type": "auto",
        "num_results": num_results,
    }

    if category:
        params["category"] = category

    if contents_config:
        params["contents"] = contents_config

    if max_age_hours is not None:
        params["max_age_hours"] = max_age_hours

    if include_domains:
        params["include_domains"] = include_domains

    if exclude_domains:
        params["exclude_domains"] = exclude_domains

    if use_livecrawl:
        params["use_livecrawl"] = True

    try:
        results = exa.search(**params)
    except Exception as exc:
        return _error(f"Search failed: {exc}")

    formatted_results = []
    for index, result in enumerate(results.results, start=1):
        entry = {
            "rank": index,
            "title": result.title,
            "url": result.url,
            "score": getattr(result, "score", None),
        }

        if getattr(result, "highlights", None):
            entry["highlights"] = result.highlights
        if getattr(result, "text", None):
            entry["text"] = result.text

        formatted_results.append(entry)

    return {
        "ok": True,
        "query": query,
        "category": category,
        "num_results": len(formatted_results),
        "results": formatted_results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Exa AI Search")
    parser.add_argument("query", help="Search query")
    parser.add_argument(
        "--category",
        "-c",
        choices=["people", "company", "news", "research paper", "tweet"],
        help="Content category",
    )
    parser.add_argument(
        "--content",
        choices=["highlights", "text"],
        default="highlights",
        help="Content type (default: highlights)",
    )
    parser.add_argument(
        "--num_results",
        "-n",
        type=int,
        default=10,
        help="Number of results (default: 10)",
    )
    parser.add_argument("--max_age_hours", type=int, help="Maximum cache age (hours)")
    parser.add_argument("--include_domains", nargs="+", help="Only search these domains")
    parser.add_argument("--exclude_domains", nargs="+", help="Exclude these domains")
    parser.add_argument("--livecrawl", action="store_true", help="Force livecrawl")

    args = parser.parse_args()

    result = search_exa(
        query=args.query,
        category=args.category,
        content_type=args.content,
        num_results=args.num_results,
        max_age_hours=args.max_age_hours,
        include_domains=args.include_domains,
        exclude_domains=args.exclude_domains,
        use_livecrawl=args.livecrawl,
    )

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
