#!/usr/bin/env python3

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import boto3

DEFAULT_REGION = 'eu-west-3'
DEFAULT_USERS_TABLE = 'Efrei-Sport-Climbing-App.users'
DEFAULT_SESSIONS_TABLE = 'Efrei-Sport-Climbing-App.sessions'
DEFAULT_ALGOLIA_INDEX = 'esc_sessions'


def require_env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name) or default
    if not value:
        raise RuntimeError(f'Missing environment variable: {name}')
    return value


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


def load_algolia_credentials(secret_path: str, region: str) -> tuple[str, str]:
    client = boto3.client('secretsmanager', region_name=region)
    response = client.get_secret_value(SecretId=secret_path)
    secret = json.loads(response['SecretString'])
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


def get_activity_level(participant_count: int) -> str:
    if participant_count >= 12:
        return 'very_popular'
    if participant_count >= 6:
        return 'popular'
    return 'small'


def get_tags(location: str, is_upcoming: bool, date: datetime, participant_count: int) -> list[str]:
    tags = {location, get_activity_level(participant_count)}
    tags.add('upcoming' if is_upcoming else 'expired')
    if date.weekday() >= 5:
        tags.add('weekend')
    elif date.hour >= 17:
        tags.add('weekday-evening')
    return sorted(tags)


def choose_counter_key(counter: Counter[str]) -> str | None:
    if not counter:
        return None
    max_count = max(counter.values())
    candidates = sorted(key for key, count in counter.items() if count == max_count)
    return candidates[0] if candidates else None


def build_co_attendance_counts(participant_ids_by_session_id: dict[str, list[str]]) -> dict[tuple[str, str], int]:
    co_attendance_counts: dict[tuple[str, str], int] = defaultdict(int)
    for participant_ids in participant_ids_by_session_id.values():
        sorted_ids = sorted(set(participant_ids))
        for index, left_user_id in enumerate(sorted_ids):
            for right_user_id in sorted_ids[index + 1 :]:
                co_attendance_counts[(left_user_id, right_user_id)] += 1
    return dict(co_attendance_counts)


def get_pair_count(co_attendance_counts: dict[tuple[str, str], int], left_user_id: str, right_user_id: str) -> int:
    key = (left_user_id, right_user_id) if left_user_id <= right_user_id else (right_user_id, left_user_id)
    return co_attendance_counts.get(key, 0)


def build_repeat_participants(
    participant_ids: list[str],
    participants: list[dict[str, Any]],
    co_attendance_counts: dict[tuple[str, str], int],
) -> tuple[list[str], list[str], list[str]]:
    repeat_scores: dict[str, int] = {}
    participants_by_id = {str(participant['id']): participant for participant in participants}

    for user_id in participant_ids:
        score = 0
        for other_user_id in participant_ids:
            if user_id == other_user_id:
                continue
            pair_count = get_pair_count(co_attendance_counts, user_id, other_user_id)
            if pair_count >= 2:
                score += pair_count - 1
        repeat_scores[user_id] = score

    sorted_repeat_user_ids = [
        user_id
        for user_id, score in sorted(
            repeat_scores.items(),
            key=lambda item: (-item[1], participants_by_id.get(item[0], {}).get('firstName', ''), item[0]),
        )
        if score > 0
    ]
    repeat_participant_ids = sorted_repeat_user_ids[:5]
    repeat_participant_names = [
        f"{participants_by_id[user_id]['firstName']} {participants_by_id[user_id]['lastName']}".strip()
        for user_id in repeat_participant_ids
        if user_id in participants_by_id
    ]
    participant_preview_ids = sorted(
        participant_ids,
        key=lambda user_id: (
            -repeat_scores.get(user_id, 0),
            participants_by_id.get(user_id, {}).get('firstName', ''),
            user_id,
        ),
    )[:4]
    participant_preview = [
        f"{participants_by_id[user_id]['firstName']} {participants_by_id[user_id]['lastName']}".strip()
        for user_id in participant_preview_ids
        if user_id in participants_by_id
    ]
    return repeat_participant_ids, repeat_participant_names, participant_preview


def build_similarity_tags(
    location: str,
    date: datetime,
    participant_count: int,
    dominant_promo: str | None,
    repeat_participant_count: int,
) -> list[str]:
    similarity_tags: set[str] = set()
    if date.weekday() >= 5:
        similarity_tags.add('weekend')
    elif date.hour >= 17:
        similarity_tags.add('afterwork')
    if participant_count >= 6:
        similarity_tags.add(f'popular-{location}')
    if dominant_promo:
        similarity_tags.add(f'promo-{dominant_promo}')
    if repeat_participant_count > 0:
        similarity_tags.add('regular-group')
    return sorted(similarity_tags)


