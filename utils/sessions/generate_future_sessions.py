#!/usr/bin/env python3

import argparse
import importlib
import json
import os
import random
import sys
import time as time_module
from collections import Counter, defaultdict
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib import error, request

import boto3


def load_algolia_helpers() -> tuple[Any, Any, Any, Any]:
    for module_name in ('utils.algolia.backfill_algolia_sessions', 'algolia.backfill_algolia_sessions'):
        try:
            module = importlib.import_module(module_name)
            return (
                module.DEFAULT_ALGOLIA_INDEX,
                module.batch_index,
                module.build_session_records,
                module.load_algolia_credentials,
            )
        except ModuleNotFoundError:
            continue
    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))
    module = importlib.import_module('utils.algolia.backfill_algolia_sessions')
    return (
        module.DEFAULT_ALGOLIA_INDEX,
        module.batch_index,
        module.build_session_records,
        module.load_algolia_credentials,
    )


DEFAULT_ALGOLIA_INDEX, batch_index, build_session_records, load_algolia_credentials = load_algolia_helpers()

DEFAULT_REGION = 'eu-west-3'
DEFAULT_USERS_TABLE = 'Efrei-Sport-Climbing-App.users'
DEFAULT_SESSIONS_TABLE = 'Efrei-Sport-Climbing-App.sessions'
DEFAULT_CACHE_DIR = 'tmp/algolia-user-backfill'
DEFAULT_DISCORD_SECRET_ID = 'Efrei-Sport-Climbing-App/secrets/discord_bot_token'
DEFAULT_ALGOLIA_SECRET_PATH = 'Efrei-Sport-Climbing-App/secrets/algolia'
DEFAULT_DISCORD_API_BASE_URL = 'https://discord.com/api/v10'
DISCORD_HTTP_USER_AGENT = 'DiscordBot (https://github.com/P4UL-M/efrei-sport-climbing-aws-app, 1.0)'
DEFAULT_DISCORD_MAX_RETRIES = 5
DISCORD_EPOCH_MS = 1420070400000

ENV_CHANNELS = {
    'antrebloc': 'ANTREBLOC_CHANNEL',
    'climb-up': 'CLIMBUP_CHANNEL',
    'climb-up-bordeaux': 'CLIMBUP_BORDEAUX_CHANNEL',
}
SUPPORTED_LOCATIONS = tuple(ENV_CHANNELS.keys())
FRENCH_WEEKDAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']
FRENCH_MONTHS = [
    'janvier',
    'fevrier',
    'mars',
    'avril',
    'mai',
    'juin',
    'juillet',
    'aout',
    'septembre',
    'octobre',
    'novembre',
    'decembre',
]


def load_dotenv_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def load_local_env() -> None:
    load_dotenv_file(Path('.env'))
    load_dotenv_file(Path('.env.local'))


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


def scan_table(table_name: str, region: str) -> list[dict[str, Any]]:
    table = boto3.resource('dynamodb', region_name=region).Table(table_name)
    items: list[dict[str, Any]] = []
    response = table.scan()
    items.extend(convert_decimals(response.get('Items', [])))
    while 'LastEvaluatedKey' in response:
        response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
        items.extend(convert_decimals(response.get('Items', [])))
    return items


def fetch_secret_json(secret_id: str, region: str) -> dict[str, Any]:
    client = boto3.client('secretsmanager', region_name=region)
    response = client.get_secret_value(SecretId=secret_id)
    secret_string = response.get('SecretString')
    if not secret_string:
        raise ValueError(f'Secret {secret_id} has no SecretString payload')
    return json.loads(secret_string)


def date_to_discord_snowflake(target: datetime) -> str:
    timestamp = int(target.timestamp() * 1000) - DISCORD_EPOCH_MS
    return str(timestamp << 22)


def get_next_week_dates(today: date) -> list[date]:
    start = today + timedelta(days=1)
    return [start + timedelta(days=offset) for offset in range(7)]


