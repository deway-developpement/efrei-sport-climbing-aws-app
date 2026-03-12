from utils.check_sessions_user_refs import attr_str


def test_attr_str_returns_string_value():
    item = {'id': {'S': 'session-1'}}

    assert attr_str(item, 'id') == 'session-1'


def test_attr_str_returns_numeric_value_as_string():
    item = {'count': {'N': '42'}}

    assert attr_str(item, 'count') == '42'


def test_attr_str_returns_none_for_missing_or_invalid_value():
    assert attr_str({}, 'id') is None
    assert attr_str({'id': 'session-1'}, 'id') is None
