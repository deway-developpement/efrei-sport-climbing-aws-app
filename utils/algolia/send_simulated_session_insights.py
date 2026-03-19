#!/usr/bin/env python3

import argparse
import importlib
import json
import os
import random
import sys
import urllib.error
import urllib.request
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import boto3

DEFAULT_REGION = 'eu-west-3'
DEFAULT_USERS_TABLE = 'Efrei-Sport-Climbing-App.users'
DEFAULT_USER_STATS_TABLE = 'Efrei-Sport-Climbing-App.user-stats'
DEFAULT_SESSIONS_TABLE = 'Efrei-Sport-Climbing-App.sessions'
DEFAULT_ALGOLIA_INDEX = 'esc_sessions'
DEFAULT_ALGOLIA_SECRET_PATH = 'Efrei-Sport-Climbing-App/secrets/algolia'
DEFAULT_BATCH_SIZE = 1000
SUPPORTED_LOCATIONS = {'antrebloc', 'climb-up', 'climb-up-bordeaux'}
CLICK_EVENT_NAME = 'Session Recommendation Clicked'
CONVERSION_EVENT_NAME = 'Session Joined After Recommendation'


def load_algolia_modules() -> tuple[Any, Any]:
    module_candidates = (
        ('utils.algolia.backfill_algolia_sessions', 'utils.algolia.recommend_algolia_sessions'),
        ('backfill_algolia_sessions', 'recommend_algolia_sessions'),
    )
    for backfill_name, recommendation_name in module_candidates:
        try:
            backfill_module = importlib.import_module(backfill_name)
            recommendation_module = importlib.import_module(recommendation_name)
            return backfill_module, recommendation_module
        except ModuleNotFoundError:
            continue
    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))
    return (
        importlib.import_module('utils.algolia.backfill_algolia_sessions'),
        importlib.import_module('utils.algolia.recommend_algolia_sessions'),
    )


BACKFILL_MODULE, RECOMMENDATION_MODULE = load_algolia_modules()
build_session_records = BACKFILL_MODULE.build_session_records
convert_decimals = BACKFILL_MODULE.convert_decimals
load_algolia_credentials = BACKFILL_MODULE.load_algolia_credentials
recommend_sessions = RECOMMENDATION_MODULE.recommend_sessions
score_recommendation = RECOMMENDATION_MODULE.score_recommendation


@dataclass(frozen=True)
class RecommendationOpportunity:
    user_id: str
    session_id: str
    score: int
    reasons: tuple[str, ...]
    location: str
    session_timestamp: int
    participant_count: int
    activity_level: str


@dataclass(frozen=True)
class SimulatedEvent:
    event_type: str
    event_name: str
    user_token: str
    session_id: str
    timestamp_ms: int
    location: str
    score: int
    reasons: tuple[str, ...]


def require_env_or_arg(value: str | None, name: str, default: str | None = None) -> str:
    resolved = value or os.environ.get(name) or default
    if not resolved:
        raise RuntimeError(f'Missing configuration value for {name}')
    return resolved


def load_dotenv_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_local_env() -> None:
    load_dotenv_file(Path('.env'))
    load_dotenv_file(Path('.env.local'))


def parse_datetime(value: str) -> datetime:
    normalized = value.strip()
    if normalized.endswith('Z'):
        normalized = normalized[:-1] + '+00:00'
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def scan_table(table_name: str, region: str) -> list[dict[str, Any]]:
    table = boto3.resource('dynamodb', region_name=region).Table(table_name)
    items: list[dict[str, Any]] = []
    response = table.scan()
    items.extend(convert_decimals(response.get('Items', [])))
    while 'LastEvaluatedKey' in response:
        response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
        items.extend(convert_decimals(response.get('Items', [])))
    return items


def is_eligible_user(user_stats: dict[str, Any]) -> bool:
    return user_stats.get('activityStatus') != 'inactive' or int(user_stats.get('sessionsLast90Days', 0)) > 0


