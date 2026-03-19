import os
import random
from collections import Counter
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from urllib import error, request

import pytest

from utils.sessions.generate_future_sessions import (
    build_session_message_payload,
    build_user_patterns,
    choose_location_and_hour,
    format_session_title,
    load_dotenv_file,
    load_or_fetch_cache,
    parse_channel_overrides,
    post_message_to_discord,
    resolve_channel_mapping,
    resolve_discord_bot_token,
    to_session_rows,
)


def test_format_session_title_uses_expected_french_layout():
    session_dt = datetime(2026, 3, 17, 18, 30, tzinfo=UTC)

    assert format_session_title(session_dt) == 'mardi 17 mars 2026 a 18:30'


def test_build_session_message_payload_lists_known_participants():
    session = {
        'date': datetime(2026, 3, 17, 18, 30, tzinfo=UTC),
        'location': 'climb-up',
        'participants': ['user-1', 'user-2'],
    }
    users_by_id = {
        'user-1': {'firstName': 'Paul', 'lastName': 'Mairesse'},
        'user-2': {'firstName': 'Alice', 'lastName': 'Martin'},
    }

    payload = build_session_message_payload(session, users_by_id)

    assert payload['embeds'][0]['title'] == 'mardi 17 mars 2026 a 18:30'
    assert payload['embeds'][0]['description'] == 'Seance de grimpe a **Climb Up**.'
    assert payload['embeds'][0]['fields'][0]['value'] == '- Paul Mairesse\n- Alice Martin'
    assert payload['components'][0]['components'][0]['custom_id'] == 'register'
    assert payload['components'][0]['components'][1]['custom_id'] == 'leave'


def test_parse_channel_overrides_rejects_invalid_items():
    with pytest.raises(ValueError, match='Invalid --channel mapping'):
        parse_channel_overrides(['antrebloc'])


def test_resolve_channel_mapping_merges_environment_and_overrides(monkeypatch):
    monkeypatch.setenv('ANTREBLOC_CHANNEL', 'env-antrebloc')
    monkeypatch.setenv('CLIMBUP_CHANNEL', 'env-climb-up')

    channels = resolve_channel_mapping(['climb-up=override-climb-up', 'climb-up-bordeaux=override-bdx'])

    assert channels == {
        'antrebloc': 'env-antrebloc',
        'climb-up': 'override-climb-up',
        'climb-up-bordeaux': 'override-bdx',
    }


def test_resolve_discord_bot_token_prefers_direct_value(monkeypatch):
    monkeypatch.setenv('DISCORD_BOT_TOKEN', 'env-token')

    token = resolve_discord_bot_token('eu-west-3', 'direct-token', DEFAULT_SECRET_ID_FOR_TEST)

    assert token == 'direct-token'


def test_load_dotenv_file_sets_missing_values_only(tmp_path: Path, monkeypatch):
    dotenv_path = tmp_path / '.env.local'
    dotenv_path.write_text("ANTREBLOC_CHANNEL=123\nCLIMBUP_CHANNEL='456'\n")
    monkeypatch.delenv('ANTREBLOC_CHANNEL', raising=False)
    monkeypatch.setenv('CLIMBUP_CHANNEL', 'existing')

    load_dotenv_file(dotenv_path)

    assert os.environ['ANTREBLOC_CHANNEL'] == '123'
    assert os.environ['CLIMBUP_CHANNEL'] == 'existing'


def test_load_or_fetch_cache_reads_existing_snapshot(tmp_path: Path, monkeypatch):
    cache_dir = tmp_path / 'cache'
    cache_dir.mkdir()
    (cache_dir / 'users.json').write_text('[{"id":"cached-user"}]')
    (cache_dir / 'sessions.json').write_text('[{"id":"cached-session"}]')

    def fail_scan(*_args, **_kwargs):
        raise AssertionError('scan_table should not be called when cache is valid')

    monkeypatch.setattr('utils.sessions.generate_future_sessions.scan_table', fail_scan)

    users, sessions = load_or_fetch_cache('eu-west-3', 'users-table', 'sessions-table', cache_dir)

    assert users == [{'id': 'cached-user'}]
    assert sessions == [{'id': 'cached-session'}]