def load_or_fetch_cache(
    region: str,
    users_table: str,
    sessions_table: str,
    cache_dir: Path,
    *,
    refresh_cache: bool = False,
    use_cache: bool = True,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    users_path = cache_dir / 'users.json'
    sessions_path = cache_dir / 'sessions.json'
    if use_cache and not refresh_cache and users_path.exists() and sessions_path.exists():
        return json.loads(users_path.read_text()), json.loads(sessions_path.read_text())
    users = scan_table(users_table, region)
    sessions = scan_table(sessions_table, region)
    if use_cache:
        cache_dir.mkdir(parents=True, exist_ok=True)
        users_path.write_text(json.dumps(users, indent=2))
        sessions_path.write_text(json.dumps(sessions, indent=2))
    return users, sessions


def build_user_patterns(
    users: list[dict[str, Any]],
    sessions: list[dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], dict[str, Counter[str]], dict[str, Counter[int]]]:
    session_rows = {str(row['id']): row for row in sessions if row.get('id') == row.get('sortId')}
    sessions_by_user_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in sessions:
        if row.get('id') == row.get('sortId'):
            continue
        session = session_rows.get(str(row['id']))
        if session:
            sessions_by_user_id[str(row['sortId'])].append(session)

    user_patterns: dict[str, dict[str, Any]] = {}
    location_by_weekday: dict[str, Counter[str]] = defaultdict(Counter)
    hour_by_weekday: dict[str, Counter[int]] = defaultdict(Counter)

    for user in users:
        user_id = str(user['id'])
        user_sessions = [
            session
            for session in sessions_by_user_id.get(user_id, [])
            if str(session.get('location')) in SUPPORTED_LOCATIONS
        ]
        if not user_sessions:
            continue
        location_counter = Counter(str(session['location']) for session in user_sessions)
        weekday_counter = Counter(
            datetime.fromtimestamp(int(session['date']) / 1000, tz=UTC).strftime('%A')
            for session in user_sessions
        )
        hour_counter = Counter(
            datetime.fromtimestamp(int(session['date']) / 1000, tz=UTC).hour
            for session in user_sessions
        )
        favorite_weekday = weekday_counter.most_common(1)[0][0]
        favorite_location = location_counter.most_common(1)[0][0]
        favorite_hour = hour_counter.most_common(1)[0][0]
        engagement = len(user_sessions)
        user_patterns[user_id] = {
            'favorite_weekday': favorite_weekday,
            'favorite_location': favorite_location,
            'favorite_hour': favorite_hour,
            'engagement': engagement,
        }
        for session in user_sessions:
            session_dt = datetime.fromtimestamp(int(session['date']) / 1000, tz=UTC)
            weekday = session_dt.strftime('%A')
            location_by_weekday[weekday][str(session['location'])] += 1
            hour_by_weekday[weekday][session_dt.hour] += 1

    return user_patterns, location_by_weekday, hour_by_weekday


def choose_location_and_hour(
    weekday: str,
    location_by_weekday: dict[str, Counter[str]],
    hour_by_weekday: dict[str, Counter[int]],
    rng: random.Random,
) -> tuple[str, int]:
    location_choices = [
        (location, count)
        for location, count in location_by_weekday[weekday].most_common()
        if location in SUPPORTED_LOCATIONS
    ][:3]
    hour_choices = hour_by_weekday[weekday].most_common(5)
    locations = [location for location, _ in location_choices] or ['antrebloc']
    hours = [hour for hour, _ in hour_choices] or [18]
    return rng.choice(locations), rng.choice(hours)


def choose_participants(
    session_dt: datetime,
    location: str,
    user_patterns: dict[str, dict[str, Any]],
    rng: random.Random,
    target_size: int,
) -> list[str]:
    weekday = session_dt.strftime('%A')
    scored_users: list[tuple[float, str]] = []
    for user_id, pattern in user_patterns.items():
        score = 1.0 + min(pattern['engagement'], 40) * 0.15
        if pattern['favorite_weekday'] == weekday:
            score += 4.0
        if pattern['favorite_location'] == location:
            score += 5.0
        score += max(0.0, 2.0 - abs(pattern['favorite_hour'] - session_dt.hour) * 0.4)
        scored_users.append((score, user_id))

    participants: list[str] = []
    pool = scored_users[:]
    while pool and len(participants) < target_size:
        total_score = sum(score for score, _ in pool)
        pick = rng.uniform(0, total_score)
        cumulative = 0.0
        selected_index = len(pool) - 1
        for index, (score, _) in enumerate(pool):
            cumulative += score
            if pick <= cumulative:
                selected_index = index
                break
        _, user_id = pool.pop(selected_index)
        participants.append(user_id)
    return participants


def generate_sessions_payload(
    users: list[dict[str, Any]],
    sessions: list[dict[str, Any]],
    session_count: int,
) -> list[dict[str, Any]]:
    user_patterns, location_by_weekday, hour_by_weekday = build_user_patterns(users, sessions)
    next_week_dates = get_next_week_dates(datetime.now(tz=UTC).date())
    rng = random.Random('esc-future-sessions')
    generated: list[dict[str, Any]] = []
    used_ids: set[str] = set()

    weekday_order = [next_week_dates[index % len(next_week_dates)] for index in range(session_count)]
    for target_date in weekday_order:
        weekday = target_date.strftime('%A')
        location, hour = choose_location_and_hour(weekday, location_by_weekday, hour_by_weekday, rng)
        minute = rng.choice([0, 30])
        session_dt = datetime.combine(target_date, time(hour=hour, minute=minute), tzinfo=UTC)
        session_id = date_to_discord_snowflake(session_dt)
        while session_id in used_ids:
            session_dt += timedelta(minutes=90)
            session_id = date_to_discord_snowflake(session_dt)
        target_size = rng.randint(4, 8)
        participants = choose_participants(session_dt, location, user_patterns, rng, target_size)
        used_ids.add(session_id)
        generated.append(
            {
                'id': session_id,
                'date': session_dt,
                'location': location,
                'participants': participants,
            }
        )
    return generated


def write_sessions(region: str, table_name: str, generated_sessions: list[dict[str, Any]]) -> None:
    table = boto3.resource('dynamodb', region_name=region).Table(table_name)
    with table.batch_writer(overwrite_by_pkeys=['id', 'sortId']) as batch:
        for session in generated_sessions:
            expiration = session['date'] + timedelta(days=1)
            expiration = expiration.replace(hour=0, minute=0, second=0, microsecond=0)
            batch.put_item(
                Item={
                    'id': session['id'],
                    'sortId': session['id'],
                    'date': int(session['date'].timestamp() * 1000),
                    'location': session['location'],
                    'expiresAt': int(expiration.timestamp() * 1000),
                    'isExpired': False,
                }
            )
            for participant in session['participants']:
                batch.put_item(
                    Item={
                        'id': session['id'],
                        'sortId': participant,
                    }
                )


def parse_channel_overrides(raw_overrides: list[str]) -> dict[str, str]:
    overrides: dict[str, str] = {}
    for raw_override in raw_overrides:
        location, separator, channel_id = raw_override.partition('=')
        if separator == '' or not location or not channel_id:
            raise ValueError(f'Invalid --channel mapping: {raw_override}. Expected location=channel_id')
        overrides[location.strip()] = channel_id.strip()
    return overrides


def resolve_channel_mapping(channel_overrides: list[str]) -> dict[str, str]:
    channels = {
        location: os.environ[env_name]
        for location, env_name in ENV_CHANNELS.items()
        if os.environ.get(env_name)
    }
    channels.update(parse_channel_overrides(channel_overrides))
    return channels


def resolve_discord_bot_token(
    region: str,
    direct_token: str | None,
    secret_id: str | None,
) -> str:
    if direct_token:
        return direct_token
    env_token = os.environ.get('DISCORD_BOT_TOKEN')
    if env_token:
        return env_token
    if not secret_id:
        raise ValueError(
            'Missing Discord bot token. '
            'Set DISCORD_BOT_TOKEN, pass --discord-bot-token, or provide --discord-secret-id.'
        )
    secret_payload = fetch_secret_json(secret_id, region)
    token = secret_payload.get('DISCORD_BOT_TOKEN')
    if not token:
        raise ValueError(f'Secret {secret_id} does not contain DISCORD_BOT_TOKEN')
    return str(token)


def format_session_title(session_dt: datetime) -> str:
    return (
        f"{FRENCH_WEEKDAYS[session_dt.weekday()]} "
        f"{session_dt.day} "
        f"{FRENCH_MONTHS[session_dt.month - 1]} "
        f"{session_dt.year} a {session_dt.hour:02d}:{session_dt.minute:02d}"
    )


def format_location_label(location: str) -> str:
    return ' '.join(part.capitalize() for part in location.split('-'))


def format_participant_lines(participant_ids: list[str], users_by_id: dict[str, dict[str, Any]]) -> str:
    participant_names = []
    for participant_id in participant_ids:
        user = users_by_id.get(participant_id)
        if user:
            participant_names.append(f"- {user['firstName']} {user['lastName']}".strip())
        else:
            participant_names.append(f'- {participant_id}')
    return '\n'.join(participant_names) if participant_names else '- Aucun participant'


def build_session_message_payload(
    session: dict[str, Any],
    users_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    participant_ids = [str(participant_id) for participant_id in session['participants']]
    return {
        'embeds': [
            {
                'title': format_session_title(session['date']),
                'description': f"Seance de grimpe a **{format_location_label(session['location'])}**.",
                'fields': [
                    {
                        'name': 'Participants :',
                        'value': format_participant_lines(participant_ids, users_by_id),
                        'inline': False,
                    }
                ],
                'color': 15844367,
            }
        ],
        'components': [
            {
                'type': 1,
                'components': [
                    {
                        'type': 2,
                        'style': 1,
                        'label': 'Rejoindre',
                        'custom_id': 'register',
                    },
                    {
                        'type': 2,
                        'style': 4,
                        'label': 'Se desinscrire',
                        'custom_id': 'leave',
                    },
                ],
            }
        ],
    }


def post_message_to_discord(
    api_base_url: str,
    bot_token: str,
    channel_id: str,
    message_payload: dict[str, Any],
) -> dict[str, Any]:
    for attempt in range(DEFAULT_DISCORD_MAX_RETRIES):
        req = request.Request(
            f'{api_base_url}/channels/{channel_id}/messages',
            data=json.dumps(message_payload).encode('utf-8'),
            headers={
                'Authorization': f'Bot {bot_token}',
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': DISCORD_HTTP_USER_AGENT,
            },
            method='POST',
        )
        try:
            with request.urlopen(req) as response:
                return json.loads(response.read().decode('utf-8'))
        except error.HTTPError as exc:
            body = exc.read().decode('utf-8', errors='replace')
            if exc.code == 429:
                response_payload = json.loads(body)
                retry_after = float(response_payload.get('retry_after', 1.0))
                time_module.sleep(retry_after)
                continue
            raise RuntimeError(f'Discord API request failed for channel {channel_id}: {exc.code} {body}') from exc
    raise RuntimeError(
        f'Discord API request failed for channel {channel_id}: exceeded retry budget after rate limiting'
    )


def post_sessions_to_discord(
    generated_sessions: list[dict[str, Any]],
    users: list[dict[str, Any]],
    channels_by_location: dict[str, str],
    bot_token: str,
    api_base_url: str,
) -> None:
    users_by_id = {str(user['id']): user for user in users}
    for session in generated_sessions:
        channel_id = channels_by_location.get(str(session['location']))
        if not channel_id:
            raise ValueError(
                f"No Discord channel configured for location {session['location']}. "
                'Set the matching env var or pass --channel location=channel_id.'
            )
        response = post_message_to_discord(
            api_base_url=api_base_url,
            bot_token=bot_token,
            channel_id=channel_id,
            message_payload=build_session_message_payload(session, users_by_id),
        )
        session['seededChannelId'] = channel_id
        session['seededMessageId'] = response['id']
        session['id'] = str(response['id'])


def to_session_rows(generated_sessions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for session in generated_sessions:
        rows.append(
            {
                'id': session['id'],
                'sortId': session['id'],
                'date': int(session['date'].timestamp() * 1000),
                'location': session['location'],
            }
        )
        rows.extend({'id': session['id'], 'sortId': participant_id} for participant_id in session['participants'])
    return rows


def update_algolia_sessions(
    region: str,
    secret_path: str,
    index_name: str,
    users: list[dict[str, Any]],
    generated_sessions: list[dict[str, Any]],
) -> None:
    records = build_session_records(users, to_session_rows(generated_sessions), datetime.now(tz=UTC))
    app_id, api_key = load_algolia_credentials(secret_path, region)
    batch_index(app_id, api_key, index_name, records)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Generate future sessions for the next week based on existing patterns',
    )
    parser.add_argument('--region', default=DEFAULT_REGION)
    parser.add_argument('--users-table', default=DEFAULT_USERS_TABLE)
    parser.add_argument('--sessions-table', default=DEFAULT_SESSIONS_TABLE)
    parser.add_argument('--cache-dir', default=DEFAULT_CACHE_DIR)
    parser.add_argument('--session-count', type=int, default=10)
    parser.add_argument(
        '--refresh-cache',
        action='store_true',
        help='Ignore any existing cache snapshot, rescan DynamoDB, and rewrite the local cache files.',
    )
    parser.add_argument(
        '--no-cache',
        action='store_true',
        help='Bypass cache reads and writes for this run and read users/sessions directly from DynamoDB.',
    )
    parser.add_argument(
        '--post-to-discord',
        action='store_true',
        help='Create real Discord messages in the target channels before writing the seeded sessions to DynamoDB.',
    )
    parser.add_argument(
        '--update-algolia',
        action='store_true',
        help='Upsert the generated sessions into the Algolia sessions index after DynamoDB has been updated.',
    )
    parser.add_argument(
        '--algolia-secret-path',
        default=os.environ.get('ALGOLIA_SECRET_PATH', DEFAULT_ALGOLIA_SECRET_PATH),
        help='Secrets Manager path containing ALGOLIA_APP_ID and ALGOLIA_ADMIN_API_KEY.',
    )
    parser.add_argument(
        '--algolia-index',
        default=os.environ.get('ALGOLIA_SESSIONS_INDEX', DEFAULT_ALGOLIA_INDEX),
        help='Algolia sessions index name.',
    )
    parser.add_argument(
        '--discord-bot-token',
        default=None,
        help='Discord bot token. If omitted, the script uses DISCORD_BOT_TOKEN or fetches it from Secrets Manager.',
    )
    parser.add_argument(
        '--discord-secret-id',
        default=DEFAULT_DISCORD_SECRET_ID,
        help='Secrets Manager secret containing DISCORD_BOT_TOKEN.',
    )
    parser.add_argument(
        '--discord-api-base-url',
        default=DEFAULT_DISCORD_API_BASE_URL,
        help='Discord API base URL, mainly useful for tests.',
    )
    parser.add_argument(
        '--channel',
        action='append',
        default=[],
        help='Discord channel mapping as location=channel_id. Repeat the flag for multiple locations.',
    )
    return parser.parse_args()


def main() -> int:
    load_local_env()
    args = parse_args()
    users, sessions = load_or_fetch_cache(
        args.region,
        args.users_table,
        args.sessions_table,
        Path(args.cache_dir),
        refresh_cache=args.refresh_cache,
        use_cache=not args.no_cache,
    )
    generated_sessions = generate_sessions_payload(users, sessions, args.session_count)

    if args.post_to_discord:
        bot_token = resolve_discord_bot_token(args.region, args.discord_bot_token, args.discord_secret_id)
        channels_by_location = resolve_channel_mapping(args.channel)
        post_sessions_to_discord(
            generated_sessions=generated_sessions,
            users=users,
            channels_by_location=channels_by_location,
            bot_token=bot_token,
            api_base_url=args.discord_api_base_url,
        )

    write_sessions(args.region, args.sessions_table, generated_sessions)
    if args.update_algolia:
        update_algolia_sessions(
            region=args.region,
            secret_path=args.algolia_secret_path,
            index_name=args.algolia_index,
            users=users,
            generated_sessions=generated_sessions,
        )
    print(
        json.dumps(
            [
                {
                    'id': session['id'],
                    'date': session['date'].isoformat(),
                    'location': session['location'],
                    'participantCount': len(session['participants']),
                    'seededChannelId': session.get('seededChannelId'),
                    'seededMessageId': session.get('seededMessageId'),
                }
                for session in generated_sessions
            ],
            indent=2,
        )
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