def normalize_session_records(records: list[dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    return [
        record
        for record in records
        if record.get('isUpcoming')
        and record.get('location') in SUPPORTED_LOCATIONS
        and int(record.get('timestamp', 0)) >= int(now.timestamp() * 1000)
    ]


def build_recommendation_opportunities(
    users: list[dict[str, Any]],
    user_stats_rows: list[dict[str, Any]],
    session_records: list[dict[str, Any]],
    recommendation_limit: int,
) -> list[RecommendationOpportunity]:
    stats_by_user_id = {str(row['userId']): row for row in user_stats_rows}
    opportunities: list[RecommendationOpportunity] = []

    for user in users:
        user_id = str(user['id'])
        user_stats = stats_by_user_id.get(user_id)
        if not user_stats or not is_eligible_user(user_stats):
            continue
        recommendations = sorted(
            (
                (score_recommendation(user, user_stats, session_record), session_record)
                for session_record in session_records
                if session_record.get('isUpcoming')
            ),
            key=lambda item: (-item[0][0], int(item[1].get('timestamp', 0))),
        )[:recommendation_limit]
        for recommendation, session in recommendations:
            score, reasons = recommendation
            opportunities.append(
                RecommendationOpportunity(
                    user_id=user_id,
                    session_id=str(session['objectID']),
                    score=int(score),
                    reasons=tuple(sorted(set(reasons))),
                    location=str(session['location']),
                    session_timestamp=int(session['timestamp']),
                    participant_count=int(session.get('participantCount', 0)),
                    activity_level=str(session.get('activityLevel', 'small')),
                )
            )
    return opportunities


def choose_weighted_opportunity(
    opportunities: list[RecommendationOpportunity],
    rng: random.Random,
) -> RecommendationOpportunity:
    weights = [max(opportunity.score, 1) for opportunity in opportunities]
    return rng.choices(opportunities, weights=weights, k=1)[0]


def choose_weighted_time(start: datetime, end: datetime, rng: random.Random) -> datetime:
    total_seconds = max(int((end - start).total_seconds()), 1)
    while True:
        offset = rng.randint(0, total_seconds)
        candidate = start + timedelta(seconds=offset)
        hour = candidate.hour
        weekday = candidate.weekday()
        weight = 0.05
        if 11 <= hour <= 13:
            weight = 0.45
        elif 17 <= hour <= 22:
            weight = 1.0
        elif 8 <= hour <= 10 or 14 <= hour <= 16:
            weight = 0.2
        if weekday >= 5 and 10 <= hour <= 21:
            weight += 0.1
        if rng.random() <= min(weight, 1.0):
            return candidate


def clamp_datetime(value: datetime, start: datetime, end: datetime) -> datetime:
    if value < start:
        return start
    if value > end:
        return end
    return value


def clamp_window_to_now(start: datetime, end: datetime, now: datetime) -> tuple[datetime, datetime]:
    clamped_end = min(end, now)
    clamped_start = min(start, clamped_end)
    return clamped_start, clamped_end


def compute_click_probability(opportunity: RecommendationOpportunity, base_rate: float) -> float:
    score_bonus = min(opportunity.score / 200.0, 0.25)
    reason_bonus = 0.02 * len(opportunity.reasons)
    activity_bonus = 0.04 if opportunity.activity_level in {'popular', 'very_popular'} else 0.0
    participant_bonus = min(opportunity.participant_count / 200.0, 0.08)
    location_bonus = 0.03 if opportunity.location == 'antrebloc' else 0.0
    return min(base_rate + score_bonus + reason_bonus + activity_bonus + participant_bonus + location_bonus, 0.92)


def compute_conversion_probability(
    opportunity: RecommendationOpportunity,
    base_rate: float,
    click_at: datetime,
) -> float:
    session_datetime = datetime.fromtimestamp(opportunity.session_timestamp / 1000, tz=UTC)
    hours_until_session = (session_datetime - click_at).total_seconds() / 3600
    urgency_bonus = 0.1 if 0 <= hours_until_session <= 72 else 0.03 if hours_until_session <= 168 else 0.0
    social_bonus = 0.03 if 'regular_group' in opportunity.reasons else 0.0
    promo_bonus = 0.02 if 'promo_overlap' in opportunity.reasons else 0.0
    score_bonus = min(opportunity.score / 250.0, 0.18)
    return min(base_rate + urgency_bonus + social_bonus + promo_bonus + score_bonus, 0.85)


def simulate_funnel_events(
    opportunities: list[RecommendationOpportunity],
    target_event_count: int,
    click_rate: float,
    conversion_rate: float,
    start: datetime,
    end: datetime,
    rng: random.Random,
) -> tuple[list[SimulatedEvent], dict[str, int]]:
    if not opportunities:
        raise RuntimeError('No recommendation opportunities available for simulation')

    events: list[SimulatedEvent] = []
    conversion_pairs: set[tuple[str, str]] = set()
    opportunity_clicks: Counter[tuple[str, str]] = Counter()
    hidden_impressions = 0

    while len(events) < target_event_count:
        hidden_impressions += 1
        opportunity = choose_weighted_opportunity(opportunities, rng)
        impression_at = choose_weighted_time(start, end, rng)
        click_probability = compute_click_probability(opportunity, click_rate)

        if rng.random() > click_probability:
            continue

        click_at = clamp_datetime(
            impression_at + timedelta(minutes=rng.randint(1, 6 * 60)),
            start,
            end,
        )
        click_event = SimulatedEvent(
            event_type='click',
            event_name=CLICK_EVENT_NAME,
            user_token=opportunity.user_id,
            session_id=opportunity.session_id,
            timestamp_ms=int(click_at.timestamp() * 1000),
            location=opportunity.location,
            score=opportunity.score,
            reasons=opportunity.reasons,
        )
        events.append(click_event)
        opportunity_clicks[(opportunity.user_id, opportunity.session_id)] += 1
        if len(events) >= target_event_count:
            break

        conversion_probability = compute_conversion_probability(opportunity, conversion_rate, click_at)
        opportunity_key = (opportunity.user_id, opportunity.session_id)
        if opportunity_key in conversion_pairs or rng.random() > conversion_probability:
            continue

        conversion_at = clamp_datetime(
            click_at + timedelta(minutes=rng.randint(5, 36 * 60)),
            click_at,
            end,
        )
        conversion_event = SimulatedEvent(
            event_type='conversion',
            event_name=CONVERSION_EVENT_NAME,
            user_token=opportunity.user_id,
            session_id=opportunity.session_id,
            timestamp_ms=int(conversion_at.timestamp() * 1000),
            location=opportunity.location,
            score=opportunity.score,
            reasons=opportunity.reasons,
        )
        events.append(conversion_event)
        conversion_pairs.add(opportunity_key)

    stats = {
        'hiddenImpressions': hidden_impressions,
        'clickEvents': sum(1 for event in events if event.event_type == 'click'),
        'conversionEvents': sum(1 for event in events if event.event_type == 'conversion'),
        'uniqueConversionPairs': len(conversion_pairs),
    }
    return events[:target_event_count], stats


def build_insights_payload(events: list[SimulatedEvent], index_name: str) -> list[dict[str, Any]]:
    return [
        {
            'eventType': event.event_type,
            'eventName': event.event_name,
            'index': index_name,
            'userToken': event.user_token,
            'objectIDs': [event.session_id],
            'timestamp': event.timestamp_ms,
        }
        for event in events
    ]


def send_insights_events(
    app_id: str,
    api_key: str,
    events: list[dict[str, Any]],
    batch_size: int,
) -> None:
    for start in range(0, len(events), batch_size):
        batch = events[start : start + batch_size]
        payload = json.dumps({'events': batch}).encode('utf-8')
        req = urllib.request.Request(
            'https://insights.algolia.io/1/events',
            data=payload,
            headers={
                'Content-Type': 'application/json',
                'X-Algolia-Application-Id': app_id,
                'X-Algolia-API-Key': api_key,
            },
            method='POST',
        )
        try:
            with urllib.request.urlopen(req) as response:
                response.read()
        except urllib.error.HTTPError as exc:
            raise RuntimeError(exc.read().decode('utf-8')) from exc


def register_conversion_events(
    region: str,
    sessions_table: str,
    conversion_events: list[SimulatedEvent],
) -> int:
    table = boto3.resource('dynamodb', region_name=region).Table(sessions_table)
    writes = 0
    for event in conversion_events:
        key = {'id': event.session_id, 'sortId': event.user_token}
        response = table.get_item(Key=key)
        if response.get('Item'):
            continue
        table.put_item(Item=key)
        writes += 1
    return writes


def build_report(
    events: list[SimulatedEvent],
    opportunities: list[RecommendationOpportunity],
    stats: dict[str, int],
    start: datetime,
    end: datetime,
    selected_users: list[dict[str, Any]],
) -> dict[str, Any]:
    clicks = [event for event in events if event.event_type == 'click']
    conversions = [event for event in events if event.event_type == 'conversion']
    location_counter = Counter(event.location for event in events)
    user_counter = Counter(event.user_token for event in events)
    return {
        'timeWindow': {
            'start': start.isoformat(),
            'end': end.isoformat(),
        },
        'usersConsidered': len(selected_users),
        'recommendationOpportunities': len(opportunities),
        'hiddenImpressions': stats['hiddenImpressions'],
        'totalEvents': len(events),
        'clickEvents': len(clicks),
        'conversionEvents': len(conversions),
        'effectiveClickRate': round(len(clicks) / max(stats['hiddenImpressions'], 1), 4),
        'effectiveConversionRate': round(len(conversions) / max(len(clicks), 1), 4),
        'topLocations': location_counter.most_common(3),
        'topUsers': user_counter.most_common(10),
        'sampleEvents': [asdict(event) for event in events[:10]],
    }


def dump_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Send simulated Algolia session click and conversion events.')
    parser.add_argument(
        '--start',
        required=True,
        help='Inclusive start timestamp, for example 2026-03-01T00:00:00Z',
    )
    parser.add_argument(
        '--end',
        required=True,
        help='Inclusive end timestamp, for example 2026-03-31T23:59:59Z',
    )
    parser.add_argument(
        '--event-count',
        type=int,
        default=3000,
        help='Target total number of click + conversion events.',
    )
    parser.add_argument(
        '--click-rate',
        type=float,
        default=0.18,
        help='Base click-through rate from hidden recommendations.',
    )
    parser.add_argument(
        '--conversion-rate',
        type=float,
        default=0.22,
        help='Base conversion rate from clicked recommendations.',
    )
    parser.add_argument('--target-users', type=int, default=500, help='Maximum number of eligible users to sample.')
    parser.add_argument('--recommendation-limit', type=int, default=8, help='Max recommendations considered per user.')
    parser.add_argument('--seed', type=int, default=42, help='Deterministic simulation seed.')
    parser.add_argument('--mode', choices=['replay', 'register'], default='replay')
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Build and report the simulation without sending events.',
    )
    parser.add_argument('--batch-size', type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument('--region', default=None)
    parser.add_argument('--users-table', default=None)
    parser.add_argument('--user-stats-table', default=None)
    parser.add_argument('--sessions-table', default=None)
    parser.add_argument('--algolia-index', default=None)
    parser.add_argument('--algolia-secret-path', default=None)
    parser.add_argument(
        '--report-path',
        default='tmp/algolia-session-insights-simulation-report.json',
        help='Path to the generated simulation report JSON.',
    )
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if args.event_count <= 0:
        raise RuntimeError('--event-count must be positive')
    if not 0 < args.click_rate <= 1:
        raise RuntimeError('--click-rate must be between 0 and 1')
    if not 0 < args.conversion_rate <= 1:
        raise RuntimeError('--conversion-rate must be between 0 and 1')
    if args.target_users <= 0:
        raise RuntimeError('--target-users must be positive')
    if args.recommendation_limit <= 0:
        raise RuntimeError('--recommendation-limit must be positive')
    if args.batch_size <= 0:
        raise RuntimeError('--batch-size must be positive')


def sample_users(
    users: list[dict[str, Any]],
    user_stats_rows: list[dict[str, Any]],
    target_users: int,
    rng: random.Random,
) -> list[dict[str, Any]]:
    stats_by_user_id = {str(row['userId']): row for row in user_stats_rows}
    eligible_users = [user for user in users if is_eligible_user(stats_by_user_id.get(str(user['id']), {}))]
    if len(eligible_users) <= target_users:
        return eligible_users
    weighted_users = []
    weights = []
    for user in eligible_users:
        user_stats = stats_by_user_id[str(user['id'])]
        weighted_users.append(user)
        weights.append(
            1
            + int(user_stats.get('sessionsLast30Days', 0)) * 3
            + int(user_stats.get('sessionsLast90Days', 0))
        )
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()
    while len(selected) < target_users:
        user = rng.choices(weighted_users, weights=weights, k=1)[0]
        user_id = str(user['id'])
        if user_id in seen:
            continue
        seen.add(user_id)
        selected.append(user)
    return selected


def main() -> int:
    load_local_env()
    args = parse_args()
    validate_args(args)
    start = parse_datetime(args.start)
    end = parse_datetime(args.end)
    now = datetime.now(tz=UTC)
    start, end = clamp_window_to_now(start, end, now)
    if end <= start:
        raise RuntimeError('--end must be after --start')

    region = require_env_or_arg(args.region, 'AWS_REGION', DEFAULT_REGION)
    users_table = require_env_or_arg(args.users_table, 'USERS_TABLE', DEFAULT_USERS_TABLE)
    user_stats_table = require_env_or_arg(args.user_stats_table, 'USER_STATS_TABLE', DEFAULT_USER_STATS_TABLE)
    sessions_table = require_env_or_arg(args.sessions_table, 'SESSIONS_TABLE', DEFAULT_SESSIONS_TABLE)
    algolia_index = require_env_or_arg(args.algolia_index, 'ALGOLIA_SESSIONS_INDEX', DEFAULT_ALGOLIA_INDEX)
    algolia_secret_path = require_env_or_arg(
        args.algolia_secret_path,
        'ALGOLIA_SECRET_PATH',
        DEFAULT_ALGOLIA_SECRET_PATH,
    )

    rng = random.Random(args.seed)
    users = scan_table(users_table, region)
    user_stats_rows = scan_table(user_stats_table, region)
    sessions = scan_table(sessions_table, region)
    selected_users = sample_users(users, user_stats_rows, args.target_users, rng)
    session_records = normalize_session_records(build_session_records(users, sessions, start), start)
    opportunities = build_recommendation_opportunities(
        selected_users,
        user_stats_rows,
        session_records,
        args.recommendation_limit,
    )
    events, stats = simulate_funnel_events(
        opportunities,
        args.event_count,
        args.click_rate,
        args.conversion_rate,
        start,
        end,
        rng,
    )
    report = build_report(events, opportunities, stats, start, end, selected_users)
    dump_report(Path(args.report_path), report)
    if args.dry_run:
        print(json.dumps(report, indent=2))
        return 0

    app_id, api_key = load_algolia_credentials(algolia_secret_path, region)
    payload = build_insights_payload(events, algolia_index)
    send_insights_events(app_id, api_key, payload, args.batch_size)

    registered = 0
    if args.mode == 'register':
        registered = register_conversion_events(
            region,
            sessions_table,
            [event for event in events if event.event_type == 'conversion'],
        )
        report['registeredConversions'] = registered
        dump_report(Path(args.report_path), report)

    print(
        json.dumps(
            {
                'totalEventsSent': len(events),
                'clickEvents': report['clickEvents'],
                'conversionEvents': report['conversionEvents'],
                'registeredConversions': registered,
                'reportPath': args.report_path,
            },
            indent=2,
        )
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