def test_load_or_fetch_cache_refreshes_and_rewrites_snapshot(tmp_path: Path, monkeypatch):
    cache_dir = tmp_path / 'cache'
    cache_dir.mkdir()
    (cache_dir / 'users.json').write_text('[{"id":"stale-user"}]')
    (cache_dir / 'sessions.json').write_text('[{"id":"stale-session"}]')
    responses = {
        'users-table': [{'id': 'fresh-user'}],
        'sessions-table': [{'id': 'fresh-session'}],
    }

    def fake_scan(table_name, _region):
        return responses[table_name]

    monkeypatch.setattr('utils.sessions.generate_future_sessions.scan_table', fake_scan)

    users, sessions = load_or_fetch_cache(
        'eu-west-3',
        'users-table',
        'sessions-table',
        cache_dir,
        refresh_cache=True,
    )

    assert users == [{'id': 'fresh-user'}]
    assert sessions == [{'id': 'fresh-session'}]
    assert (cache_dir / 'users.json').read_text() == '[\n  {\n    "id": "fresh-user"\n  }\n]'
    assert (cache_dir / 'sessions.json').read_text() == '[\n  {\n    "id": "fresh-session"\n  }\n]'


def test_load_or_fetch_cache_can_bypass_cache_reads_and_writes(tmp_path: Path, monkeypatch):
    cache_dir = tmp_path / 'cache'
    responses = {
        'users-table': [{'id': 'live-user'}],
        'sessions-table': [{'id': 'live-session'}],
    }

    def fake_scan(table_name, _region):
        return responses[table_name]

    monkeypatch.setattr('utils.sessions.generate_future_sessions.scan_table', fake_scan)

    users, sessions = load_or_fetch_cache(
        'eu-west-3',
        'users-table',
        'sessions-table',
        cache_dir,
        use_cache=False,
    )

    assert users == [{'id': 'live-user'}]
    assert sessions == [{'id': 'live-session'}]
    assert not cache_dir.exists()


def test_deprecated_locations_are_ignored_in_generation_patterns():
    users = [{'id': 'user-1'}]
    sessions = [
        {'id': 'session-1', 'sortId': 'session-1', 'date': 1773446400000, 'location': 'vertical-art'},
        {'id': 'session-1', 'sortId': 'user-1'},
        {'id': 'session-2', 'sortId': 'session-2', 'date': 1773532800000, 'location': 'climb-up'},
        {'id': 'session-2', 'sortId': 'user-1'},
    ]

    user_patterns, location_by_weekday, _hour_by_weekday = build_user_patterns(users, sessions)

    assert user_patterns['user-1']['favorite_location'] == 'climb-up'
    assert 'vertical-art' not in location_by_weekday['Thursday']


def test_choose_location_and_hour_skips_deprecated_locations():
    location_by_weekday = {'Monday': Counter({'vertical-art': 5, 'arkose': 4, 'climb-up': 3})}
    hour_by_weekday = {'Monday': Counter({18: 3})}

    location, hour = choose_location_and_hour('Monday', location_by_weekday, hour_by_weekday, random.Random(0))

    assert location == 'climb-up'
    assert hour == 18


def test_post_message_to_discord_retries_after_rate_limit(monkeypatch):
    calls = {'count': 0}
    sleeps: list[float] = []

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return b'{"id":"message-1"}'

    def fake_urlopen(_request):
        calls['count'] += 1
        if calls['count'] == 1:
            raise error.HTTPError(
                url='https://discord.com/api/v10/channels/1/messages',
                code=429,
                msg='Too Many Requests',
                hdrs=None,
                fp=BytesIO(b'{"message":"You are being rate limited.","retry_after":0.5,"global":false}'),
            )
        return FakeResponse()

    def fake_sleep(duration):
        sleeps.append(duration)

    monkeypatch.setattr(request, 'urlopen', fake_urlopen)
    monkeypatch.setattr('utils.sessions.generate_future_sessions.time_module.sleep', fake_sleep)

    response = post_message_to_discord('https://discord.com/api/v10', 'token', '1', {'content': 'hello'})

    assert response == {'id': 'message-1'}
    assert calls['count'] == 2
    assert sleeps == [0.5]


def test_to_session_rows_builds_master_and_participant_entries():
    rows = to_session_rows(
        [
            {
                'id': 'session-1',
                'date': datetime(2026, 3, 17, 18, 30, tzinfo=UTC),
                'location': 'antrebloc',
                'participants': ['user-1', 'user-2'],
            }
        ]
    )

    assert rows == [
        {'id': 'session-1', 'sortId': 'session-1', 'date': 1773772200000, 'location': 'antrebloc'},
        {'id': 'session-1', 'sortId': 'user-1'},
        {'id': 'session-1', 'sortId': 'user-2'},
    ]


DEFAULT_SECRET_ID_FOR_TEST = 'unused-secret-id'
