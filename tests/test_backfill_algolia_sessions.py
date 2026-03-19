from datetime import UTC, datetime

from utils.algolia.backfill_algolia_sessions import (
    build_session_records,
    build_similarity_tags,
    get_activity_level,
    get_tags,
)


def test_get_activity_level_thresholds():
    assert get_activity_level(1) == 'small'
    assert get_activity_level(6) == 'popular'
    assert get_activity_level(12) == 'very_popular'


def test_get_tags_marks_upcoming_weekday_evening_and_location():
    date = datetime(2026, 3, 12, 18, 0, tzinfo=UTC)

    tags = get_tags('climb-up', True, date, 8)

    assert 'climb-up' in tags
    assert 'upcoming' in tags
    assert 'weekday-evening' in tags
    assert 'popular' in tags


def test_build_session_records_reconstructs_participants_and_fields():
    users = [
        {'id': 'user-1', 'firstName': 'Paul', 'lastName': 'Mairesse', 'promo': '2027'},
        {'id': 'user-2', 'firstName': 'Alice', 'lastName': 'Martin', 'promo': '2026'},
    ]
    sessions = [
        {'id': 'session-1', 'sortId': 'session-1', 'date': 1773352800000, 'location': 'climb-up'},
        {'id': 'session-1', 'sortId': 'user-1'},
        {'id': 'session-1', 'sortId': 'user-2'},
    ]

    records = build_session_records(users, sessions, datetime(2026, 3, 10, tzinfo=UTC))

    assert len(records) == 1
    record = records[0]
    assert record['objectID'] == 'session-1'
    assert record['participantCount'] == 2
    assert record['participantIds'] == ['user-1', 'user-2']
    assert record['participantNames'] == ['Paul Mairesse', 'Alice Martin']
    assert record['participantPromos'] == ['2026', '2027']
    assert record['location'] == 'climb-up'
    assert record['isUpcoming'] is True
    assert record['participantPreview'] == ['Alice Martin', 'Paul Mairesse']
    assert record['favoriteParticipantPromos'] == ['2026', '2027']
    assert record['dominantPromo'] == '2026'
    assert record['repeatParticipantIds'] == []
    assert record['repeatParticipantNames'] == []
    assert 'promo-2026' in record['similarityTags']


def test_build_session_records_marks_repeat_participants_from_coattendance_history():
    users = [
        {'id': 'user-1', 'firstName': 'Paul', 'lastName': 'Mairesse', 'promo': '2027'},
        {'id': 'user-2', 'firstName': 'Alice', 'lastName': 'Martin', 'promo': '2026'},
        {'id': 'user-3', 'firstName': 'Noa', 'lastName': 'Durand', 'promo': '2028'},
    ]
    sessions = [
        {'id': 'session-1', 'sortId': 'session-1', 'date': 1773352800000, 'location': 'climb-up'},
        {'id': 'session-1', 'sortId': 'user-1'},
        {'id': 'session-1', 'sortId': 'user-2'},
        {'id': 'session-2', 'sortId': 'session-2', 'date': 1773439200000, 'location': 'climb-up'},
        {'id': 'session-2', 'sortId': 'user-1'},
        {'id': 'session-2', 'sortId': 'user-2'},
        {'id': 'session-2', 'sortId': 'user-3'},
    ]

    records = build_session_records(users, sessions, datetime(2026, 3, 10, tzinfo=UTC))

    session_2 = next(record for record in records if record['id'] == 'session-2')
    assert session_2['repeatParticipantIds'] == ['user-2', 'user-1']
    assert session_2['repeatParticipantNames'] == ['Alice Martin', 'Paul Mairesse']
    assert session_2['participantPreview'][:2] == ['Alice Martin', 'Paul Mairesse']
    assert 'regular-group' in session_2['similarityTags']


def test_build_similarity_tags_adds_social_and_contextual_signals():
    date = datetime(2026, 3, 13, 18, 0, tzinfo=UTC)

    tags = build_similarity_tags('climb-up', date, 8, '2027', 2)

    assert tags == ['afterwork', 'popular-climb-up', 'promo-2027', 'regular-group']
