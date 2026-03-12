#!/usr/bin/env python3

import json
import os
import sys
import urllib.error
import urllib.request

import boto3


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value


def load_algolia_credentials(secret_path: str, region: str) -> tuple[str, str]:
    client = boto3.client("secretsmanager", region_name=region)
    response = client.get_secret_value(SecretId=secret_path)
    secret = json.loads(response["SecretString"])
    return secret["ALGOLIA_APP_ID"], secret["ALGOLIA_ADMIN_API_KEY"]


def scan_users(table_name: str, region: str) -> list[dict]:
    table = boto3.resource("dynamodb", region_name=region).Table(table_name)
    users = []
    response = table.scan()
    users.extend(response.get("Items", []))
    while "LastEvaluatedKey" in response:
        response = table.scan(ExclusiveStartKey=response["LastEvaluatedKey"])
        users.extend(response.get("Items", []))
    return users


def to_algolia_record(user: dict) -> dict:
    return {
        "objectID": user["id"],
        "id": user["id"],
        "firstName": user["firstName"],
        "lastName": user["lastName"],
        "promo": user["promo"],
        "fullName": f"{user['firstName']} {user['lastName']}".strip(),
    }


def batch_index(app_id: str, api_key: str, index_name: str, records: list[dict]) -> None:
    url = f"https://{app_id}-dsn.algolia.net/1/indexes/{index_name}/batch"
    operations = [{"action": "updateObject", "body": record} for record in records]
    payload = json.dumps({"requests": operations}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Algolia-Application-Id": app_id,
            "X-Algolia-API-Key": api_key,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            print(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode("utf-8")) from error


def main() -> int:
    region = os.environ.get("AWS_REGION", "eu-west-3")
    table_name = os.environ.get("USERS_TABLE", "Efrei-Sport-Climbing-App.users")
    secret_path = require_env("ALGOLIA_SECRET_PATH")
    index_name = require_env("ALGOLIA_USERS_INDEX")

    app_id, api_key = load_algolia_credentials(secret_path, region)
    users = scan_users(table_name, region)
    records = [to_algolia_record(user) for user in users]
    if not records:
        print("No users found to index.")
        return 0

    chunk_size = 500
    for start in range(0, len(records), chunk_size):
        batch_index(app_id, api_key, index_name, records[start : start + chunk_size])

    print(f"Indexed {len(records)} users into Algolia index {index_name}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
