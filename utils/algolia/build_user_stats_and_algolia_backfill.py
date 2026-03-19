#!/usr/bin/env python3

import argparse
import json
import os
import random
import subprocess
import sys
import unicodedata
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import boto3

DEFAULT_CACHE_DIR = 'tmp/algolia-user-backfill'
DEFAULT_REGION = 'eu-west-3'
DEFAULT_USERS_TABLE = 'Efrei-Sport-Climbing-App.users'
DEFAULT_SESSIONS_TABLE = 'Efrei-Sport-Climbing-App.sessions'
DEFAULT_TICKETS_TABLE = 'Efrei-Sport-Climbing-App.tickets'
DEFAULT_ISSUES_TABLE = 'Efrei-Sport-Climbing-App.issues'
DEFAULT_USER_STATS_TABLE = 'Efrei-Sport-Climbing-App.user-stats'
DEFAULT_ALGOLIA_SECRET_PATH = 'Efrei-Sport-Climbing-App/secrets/algolia'
DEFAULT_ALGOLIA_INDEX = 'esc_users'
STATS_VERSION = 'v1'
WEEKDAYS_FR = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']


def require_env_or_arg(value: str | None, name: str, default: str | None = None) -> str:
    resolved = value or os.environ.get(name) or default
    if not resolved:
        raise RuntimeError(f'Missing configuration value for {name}')
    return resolved


def convert_decimals(value: Any) -> Any:
    if isinstance(value, list):
        return [convert_decimals(item) for item in value]
    if isinstance(value, dict):
        return {key: convert_decimals(item) for key, item in value.items()}
    if isinstance(value, Decimal):
        if value % 1 == 0:
            return int(value)
        return float(value)
    return value


def load_json(path: Path) -> Any:
    with path.open('r', encoding='utf-8') as stream:
        return json.load(stream)


def dump_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8') as stream:
        json.dump(payload, stream, indent=2, ensure_ascii=False)


