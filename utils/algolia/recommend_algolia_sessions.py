#!/usr/bin/env python3

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from typing import Any

import boto3

DEFAULT_REGION = 'eu-west-3'
DEFAULT_USERS_TABLE = 'Efrei-Sport-Climbing-App.users'
DEFAULT_USER_STATS_TABLE = 'Efrei-Sport-Climbing-App.user-stats'
DEFAULT_ALGOLIA_INDEX = 'esc_sessions_by_date_asc'


def require_env_or_arg(value: str | None, name: str, default: str | None = None) -> str:
    resolved = value or os.environ.get(name) or default
    if not resolved:
        raise RuntimeError(f'Missing configuration value for {name}')
    return resolved


def load_algolia_credentials(secret_path: str, region: str) -> tuple[str, str]:
    client = boto3.client('secretsmanager', region_name=region)
    response = client.get_secret_value(SecretId=secret_path)
    secret = json.loads(response['SecretString'])
    return secret['ALGOLIA_APP_ID'], secret['ALGOLIA_ADMIN_API_KEY']


def load_user(table_name: str, user_id: str, region: str) -> dict[str, Any]:
    table = boto3.resource('dynamodb', region_name=region).Table(table_name)
    response = table.get_item(Key={'id': user_id})
    return response.get('Item', {})


def load_user_stats(table_name: str, user_id: str, region: str) -> dict[str, Any]:
    table = boto3.resource('dynamodb', region_name=region).Table(table_name)
    response = table.get_item(Key={'userId': user_id})
    return response.get('Item', {})


def build_recommendation_filters(user_stats: dict[str, Any]) -> list[str]:
    favorite_location = user_stats.get('favoriteLocation')
    preferred_day_of_week = user_stats.get('preferredDayOfWeek')
    filters = []
    if favorite_location and preferred_day_of_week:
        filters.append(f'isUpcoming:true AND location:"{favorite_location}" AND weekday:"{preferred_day_of_week}"')
    if favorite_location:
        filters.append(f'isUpcoming:true AND location:"{favorite_location}"')
    if preferred_day_of_week:
        filters.append(f'isUpcoming:true AND weekday:"{preferred_day_of_week}"')
    filters.append('isUpcoming:true')
    return filters


def search_algolia_index(
    app_id: str,
    api_key: str,
    index_name: str,
    filters: str,
    hits_per_page: int,
) -> list[dict[str, Any]]:
    url = f'https://{app_id}-dsn.algolia.net/1/indexes/{urllib.parse.quote(index_name)}/query'
    payload = json.dumps(
        {
            'query': '',
            'filters': filters,
            'hitsPerPage': hits_per_page,
        }
    ).encode('utf-8')
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
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode('utf-8')).get('hits', [])


def score_recommendation(
    user: dict[str, Any],
    user_stats: dict[str, Any],
    session: dict[str, Any],
) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []
    favorite_location = user_stats.get('favoriteLocation')
    preferred_day_of_week = user_stats.get('preferredDayOfWeek')
    activity_status = user_stats.get('activityStatus')
    promo = str(user.get('promo') or '')

    if favorite_location and session.get('location') == favorite_location:
        score += 50
        reasons.append('favorite_location')
    if preferred_day_of_week and session.get('weekday') == preferred_day_of_week:
        score += 35
        reasons.append('preferred_day')
    if promo and promo in session.get('participantPromos', []):
        score += 15
        reasons.append('promo_overlap')
    if session.get('repeatParticipantIds'):
        score += 10
        reasons.append('regular_group')
    if activity_status == 'power_user' and session.get('activityLevel') in {'popular', 'very_popular'}:
        score += 8
        reasons.append('high_energy_match')
    if activity_status in {'new', 'inactive'} and session.get('activityLevel') == 'small':
        score += 4
        reasons.append('easy_join')
    score += min(int(session.get('participantCount', 0)), 12)
    return score, reasons


def recommend_sessions(
    user: dict[str, Any],
    user_stats: dict[str, Any],
    search_results_by_filter: list[tuple[str, list[dict[str, Any]]]],
    limit: int,
) -> list[dict[str, Any]]:
    scored_sessions: dict[str, dict[str, Any]] = {}
    for filter_name, sessions in search_results_by_filter:
        for session in sessions:
            session_id = str(session['objectID'])
            score, reasons = score_recommendation(user, user_stats, session)
            session_record = {
                'session': session,
                'score': score,
                'reasons': sorted(set(reasons + [filter_name])),
            }
            if session_id not in scored_sessions or score > scored_sessions[session_id]['score']:
                scored_sessions[session_id] = session_record

    recommendations = sorted(
        scored_sessions.values(),
        key=lambda item: (-item['score'], int(item['session'].get('timestamp', 0))),
    )
    return recommendations[:limit]


def format_recommendation_output(recommendations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    formatted: list[dict[str, Any]] = []
    for recommendation in recommendations:
        session = recommendation['session']
        formatted.append(
            {
                'score': recommendation['score'],
                'reasons': recommendation['reasons'],
                'session': {
                    'id': session['objectID'],
                    'date': session['date'],
                    'location': session['location'],
                    'weekday': session['weekday'],
                    'hour': session['hour'],
                    'participantCount': session['participantCount'],
                    'activityLevel': session['activityLevel'],
                    'participantPreview': session.get('participantPreview', []),
                    'repeatParticipantNames': session.get('repeatParticipantNames', []),
                    'dominantPromo': session.get('dominantPromo'),
                    'similarityTags': session.get('similarityTags', []),
                },
            }
        )
    return formatted


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Recommend upcoming Algolia sessions for one user.')
    parser.add_argument('user_id', help='Discord user ID present in UsersTable')
    parser.add_argument('--region', default=None)
    parser.add_argument('--users-table', default=None)
    parser.add_argument('--user-stats-table', default=None)
    parser.add_argument('--algolia-index', default=None)
    parser.add_argument('--algolia-secret-path', default=None)
    parser.add_argument('--limit', type=int, default=10)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    region = require_env_or_arg(args.region, 'AWS_REGION', DEFAULT_REGION)
    users_table = require_env_or_arg(args.users_table, 'USERS_TABLE', DEFAULT_USERS_TABLE)
    user_stats_table = require_env_or_arg(args.user_stats_table, 'USER_STATS_TABLE', DEFAULT_USER_STATS_TABLE)
    algolia_index = require_env_or_arg(args.algolia_index, 'ALGOLIA_SESSIONS_INDEX', DEFAULT_ALGOLIA_INDEX)
    secret_path = require_env_or_arg(args.algolia_secret_path, 'ALGOLIA_SECRET_PATH')

    user = load_user(users_table, args.user_id, region)
    if not user:
        raise RuntimeError(f'User {args.user_id} not found in {users_table}')

    user_stats = load_user_stats(user_stats_table, args.user_id, region)
    if not user_stats:
        raise RuntimeError(f'User stats {args.user_id} not found in {user_stats_table}')

    app_id, api_key = load_algolia_credentials(secret_path, region)
    filters = build_recommendation_filters(user_stats)
    search_results_by_filter = [
        (filter_name, search_algolia_index(app_id, api_key, algolia_index, filter_name, args.limit))
        for filter_name in filters
    ]

    recommendations = recommend_sessions(user, user_stats, search_results_by_filter, args.limit)
    print(json.dumps(format_recommendation_output(recommendations), indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
