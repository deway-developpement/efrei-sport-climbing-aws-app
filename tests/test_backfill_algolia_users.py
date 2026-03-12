from utils.backfill_algolia_users import require_env, to_algolia_record


def test_require_env_returns_value(monkeypatch):
    monkeypatch.setenv('ALGOLIA_USERS_INDEX', 'esc_users')

    assert require_env('ALGOLIA_USERS_INDEX') == 'esc_users'


def test_require_env_raises_for_missing_value(monkeypatch):
    monkeypatch.delenv('ALGOLIA_USERS_INDEX', raising=False)

    try:
        require_env('ALGOLIA_USERS_INDEX')
    except RuntimeError as error:
        assert str(error) == 'Missing environment variable: ALGOLIA_USERS_INDEX'
    else:
        raise AssertionError('require_env should raise when the environment variable is missing')


def test_to_algolia_record_builds_expected_payload():
    user = {
        'id': 'user-1',
        'firstName': 'Paul',
        'lastName': 'Mairesse',
        'promo': '2027',
    }

    assert to_algolia_record(user) == {
        'objectID': 'user-1',
        'id': 'user-1',
        'firstName': 'Paul',
        'lastName': 'Mairesse',
        'promo': '2027',
        'fullName': 'Paul Mairesse',
    }