def iso_or_none(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def timestamp_ms_or_none(value: datetime | None) -> int | None:
    return int(value.timestamp() * 1000) if value else None


def parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def normalize_string(value: str) -> str:
    stripped = ''.join(
        character for character in unicodedata.normalize('NFD', value) if unicodedata.category(character) != 'Mn'
    )
    return ' '.join(stripped.lower().split())


def parse_promo_year(promo: str) -> int | None:
    digits = ''.join(character for character in promo if character.isdigit())
    if len(digits) < 4:
        return None
    return int(digits[:4])


def get_initials(first_name: str, last_name: str) -> str:
    return f'{first_name[:1]}{last_name[:1]}'.upper()


def build_search_keywords(user: dict[str, Any], full_name: str) -> list[str]:
    values = [
        user['id'],
        user['firstName'],
        user['lastName'],
        user['promo'],
        full_name,
        normalize_string(user['firstName']),
        normalize_string(user['lastName']),
        normalize_string(full_name),
    ]
    keywords: list[str] = []
    seen: set[str] = set()
    for value in values:
        cleaned = value.strip()
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            keywords.append(cleaned)
    return keywords


def get_git_commit() -> str | None:
    try:
        return (
            subprocess.check_output(['git', 'rev-parse', 'HEAD'], stderr=subprocess.DEVNULL, text=True).strip() or None
        )
    except (OSError, subprocess.CalledProcessError):
        return None


def load_secret(secret_path: str, region: str) -> dict[str, Any]:
    client = boto3.client('secretsmanager', region_name=region)
    response = client.get_secret_value(SecretId=secret_path)
    return json.loads(response['SecretString'])


def load_algolia_credentials(secret_path: str, region: str) -> tuple[str, str]:
    secret = load_secret(secret_path, region)
    return secret['ALGOLIA_APP_ID'], secret['ALGOLIA_ADMIN_API_KEY']


def scan_table(table_name: str, region: str) -> list[dict[str, Any]]:
    table = boto3.resource('dynamodb', region_name=region).Table(table_name)
    items: list[dict[str, Any]] = []
    response = table.scan()
    items.extend(convert_decimals(response.get('Items', [])))
    while 'LastEvaluatedKey' in response:
        response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
        items.extend(convert_decimals(response.get('Items', [])))
    return items


def build_user_assignment_weights(
    users: list[dict[str, Any]],
    session_participants_by_user_id: dict[str, list[dict[str, Any]]],
) -> dict[str, float]:
    weights: dict[str, float] = {}
    for user in users:
        user_id = str(user['id'])
        sessions = session_participants_by_user_id.get(user_id, [])
        total_sessions = len(sessions)
        climb_up_sessions = sum(1 for session in sessions if str(session.get('location', '')).startswith('climb-up'))
        weights[user_id] = 1.0 + total_sessions + (climb_up_sessions * 3.0)
    return weights


def choose_weighted_user_id(
    user_ids: list[str],
    weights: dict[str, float],
    rng: random.Random,
) -> str:
    total_weight = sum(weights[user_id] for user_id in user_ids)
    threshold = rng.uniform(0, total_weight)
    cumulative = 0.0
    for user_id in user_ids:
        cumulative += weights[user_id]
        if threshold <= cumulative:
            return user_id
    return user_ids[-1]


def compute_order_ticket_assignments(
    order_rows: list[dict[str, Any]],
    available_user_ids: list[str],
    user_weights: dict[str, float],
) -> tuple[dict[str, str | None], str | None]:
    sorted_ticket_rows = sorted(order_rows, key=lambda row: str(row['id']))
    if not available_user_ids:
        return {str(row['id']): None for row in sorted_ticket_rows}, 'no_users_available_for_random_assignment'
    rng = random.Random(str(sorted_ticket_rows[0]['orderId']))
    assignments: dict[str, str | None] = {
        str(row['id']): choose_weighted_user_id(available_user_ids, user_weights, rng)
        for row in sorted_ticket_rows
    }
    return assignments, 'random_weighted_assignment'


def choose_counter_key(counter: Counter[str]) -> str | None:
    if not counter:
        return None
    max_count = max(counter.values())
    candidates = sorted(key for key, count in counter.items() if count == max_count)
    return candidates[0] if candidates else None


def compute_activity_status(
    now: datetime,
    first_seen: datetime | None,
    last_activity: datetime | None,
    total_sessions: int,
) -> str:
    if total_sessions == 0 or not last_activity:
        return 'inactive'
    if first_seen and (now - first_seen).days <= 30 and total_sessions <= 3:
        return 'new'
    if total_sessions >= 20 and (now - last_activity).days <= 30:
        return 'power_user'
    if (now - last_activity).days > 90:
        return 'inactive'
    return 'active'


def compute_profile_completeness(user: dict[str, Any], ticket_count: int, last_activity: datetime | None) -> int:
    score = 0
    for field in ('firstName', 'lastName', 'promo'):
        if user.get(field):
            score += 20
    if user.get('id'):
        score += 15
    if last_activity:
        score += 15
    if ticket_count > 0:
        score += 10
    return min(score, 100)


def build_tags(activity_status: str, location_counter: Counter[str]) -> list[str]:
    tags: list[str] = []
    if activity_status == 'new':
        tags.append('new_member')
    elif activity_status == 'active':
        tags.append('active_member')
    elif activity_status == 'power_user':
        tags.append('power_user')
    else:
        tags.append('inactive_member')
    if len(location_counter) > 1:
        tags.append('multi_location')
    return tags


def compute_from_cache(
    cache_dir: Path,
    now: datetime,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    users = load_json(cache_dir / 'users.json')
    sessions = load_json(cache_dir / 'sessions.json')
    tickets = load_json(cache_dir / 'tickets.json')
    issues = load_json(cache_dir / 'issues.json')
    order_fetch_errors = load_json(cache_dir / 'order_fetch_errors.json')

    session_rows = {str(item['id']): item for item in sessions if item.get('id') == item.get('sortId')}
    session_participants_by_user_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in sessions:
        if row.get('id') == row.get('sortId'):
            continue
        session = session_rows.get(str(row['id']))
        if not session:
            continue
        session_participants_by_user_id[str(row['sortId'])].append(session)

    ticket_rows_by_order_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in tickets:
        if row.get('id') == row.get('orderId'):
            continue
        ticket_rows_by_order_id[str(row['orderId'])].append(row)

    issue_rows_by_order_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in issues:
        issue_rows_by_order_id[str(row['orderId'])].append(row)

    user_assignment_weights = build_user_assignment_weights(users, session_participants_by_user_id)
    available_user_ids = sorted(user_assignment_weights)

    ticket_user_assignments: dict[str, dict[str, str | None]] = {}
    order_resolution_status: dict[str, str | None] = {}
    for order_id, rows in ticket_rows_by_order_id.items():
        assignments, status = compute_order_ticket_assignments(
            rows,
            available_user_ids,
            user_assignment_weights,
        )
        ticket_user_assignments[order_id] = assignments
        order_resolution_status[order_id] = status

    ticket_count_by_user_id: Counter[str] = Counter()
    open_issues_by_user_id: dict[str, bool] = defaultdict(bool)
    unresolved_order_ids: list[str] = []
    for order_id, assignments in ticket_user_assignments.items():
        if order_resolution_status.get(order_id):
            unresolved_order_ids.append(order_id)
        for user_id in assignments.values():
            if user_id:
                ticket_count_by_user_id[user_id] += 1
        for issue in issue_rows_by_order_id.get(order_id, []):
            if issue.get('status') != 'open':
                continue
            unique_user_ids = {user_id for user_id in assignments.values() if user_id}
            if unique_user_ids:
                for user_id in unique_user_ids:
                    open_issues_by_user_id[user_id] = True

    computed_stats: list[dict[str, Any]] = []
    computed_algolia_records: list[dict[str, Any]] = []

    for user in users:
        user_id = str(user['id'])
        full_name = f"{user['firstName']} {user['lastName']}".strip()
        normalized_full_name = normalize_string(full_name)
        user_sessions = sorted(
            session_participants_by_user_id.get(user_id, []),
            key=lambda session: int(session['date']),
        )
        session_dates = [
            datetime.fromtimestamp(int(session['date']) / 1000, tz=UTC)
            for session in user_sessions
        ]
        first_seen = session_dates[0] if session_dates else None
        last_activity = session_dates[-1] if session_dates else None
        last_30_cutoff = now - timedelta(days=30)
        last_90_cutoff = now - timedelta(days=90)
        sessions_last_30_days = sum(1 for date in session_dates if date >= last_30_cutoff)
        sessions_last_90_days = sum(1 for date in session_dates if date >= last_90_cutoff)
        location_counter = Counter(str(session['location']) for session in user_sessions)
        weekday_counter = Counter(WEEKDAYS_FR[date.weekday()] for date in session_dates)
        ticket_count = ticket_count_by_user_id.get(user_id, 0)
        activity_status = compute_activity_status(now, first_seen, last_activity, len(user_sessions))
        profile_completeness_score = compute_profile_completeness(user, ticket_count, last_activity)
        stats_record = {
            'userId': user_id,
            'nbOfSeances': len(user_sessions),
            'firstSeenAt': timestamp_ms_or_none(first_seen),
            'lastActivityAt': timestamp_ms_or_none(last_activity),
            'lastSessionDate': timestamp_ms_or_none(last_activity),
            'sessionsLast30Days': sessions_last_30_days,
            'sessionsLast90Days': sessions_last_90_days,
            'membershipTenureDays': (now - first_seen).days if first_seen else None,
            'activityStatus': activity_status,
            'favoriteLocation': choose_counter_key(location_counter),
            'preferredDayOfWeek': choose_counter_key(weekday_counter),
            'ticketCount': ticket_count,
            'hasOpenIssue': open_issues_by_user_id.get(user_id, False),
            'profileCompletenessScore': profile_completeness_score,
            'tags': build_tags(activity_status, location_counter),
            'attendanceRate': None,
            'computedAt': timestamp_ms_or_none(now),
            'statsVersion': STATS_VERSION,
        }
        computed_stats.append(stats_record)
        computed_algolia_records.append(
            {
                'objectID': user_id,
                'id': user_id,
                'firstName': user['firstName'],
                'lastName': user['lastName'],
                'promo': user['promo'],
                'fullName': full_name,
                'fullNameNormalized': normalized_full_name,
                'initials': get_initials(user['firstName'], user['lastName']),
                'promoYear': parse_promo_year(str(user['promo'])),
                'searchKeywords': build_search_keywords(user, full_name),
                'nbOfSeances': stats_record['nbOfSeances'],
                'firstSeenAt': iso_or_none(first_seen),
                'lastActivityAt': iso_or_none(last_activity),
                'lastSessionDate': iso_or_none(last_activity),
                'sessionsLast30Days': stats_record['sessionsLast30Days'],
                'sessionsLast90Days': stats_record['sessionsLast90Days'],
                'membershipTenureDays': stats_record['membershipTenureDays'],
                'activityStatus': stats_record['activityStatus'],
                'favoriteLocation': stats_record['favoriteLocation'],
                'preferredDayOfWeek': stats_record['preferredDayOfWeek'],
                'ticketCount': stats_record['ticketCount'],
                'hasOpenIssue': stats_record['hasOpenIssue'],
                'profileCompletenessScore': stats_record['profileCompletenessScore'],
                'tags': stats_record['tags'],
                'attendanceRate': None,
                'computedAt': iso_or_none(now),
                'statsVersion': STATS_VERSION,
            }
        )

    report = {
        'generatedAt': iso_or_none(now),
        'usersCount': len(users),
        'sessionsCount': len(sessions),
        'ticketRowsCount': len(tickets),
        'issueRowsCount': len(issues),
        'ordersFetchedCount': 0,
        'orderFetchErrorsCount': len(order_fetch_errors),
        'unresolvedOrderIds': sorted(unresolved_order_ids),
        'unresolvedOrderCount': len(unresolved_order_ids),
        'orderResolutionStatus': order_resolution_status,
        'ticketUserAssignments': ticket_user_assignments,
        'usersWithoutSessionsCount': sum(1 for item in computed_stats if item['nbOfSeances'] == 0),
        'nullFavoriteLocationCount': sum(1 for item in computed_stats if item['favoriteLocation'] is None),
        'nullPreferredDayOfWeekCount': sum(1 for item in computed_stats if item['preferredDayOfWeek'] is None),
        'nullAttendanceRateCount': len(computed_stats),
    }
    return computed_stats, computed_algolia_records, report


def write_user_stats(region: str, table_name: str, stats_records: list[dict[str, Any]]) -> None:
    table = boto3.resource('dynamodb', region_name=region).Table(table_name)
    with table.batch_writer(overwrite_by_pkeys=['userId']) as batch:
        for stats in stats_records:
            batch.put_item(Item=convert_decimals(stats))


def update_ticket_rows_with_user_ids(
    region: str,
    table_name: str,
    assignments_by_order_id: dict[str, dict[str, str | None]],
) -> int:
    table = boto3.resource('dynamodb', region_name=region).Table(table_name)
    updated_count = 0
    for order_id, assignments in assignments_by_order_id.items():
        for ticket_id, user_id in assignments.items():
            table.update_item(
                Key={'id': ticket_id, 'orderId': order_id},
                UpdateExpression='SET userId = :user_id',
                ExpressionAttributeValues={':user_id': user_id},
            )
            updated_count += 1
    return updated_count


def batch_index(app_id: str, api_key: str, index_name: str, records: list[dict[str, Any]]) -> None:
    url = f'https://{app_id}-dsn.algolia.net/1/indexes/{index_name}/batch'
    operations = [{'action': 'updateObject', 'body': record} for record in records]
    payload = json.dumps({'requests': operations}).encode('utf-8')
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            'Content-Type': 'application/json',
            'X-Algolia-Application-Id': app_id,
            'X-Algolia-API-Key': api_key,
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(request) as response:
            response.read()
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode('utf-8')) from error


def write_algolia(region: str, secret_path: str, index_name: str, records: list[dict[str, Any]]) -> None:
    app_id, api_key = load_algolia_credentials(secret_path, region)
    for start in range(0, len(records), 500):
        batch_index(app_id, api_key, index_name, records[start : start + 500])


def fetch_cache(args: argparse.Namespace, cache_dir: Path) -> dict[str, Any]:
    users = scan_table(args.users_table, args.region)
    sessions = scan_table(args.sessions_table, args.region)
    tickets = scan_table(args.tickets_table, args.region)
    issues = scan_table(args.issues_table, args.region)

    dump_json(cache_dir / 'users.json', users)
    dump_json(cache_dir / 'sessions.json', sessions)
    dump_json(cache_dir / 'tickets.json', tickets)
    dump_json(cache_dir / 'issues.json', issues)
    dump_json(cache_dir / 'orders.json', {})
    dump_json(cache_dir / 'order_fetch_errors.json', {})

    manifest = {
        'generatedAt': iso_or_none(datetime.now(tz=UTC)),
        'region': args.region,
        'environmentName': args.environment_name,
        'gitCommit': get_git_commit(),
        'tables': {
            'users': args.users_table,
            'sessions': args.sessions_table,
            'tickets': args.tickets_table,
            'issues': args.issues_table,
            'userStats': args.user_stats_table,
        },
        'counts': {
            'users': len(users),
            'sessions': len(sessions),
            'tickets': len(tickets),
            'issues': len(issues),
            'orders': 0,
            'orderFetchErrors': 0,
        },
    }
    dump_json(cache_dir / 'manifest.json', manifest)
    return manifest


def compute_cache(cache_dir: Path) -> dict[str, Any]:
    now = datetime.now(tz=UTC)
    stats_records, algolia_records, report = compute_from_cache(cache_dir, now)
    dump_json(cache_dir / 'computed_user_stats.json', stats_records)
    dump_json(cache_dir / 'computed_algolia_records.json', algolia_records)
    dump_json(cache_dir / 'report.json', report)
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Build cached user stats and Algolia backfill payloads')
    parser.add_argument(
        '--mode',
        choices=['fetch', 'compute', 'write-ticket-users', 'write-stats', 'write-algolia', 'all'],
        default='all',
    )
    parser.add_argument('--region', default=os.environ.get('AWS_REGION', DEFAULT_REGION))
    parser.add_argument('--environment-name', default=os.environ.get('ENVIRONMENT_NAME', 'test'))
    parser.add_argument('--cache-dir', default=os.environ.get('ALGOLIA_BACKFILL_CACHE_DIR', DEFAULT_CACHE_DIR))
    parser.add_argument('--users-table', default=os.environ.get('USERS_TABLE', DEFAULT_USERS_TABLE))
    parser.add_argument('--sessions-table', default=os.environ.get('SESSIONS_TABLE', DEFAULT_SESSIONS_TABLE))
    parser.add_argument('--tickets-table', default=os.environ.get('TICKETS_TABLE', DEFAULT_TICKETS_TABLE))
    parser.add_argument('--issues-table', default=os.environ.get('ISSUES_TABLE', DEFAULT_ISSUES_TABLE))
    parser.add_argument('--user-stats-table', default=os.environ.get('USER_STATS_TABLE', DEFAULT_USER_STATS_TABLE))
    parser.add_argument(
        '--algolia-secret-path',
        default=os.environ.get('ALGOLIA_SECRET_PATH', DEFAULT_ALGOLIA_SECRET_PATH),
    )
    parser.add_argument('--algolia-users-index', default=os.environ.get('ALGOLIA_USERS_INDEX', DEFAULT_ALGOLIA_INDEX))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cache_dir = Path(require_env_or_arg(args.cache_dir, 'ALGOLIA_BACKFILL_CACHE_DIR'))

    if args.mode in {'fetch', 'all'}:
        fetch_cache(args, cache_dir)

    if args.mode in {'compute', 'all'}:
        compute_cache(cache_dir)

    if args.mode in {'write-ticket-users', 'all'}:
        report = load_json(cache_dir / 'report.json')
        updated_count = update_ticket_rows_with_user_ids(
            args.region,
            args.tickets_table,
            report['ticketUserAssignments'],
        )
        report['ticketRowsUpdatedWithUserId'] = updated_count
        dump_json(cache_dir / 'report.json', report)

    if args.mode in {'write-stats', 'all'}:
        stats_records = load_json(cache_dir / 'computed_user_stats.json')
        write_user_stats(args.region, args.user_stats_table, stats_records)

    if args.mode in {'write-algolia', 'all'}:
        algolia_records = load_json(cache_dir / 'computed_algolia_records.json')
        write_algolia(args.region, args.algolia_secret_path, args.algolia_users_index, algolia_records)

    return 0


if __name__ == '__main__':
    sys.exit(main())
