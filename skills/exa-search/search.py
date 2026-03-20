#!/usr/bin/env python3
"""
Exa AI Search Script

Search the web using Exa API with configurable content types, categories, and freshness.

Usage:
    ./search.py "query" [--category TYPE] [--content highlights|text] [--num_results N]
    
Examples:
    ./search.py "machine learning tutorial"
    ./search.py "AI startup healthcare" --category company
    ./search.py "transformer architecture" --category "research paper" --content text
    ./search.py "breaking news" --category news --max_age_hours 1
"""

import argparse
import json
import os
import sys
from typing import Optional

try:
    from exa_py import Exa
except ImportError:
    print("Error: exa-py not installed. Run: pip install exa-py")
    sys.exit(1)


def search_exa(
    query: str,
    category: Optional[str] = None,
    content_type: str = "highlights",
    num_results: int = 10,
    max_age_hours: Optional[int] = None,
    include_domains: Optional[list] = None,
    exclude_domains: Optional[list] = None,
    use_livecrawl: bool = False,
) -> dict:
    """
    Search using Exa API.

    Args:
        query: Search query
        category: Content category (people, company, news, research paper, tweet)
        content_type: "highlights" for snippets or "text" for full content
        num_results: Number of results to return
        max_age_hours: Maximum acceptable age for cached content
        include_domains: Only search these domains
        exclude_domains: Exclude these domains
        use_livecrawl: Force livecrawl (max_age_hours=0)

    Returns:
        dict with search results
    """
    api_key = os.environ.get("EXA_API_KEY")
    if not api_key:
        return {"error": "EXA_API_KEY not set. Set it with: export EXA_API_KEY='your_key'"}

    exa = Exa(api_key=api_key)

    # Build contents config
    contents_config = {}
    if content_type == "highlights":
        contents_config = {"highlights": {"max_characters": 2000}}
    elif content_type == "text":
        contents_config = {"text": {"max_characters": 20000}}

    # Build search params
    params = {
        "query": query,
        "type": "auto",  # Balanced relevance and speed
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

        # Format results for display
        formatted_results = []
        for i, result in enumerate(results.results, 1):
            entry = {
                "rank": i,
                "title": result.title,
                "url": result.url,
                "score": getattr(result, "score", None),
            }

            # Add content if available
            if hasattr(result, "highlights") and result.highlights:
                entry["highlights"] = result.highlights
            if hasattr(result, "text") and result.text:
                entry["text"] = result.text[:500] + "..." if len(result.text) > 500 else result.text

            formatted_results.append(entry)

        return {
            "query": query,
            "category": category,
            "num_results": len(formatted_results),
            "results": formatted_results,
        }

    except Exception as e:
        return {"error": f"Search failed: {str(e)}"}


def main():
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
        "--num_results", "-n", type=int, default=10, help="Number of results (default: 10)"
    )
    parser.add_argument(
        "--max_age_hours", type=int, help="Maximum age for cached content (hours)"
    )
    parser.add_argument(
        "--include_domains", nargs="+", help="Only search these domains"
    )
    parser.add_argument("--exclude_domains", nargs="+", help="Exclude these domains")
    parser.add_argument("--livecrawl", action="store_true", help="Force livecrawl")
    parser.add_argument("--json", action="store_true", help="Output as JSON")

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

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        # Pretty print results
        if "error" in result:
            print(f"❌ Error: {result['error']}")
            return

        print(f"\n🔍 Search: {result['query']}")
        if result.get("category"):
            print(f"📁 Category: {result['category']}")
        print(f"📊 Found: {result['num_results']} results\n")

        for entry in result["results"]:
            print(f"{entry['rank']}. {entry['title']}")
            print(f"   🌐 {entry['url']}")
            if "highlights" in entry and entry["highlights"]:
                print(f"   💡 Highlights:")
                for highlight in entry["highlights"][:2]:  # Show first 2 highlights
                    print(f"      - {highlight}")
            print()


if __name__ == "__main__":
    main()