def build_session_records(
    users: list[dict[str, Any]],
    sessions: list[dict[str, Any]],
    now: datetime,
) -> list[dict[str, Any]]:
    users_by_id = {str(user['id']): user for user in users}
    session_rows = {str(row['id']): row for row in sessions if row.get('id') == row.get('sortId')}
    participant_ids_by_session_id: dict[str, list[str]] = defaultdict(list)

    for row in sessions:
        if row.get('id') == row.get('sortId'):
            continue
        participant_ids_by_session_id[str(row['id'])].append(str(row['sortId']))
    co_attendance_counts = build_co_attendance_counts(participant_ids_by_session_id)

    records: list[dict[str, Any]] = []
    for session_id, session_row in session_rows.items():
        participant_ids = participant_ids_by_session_id.get(session_id, [])
        participants = [users_by_id[user_id] for user_id in participant_ids if user_id in users_by_id]
        participant_names = [
            f"{participant['firstName']} {participant['lastName']}".strip()
            for participant in participants
        ]
        promo_counter = Counter(str(participant['promo']) for participant in participants if participant.get('promo'))
        participant_promos = sorted(promo_counter.keys())
        timestamp = int(session_row['date'])
        date = datetime.fromtimestamp(timestamp / 1000, tz=UTC)
        is_upcoming = date >= now
        participant_count = len(participant_ids)
        dominant_promo = choose_counter_key(promo_counter)
        favorite_participant_promos = [
            promo for promo, _ in sorted(promo_counter.items(), key=lambda item: (-item[1], item[0]))[:3]
        ]
        repeat_participant_ids, repeat_participant_names, participant_preview = build_repeat_participants(
            participant_ids,
            participants,
            co_attendance_counts,
        )
        records.append(
            {
                'objectID': session_id,
                'id': session_id,
                'date': date.isoformat(),
                'timestamp': timestamp,
                'location': str(session_row['location']),
                'isExpired': not is_upcoming,
                'isUpcoming': is_upcoming,
                'participantCount': participant_count,
                'participantIds': participant_ids,
                'participantNames': participant_names,
                'participantPromos': participant_promos,
                'weekday': date.strftime('%A').lower(),
                'hour': date.hour,
                'month': date.strftime('%B').lower(),
                'activityLevel': get_activity_level(participant_count),
                'favoriteParticipantPromos': favorite_participant_promos,
                'participantPreview': participant_preview,
                'repeatParticipantIds': repeat_participant_ids,
                'repeatParticipantNames': repeat_participant_names,
                'dominantPromo': dominant_promo,
                'similarityTags': build_similarity_tags(
                    str(session_row['location']),
                    date,
                    participant_count,
                    dominant_promo,
                    len(repeat_participant_ids),
                ),
                'tags': get_tags(str(session_row['location']), is_upcoming, date, participant_count),
            }
        )

    return sorted(records, key=lambda record: record['timestamp'])


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


def browse_algolia_object_ids(app_id: str, api_key: str, index_name: str) -> set[str]:
    object_ids: set[str] = set()
    cursor: str | None = None

    while True:
        url = f'https://{app_id}-dsn.algolia.net/1/indexes/{index_name}/browse'
        payload: dict[str, Any]
        if cursor:
            payload = {'cursor': cursor}
        else:
            payload = {'attributesToRetrieve': ['objectID']}

        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode('utf-8'),
            headers={
                'Content-Type': 'application/json',
                'X-Algolia-Application-Id': app_id,
                'X-Algolia-API-Key': api_key,
            },
            method='POST',
        )

        try:
            with urllib.request.urlopen(request) as response:
                body = json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as error:
            raise RuntimeError(error.read().decode('utf-8')) from error

        for hit in body.get('hits', []):
            object_id = hit.get('objectID')
            if object_id:
                object_ids.add(str(object_id))

        cursor = body.get('cursor')
        if not cursor:
            break

    return object_ids


def batch_delete(app_id: str, api_key: str, index_name: str, object_ids: list[str]) -> None:
    if not object_ids:
        return

    url = f'https://{app_id}-dsn.algolia.net/1/indexes/{index_name}/batch'
    operations = [{'action': 'deleteObject', 'body': {'objectID': object_id}} for object_id in object_ids]
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Backfill Algolia sessions index from DynamoDB.')
    parser.add_argument(
        '--reconcile',
        action='store_true',
        help='Delete Algolia objects that are not present in DynamoDB after backfilling.',
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    region = require_env('AWS_REGION', DEFAULT_REGION)
    users_table = require_env('USERS_TABLE', DEFAULT_USERS_TABLE)
    sessions_table = require_env('SESSIONS_TABLE', DEFAULT_SESSIONS_TABLE)
    secret_path = require_env('ALGOLIA_SECRET_PATH')
    index_name = require_env('ALGOLIA_SESSIONS_INDEX', DEFAULT_ALGOLIA_INDEX)

    app_id, api_key = load_algolia_credentials(secret_path, region)
    users = scan_table(users_table, region)
    sessions = scan_table(sessions_table, region)
    records = build_session_records(users, sessions, datetime.now(tz=UTC))

    if not records:
        print('No sessions found to index.')
        return 0

    for start in range(0, len(records), 500):
        batch_index(app_id, api_key, index_name, records[start : start + 500])

    print(f'Indexed {len(records)} sessions into Algolia index {index_name}.')

    if args.reconcile:
        dynamodb_object_ids = {str(record['objectID']) for record in records}
        algolia_object_ids = browse_algolia_object_ids(app_id, api_key, index_name)
        orphan_object_ids = sorted(algolia_object_ids - dynamodb_object_ids)

        for start in range(0, len(orphan_object_ids), 500):
            batch_delete(app_id, api_key, index_name, orphan_object_ids[start : start + 500])

        print(f"Deleted {len(orphan_object_ids)} orphaned Algolia objects from index {index_name}.")

    return 0


if __name__ == '__main__':
    sys.exit(main())
