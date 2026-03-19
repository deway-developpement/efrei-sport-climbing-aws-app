import {
    DeleteItemCommand,
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';

const client = new DynamoDBClient({ region: 'eu-west-3' });
const USER_CALENDAR_FEEDS_TABLE_NAME =
    process.env.USER_CALENDAR_FEEDS_TABLE_NAME || 'Efrei-Sport-Climbing-App.user-calendar-feeds';

export type UserCalendarFeed = {
    userId: string;
    calendarUrl: string;
    updatedAt: Date;
    lastFetchAt: Date | null;
    lastFetchStatus: 'success' | 'error' | 'never';
    lastError: string | null;
};

function marshallNullableString(value: string | null): { S: string } | { NULL: boolean } {
    return value ? { S: value } : { NULL: true };
}

function marshallNullableDate(value: Date | null): { N: string } | { NULL: boolean } {
    return value ? { N: value.getTime().toString() } : { NULL: true };
}

function unmarshallNullableString(value?: { S?: string; NULL?: boolean }): string | null {
    if (!value || value.NULL) {
        return null;
    }
    return value.S || null;
}

function unmarshallNullableDate(value?: { N?: string; NULL?: boolean }): Date | null {
    if (!value || value.NULL || !value.N) {
        return null;
    }
    return new Date(parseInt(value.N, 10));
}

export async function getUserCalendarFeed(userId: string): Promise<UserCalendarFeed | undefined> {
    const response = await client.send(
        new GetItemCommand({
            TableName: USER_CALENDAR_FEEDS_TABLE_NAME,
            Key: { userId: { S: userId } },
        }),
    );
    const item = response.Item;
    if (!item?.userId?.S || !item.calendarUrl?.S || !item.updatedAt?.N || !item.lastFetchStatus?.S) {
        return undefined;
    }

    return {
        userId: item.userId.S,
        calendarUrl: item.calendarUrl.S,
        updatedAt: new Date(parseInt(item.updatedAt.N, 10)),
        lastFetchAt: unmarshallNullableDate(item.lastFetchAt),
        lastFetchStatus: item.lastFetchStatus.S as UserCalendarFeed['lastFetchStatus'],
        lastError: unmarshallNullableString(item.lastError),
    };
}

export async function putUserCalendarFeed(userId: string, url: string, now: Date = new Date()): Promise<void> {
    await client.send(
        new PutItemCommand({
            TableName: USER_CALENDAR_FEEDS_TABLE_NAME,
            Item: {
                userId: { S: userId },
                calendarUrl: { S: url },
                updatedAt: { N: now.getTime().toString() },
                lastFetchAt: { NULL: true },
                lastFetchStatus: { S: 'never' },
                lastError: { NULL: true },
            },
        }),
    );
}

export async function deleteUserCalendarFeed(userId: string): Promise<void> {
    await client.send(
        new DeleteItemCommand({
            TableName: USER_CALENDAR_FEEDS_TABLE_NAME,
            Key: { userId: { S: userId } },
        }),
    );
}

export async function updateUserCalendarFeedFetchStatus(
    userId: string,
    status: 'success' | 'error',
    options: {
        now?: Date;
        lastError?: string | null;
    } = {},
): Promise<void> {
    const now = options.now || new Date();
    await client.send(
        new UpdateItemCommand({
            TableName: USER_CALENDAR_FEEDS_TABLE_NAME,
            Key: { userId: { S: userId } },
            UpdateExpression: 'SET lastFetchAt = :lastFetchAt, lastFetchStatus = :lastFetchStatus, lastError = :lastError',
            ExpressionAttributeValues: {
                ':lastFetchAt': marshallNullableDate(now),
                ':lastFetchStatus': { S: status },
                ':lastError': marshallNullableString(options.lastError || null),
            },
        }),
    );
}
