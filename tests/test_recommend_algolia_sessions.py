from utils.algolia.recommend_algolia_sessions import (
    build_recommendation_filters,
    recommend_sessions,
    score_recommendation,
)


def test_build_recommendation_filters_prefers_user_location_and_day():
    filters = build_recommendation_filters(
        {
            'favoriteLocation': 'climb-up',
            'preferredDayOfWeek': 'thursday',
        }
    )

    assert filters == [
        'isUpcoming:true AND location:"climb-up" AND weekday:"thursday"',
        'isUpcoming:true AND location:"climb-up"',
        'isUpcoming:true AND weekday:"thursday"',
        'isUpcoming:true',
    ]


def test_score_recommendation_explains_match_reasons():
    score, reasons = score_recommendation(
        {'promo': '2027'},
        {
            'favoriteLocation': 'climb-up',
            'preferredDayOfWeek': 'thursday',
            'activityStatus': 'power_user',
        },
        {
            'location': 'climb-up',
            'weekday': 'thursday',
            'participantPromos': ['2027', '2028'],
            'repeatParticipantIds': ['user-2'],
            'activityLevel': 'popular',
            'participantCount': 9,
        },
    )

    assert score == 127
    assert reasons == [
        'favorite_location',
        'preferred_day',
        'promo_overlap',
        'regular_group',
        'high_energy_match',
    ]


def test_recommend_sessions_deduplicates_and_sorts_by_score_then_date():
    recommendations = recommend_sessions(
        {'promo': '2027'},
        {
            'favoriteLocation': 'climb-up',
            'preferredDayOfWeek': 'thursday',
            'activityStatus': 'active',
        },
        [
            (
                'isUpcoming:true AND location:"climb-up" AND weekday:"thursday"',
                [
                    {
                        'objectID': 'session-1',
                        'timestamp': 1773352800000,
                        'location': 'climb-up',
                        'weekday': 'thursday',
                        'participantPromos': ['2027'],
                        'repeatParticipantIds': ['user-2'],
                        'activityLevel': 'popular',
                        'participantCount': 8,
                    }
                ],
            ),
            (
                'isUpcoming:true',
                [
                    {
                        'objectID': 'session-1',
                        'timestamp': 1773352800000,
                        'location': 'climb-up',
                        'weekday': 'thursday',
                        'participantPromos': ['2027'],
                        'repeatParticipantIds': ['user-2'],
                        'activityLevel': 'popular',
                        'participantCount': 8,
                    },
                    {
                        'objectID': 'session-2',
                        'timestamp': 1773439200000,
                        'location': 'arkose',
                        'weekday': 'friday',
                        'participantPromos': ['2026'],
                        'repeatParticipantIds': [],
                        'activityLevel': 'small',
                        'participantCount': 3,
                    },
                ],
            ),
        ],
        10,
    )

    assert [item['session']['objectID'] for item in recommendations] == ['session-1', 'session-2']
    assert recommendations[0]['score'] > recommendations[1]['score']
    assert 'isUpcoming:true AND location:"climb-up" AND weekday:"thursday"' in recommendations[0]['reasons']
