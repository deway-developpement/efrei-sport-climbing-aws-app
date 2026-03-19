from datetime import UTC, datetime
from pathlib import Path

from utils.algolia.build_user_stats_and_algolia_backfill import (
    build_user_assignment_weights,
    compute_activity_status,
    compute_from_cache,
    compute_order_ticket_assignments,
    compute_profile_completeness,
    normalize_string,
)


def test_normalize_string_removes_accents_and_normalizes_spacing():
    assert normalize_string('  Éléonore  Dùpont ') == 'eleonore dupont'


def test_compute_order_ticket_assignments_uses_weighted_random_assignment():
    order_rows = [
        {'id': 'ticket-b', 'orderId': 'order-1'},
        {'id': 'ticket-a', 'orderId': 'order-1'},
    ]
    user_weights = {'user-1': 10.0, 'user-2': 1.0}
    assignments, status = compute_order_ticket_assignments(
        order_rows,
        ['user-1', 'user-2'],
        user_weights,
    )

    assert status == 'random_weighted_assignment'
    assert set(assignments) == {'ticket-a', 'ticket-b'}
    assert set(assignments.values()).issubset({'user-1', 'user-2'})


def test_build_user_assignment_weights_favors_climb_up_and_engagement():
    users = [
        {'id': 'user-1'},
        {'id': 'user-2'},
    ]
    session_participants_by_user_id = {
        'user-1': [{'location': 'climb-up'}, {'location': 'climb-up-bordeaux'}, {'location': 'antrebloc'}],
        'user-2': [{'location': 'antrebloc'}],
    }

    weights = build_user_assignment_weights(users, session_participants_by_user_id)

    assert weights['user-1'] > weights['user-2']


def test_compute_order_ticket_assignments_is_deterministic_for_a_given_order():
    order_rows = [
        {'id': 'ticket-2', 'orderId': 'order-1'},
        {'id': 'ticket-1', 'orderId': 'order-1'},
    ]
    user_weights = {'user-1': 4.0, 'user-2': 2.0, 'user-3': 1.0}
    user_ids = ['user-1', 'user-2', 'user-3']
    first_assignments, status = compute_order_ticket_assignments(order_rows, user_ids, user_weights)
    second_assignments, _ = compute_order_ticket_assignments(order_rows, user_ids, user_weights)

    assert status == 'random_weighted_assignment'
    assert first_assignments == second_assignments


def test_compute_activity_status_uses_expected_thresholds():
    now = datetime(2026, 3, 12, tzinfo=UTC)
    assert compute_activity_status(now, None, None, 0) == 'inactive'
    assert compute_activity_status(now, now, now, 1) == 'new'
    assert compute_activity_status(now, now.replace(month=1), now, 25) == 'power_user'
    assert compute_activity_status(now, now.replace(year=2025), now.replace(year=2025), 8) == 'inactive'


def test_compute_profile_completeness_combines_core_fields():
    score = compute_profile_completeness(
        {'id': 'user-1', 'firstName': 'Paul', 'lastName': 'Mairesse', 'promo': '2027'},
        ticket_count=2,
        last_activity=datetime(2026, 3, 12, tzinfo=UTC),
    )

    assert score == 100


def test_compute_from_cache_builds_stats_and_algolia_records(tmp_path: Path):
    cache_dir = tmp_path
    (cache_dir / 'users.json').write_text(
        '[{"id":"user-1","firstName":"Paul","lastName":"Mairesse","promo":"2027"}]',
        encoding='utf-8',
    )
    (cache_dir / 'sessions.json').write_text(
        '[{"id":"session-1","sortId":"session-1","date":1700000000000,"location":"antrebloc"},'
        '{"id":"session-1","sortId":"user-1"}]',
        encoding='utf-8',
    )
    (cache_dir / 'tickets.json').write_text(
        '[{"id":"ticket-1","orderId":"ticket-1","sold":true,"date":1700000000000},'
        '{"id":"ticket-1","orderId":"order-1","date":1700000000000}]',
        encoding='utf-8',
    )
    (cache_dir / 'issues.json').write_text(
        '[{"orderId":"order-1","status":"open"}]',
        encoding='utf-8',
    )
    (cache_dir / 'orders.json').write_text('{}', encoding='utf-8')
    (cache_dir / 'order_fetch_errors.json').write_text('{}', encoding='utf-8')

    stats_records, algolia_records, report = compute_from_cache(cache_dir, datetime(2026, 3, 12, tzinfo=UTC))

    assert stats_records[0]['userId'] == 'user-1'
    assert stats_records[0]['ticketCount'] == 1
    assert algolia_records[0]['fullNameNormalized'] == 'paul mairesse'
    assert report['ordersFetchedCount'] == 0
