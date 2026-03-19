import random
from datetime import UTC, datetime

from utils.algolia.send_simulated_session_insights import (
    RecommendationOpportunity,
    build_insights_payload,
    build_recommendation_opportunities,
    clamp_window_to_now,
    normalize_session_records,
    simulate_funnel_events,
)


def test_normalize_session_records_filters_deprecated_locations_and_expired_sessions():
    now = datetime(2026, 3, 17, 12, 0, tzinfo=UTC)
    records = [
        {'objectID': '1', 'location': 'antrebloc', 'isUpcoming': True, 'timestamp': 1773752400000},
        {'objectID': '2', 'location': 'vertical-art', 'isUpcoming': True, 'timestamp': 1773752400000},
        {'objectID': '3', 'location': 'climb-up', 'isUpcoming': False, 'timestamp': 1773752400000},
        {'objectID': '4', 'location': 'climb-up-bordeaux', 'isUpcoming': True, 'timestamp': 1773800000000},
    ]

    normalized = normalize_session_records(records, now)

    assert normalized == [
        {'objectID': '1', 'location': 'antrebloc', 'isUpcoming': True, 'timestamp': 1773752400000},
        {'objectID': '4', 'location': 'climb-up-bordeaux', 'isUpcoming': True, 'timestamp': 1773800000000},
    ]


def test_simulate_funnel_events_never_creates_conversion_without_click():
    opportunities = [
        RecommendationOpportunity(
            user_id='user-1',
            session_id='session-1',
            score=90,
            reasons=('favorite_location', 'regular_group'),
            location='antrebloc',
            session_timestamp=1773856800000,
            participant_count=8,
            activity_level='popular',
        )
    ]
    start = datetime(2026, 3, 17, 8, 0, tzinfo=UTC)
    end = datetime(2026, 3, 18, 23, 0, tzinfo=UTC)

    events, stats = simulate_funnel_events(
        opportunities,
        target_event_count=40,
        click_rate=0.35,
        conversion_rate=0.6,
        start=start,
        end=end,
        rng=random.Random(7),
    )

    clicked_pairs = {(event.user_token, event.session_id) for event in events if event.event_type == 'click'}
    converted_pairs = {(event.user_token, event.session_id) for event in events if event.event_type == 'conversion'}

    assert converted_pairs.issubset(clicked_pairs)
    assert stats['conversionEvents'] <= stats['clickEvents']


def test_simulate_funnel_events_is_deterministic_with_same_seed():
    opportunities = [
        RecommendationOpportunity(
            user_id='user-1',
            session_id='session-1',
            score=75,
            reasons=('favorite_location',),
            location='antrebloc',
            session_timestamp=1773856800000,
            participant_count=6,
            activity_level='popular',
        ),
        RecommendationOpportunity(
            user_id='user-2',
            session_id='session-2',
            score=52,
            reasons=('promo_overlap',),
            location='climb-up',
            session_timestamp=1773943200000,
            participant_count=4,
            activity_level='small',
        ),
    ]
    start = datetime(2026, 3, 17, 8, 0, tzinfo=UTC)
    end = datetime(2026, 3, 20, 23, 0, tzinfo=UTC)

    events_a, _ = simulate_funnel_events(opportunities, 25, 0.2, 0.3, start, end, random.Random(42))
    events_b, _ = simulate_funnel_events(opportunities, 25, 0.2, 0.3, start, end, random.Random(42))

    assert events_a == events_b


def test_build_insights_payload_maps_events_to_algolia_shape():
    events, _ = simulate_funnel_events(
        [
            RecommendationOpportunity(
                user_id='user-1',
                session_id='session-1',
                score=90,
                reasons=('favorite_location',),
                location='antrebloc',
                session_timestamp=1773856800000,
                participant_count=8,
                activity_level='popular',
            )
        ],
        target_event_count=5,
        click_rate=0.5,
        conversion_rate=0.5,
        start=datetime(2026, 3, 17, 8, 0, tzinfo=UTC),
        end=datetime(2026, 3, 18, 23, 0, tzinfo=UTC),
        rng=random.Random(3),
    )

    payload = build_insights_payload(events, 'esc_sessions')

    assert len(payload) == 5
    assert set(payload[0].keys()) == {'eventType', 'eventName', 'index', 'userToken', 'objectIDs', 'timestamp'}
    assert payload[0]['index'] == 'esc_sessions'
    assert payload[0]['objectIDs'] == ['session-1']


def test_build_recommendation_opportunities_scores_direct_session_records():
    users = [{'id': 'user-1', 'promo': '2027'}]
    user_stats_rows = [
        {
            'userId': 'user-1',
            'activityStatus': 'active',
            'sessionsLast90Days': 3,
            'favoriteLocation': 'antrebloc',
            'preferredDayOfWeek': 'monday',
        }
    ]
    session_records = [
        {
            'objectID': 'session-1',
            'location': 'antrebloc',
            'timestamp': 1773856800000,
            'participantCount': 8,
            'activityLevel': 'popular',
            'participantPromos': ['2027'],
            'repeatParticipantIds': ['user-x'],
            'isUpcoming': True,
            'weekday': 'monday',
        },
        {
            'objectID': 'session-2',
            'location': 'climb-up',
            'timestamp': 1773943200000,
            'participantCount': 2,
            'activityLevel': 'small',
            'participantPromos': [],
            'repeatParticipantIds': [],
            'isUpcoming': True,
            'weekday': 'tuesday',
        },
    ]

    opportunities = build_recommendation_opportunities(users, user_stats_rows, session_records, 2)

    assert [opportunity.session_id for opportunity in opportunities] == ['session-1', 'session-2']
    assert opportunities[0].score > opportunities[1].score


def test_clamp_window_to_now_prevents_future_end():
    now = datetime(2026, 3, 17, 10, 0, tzinfo=UTC)
    start = datetime(2026, 3, 1, 0, 0, tzinfo=UTC)
    end = datetime(2026, 3, 20, 0, 0, tzinfo=UTC)

    clamped_start, clamped_end = clamp_window_to_now(start, end, now)

    assert clamped_start == start
    assert clamped_end == now
