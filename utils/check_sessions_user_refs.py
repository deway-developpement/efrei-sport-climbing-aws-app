#!/usr/bin/env python3
import argparse
import csv
import json
import sys
from typing import Any, Dict, Iterator, Set

import boto3
from botocore.config import Config

"""
launch with
python3 check_sessions_user_refs.py \
  --region eu-west-3 \
  --profile account_esc \
  --sessions-table "Efrei-Sport-Climbing-App.sessions" \
  --users-table "Efrei-Sport-Climbing-App.users" \
  --output json \
  --ids-only
"""


def attr_str(item: Dict[str, Any], key: str) -> str | None:
    """
    Safely extract a DynamoDB attribute as string from either S or N, else None.
    """
    v = item.get(key)
    if not isinstance(v, dict):
        return None
    if "S" in v:
        return v["S"]
    if "N" in v:
        return v["N"]
    # Add other DynamoDB types here if needed
    return None


def scan_all(
    client: Any,
    table_name: str,
    projection: str | None = None,
    expr_names: Dict[str, str] | None = None,
) -> Iterator[Dict[str, Any]]:
    """
    Generator that yields all items from a DynamoDB table scan with pagination.
    """
    paginator = client.get_paginator("scan")
    kwargs: Dict[str, Any] = {"TableName": table_name}
    if projection:
        kwargs["ProjectionExpression"] = projection
    if expr_names:
        kwargs["ExpressionAttributeNames"] = expr_names

    for page in paginator.paginate(**kwargs):
        for item in page.get("Items", []):
            yield item


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Validate sessions table: "
            "(A) sessions with no links, "
            "(B) links without a session, and optionally "
            "(C) rows where id != sortId whose sortId is not in users.id (if --users-table provided)."
        )
    )
    parser.add_argument("--region", default="eu-west-3",
                        help="AWS region (default: eu-west-3)")
    parser.add_argument("--profile", default=None, help="AWS profile name")
    parser.add_argument("--sessions-table", required=True,
                        help="Sessions table name")
    parser.add_argument("--users-table", required=False,
                        help="Users table name (optional; enables user-ref check)")
    parser.add_argument(
        "--output", choices=["json", "csv"], default="json", help="Output format (default: json)")
    parser.add_argument("--ids-only", action="store_true",
                        help="Output only id/sortId for offending rows where applicable")
    args = parser.parse_args()

    # Session/profile/region
    boto_sess = boto3.Session(
        profile_name=args.profile, region_name=args.region)
    client = boto_sess.client("dynamodb", config=Config(
        retries={"max_attempts": 10, "mode": "standard"}))

    # 1) Optionally load all user IDs
    user_ids: Set[str] = set()
    if args.users_table:
        for item in scan_all(client, args.users_table, projection="id"):
            uid = attr_str(item, "id")
            if uid is not None:
                user_ids.add(uid)

    # 2) Scan sessions (id, sortId)
    sessions_set: Set[str] = set()           # session rows (id == sortId)
    links_by_session: Dict[str, int] = {}    # count of links per session id

    link_items: list[Dict[str, Any]] = []    # all link rows (id != sortId)
    total_rows = 0

    for item in scan_all(client, args.sessions_table, projection="id, sortId"):
        sid = attr_str(item, "id")
        sort_id = attr_str(item, "sortId")
        if sid is None or sort_id is None:
            continue
        total_rows += 1

        if sid == sort_id:
            sessions_set.add(sid)
        else:
            link_items.append(item)
            links_by_session[sid] = links_by_session.get(sid, 0) + 1

    # A) Sessions with no links
    sessions_without_links = sorted(
        [s for s in sessions_set if links_by_session.get(s, 0) == 0])

    # B) Links without session
    links_without_session = [
        li for li in link_items if attr_str(li, "id") not in sessions_set]

    # C) Optional user-ref check (only if users table provided):
    bad_user_refs = []
    if args.users_table:
        for li in link_items:
            sid = attr_str(li, "id")
            sort_id = attr_str(li, "sortId")
            if sid is None or sort_id is None:
                continue
            if sid != sort_id and sort_id not in user_ids:
                if args.ids_only:
                    bad_user_refs.append({"id": sid, "sortId": sort_id})
                else:
                    bad_user_refs.append(li)

    # 3) Output
    summary = {
        "sessions_count": len(sessions_set),
        "link_items_count": len(link_items),
        "sessions_without_links_count": len(sessions_without_links),
        "links_without_session_count": len(links_without_session),
        "users_count": len(user_ids) if args.users_table else None,
        "bad_user_refs_count": len(bad_user_refs) if args.users_table else None,
        "scanned_rows_count": total_rows,
    }

    if args.output == "json":
        out = {
            "summary": summary,
            "sessions_without_links": sessions_without_links,
            "links_without_session": (
                [{"id": attr_str(i, "id"), "sortId": attr_str(i, "sortId")}
                 for i in links_without_session]
                if args.ids_only else links_without_session
            ),
        }
        if args.users_table:
            out["bad_user_refs"] = bad_user_refs if not args.ids_only else bad_user_refs
        print(json.dumps(out, indent=2))
    else:  # CSV
        writer = csv.writer(sys.stdout)
        # CSV 1: sessions without links
        writer.writerow(["type", "id", "sortId"])  # header
        for sid in sessions_without_links:
            writer.writerow(["session_without_links", sid, ""])
        for li in links_without_session:
            writer.writerow(["link_without_session", attr_str(
                li, "id") or "", attr_str(li, "sortId") or ""])
        if args.users_table:
            for row in bad_user_refs:
                if isinstance(row, dict) and "id" in row and isinstance(row["id"], str):
                    writer.writerow(
                        ["bad_user_ref", row["id"], row.get("sortId", "")])
                else:
                    writer.writerow(["bad_user_ref", attr_str(
                        row, "id") or "", attr_str(row, "sortId") or ""])

    # Exit code: 0 if clean, 2 if any issues found
    has_issues = bool(sessions_without_links or links_without_session or (
        args.users_table and bad_user_refs))
    if has_issues:
        sys.exit(2)


if __name__ == "__main__":
    main()
