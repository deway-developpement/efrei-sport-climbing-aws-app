import {
    AttributeValue,
    BatchWriteItemCommand,
    DynamoDBClient,
    GetItemCommand,
    ScanCommand,
    WriteRequest,
} from '@aws-sdk/client-dynamodb';
import { UserStats } from './dynamodb.types';

const client = new DynamoDBClient({ region: 'eu-west-3' });
const USER_STATS_TABLE_NAME = process.env.USER_STATS_TABLE_NAME || 'Efrei-Sport-Climbing-App.user-stats';

function toDate(value?: string): Date | null {
    if (!value) {
        return null;
    }
    return new Date(parseInt(value));
}

function toNumber(value?: string): number {
    return value ? parseInt(value) : 0;
}

function toNullableNumber(value?: string): number | null {
    return value ? parseFloat(value) : null;
}

type MarshalledUserStats = Record<string, AttributeValue>;

function unmarshallUserStats(item?: MarshalledUserStats): UserStats | null {
    if (!item?.userId?.S || !item.activityStatus?.S || !item.computedAt?.N || !item.statsVersion?.S) {
        return null;
    }
    return {
        userId: item.userId.S,
        nbOfSeances: toNumber(item.nbOfSeances?.N),
        firstSeenAt: item.firstSeenAt?.NULL ? null : toDate(item.firstSeenAt?.N),
        lastActivityAt: item.lastActivityAt?.NULL ? null : toDate(item.lastActivityAt?.N),
        lastSessionDate: item.lastSessionDate?.NULL ? null : toDate(item.lastSessionDate?.N),
        sessionsLast30Days: toNumber(item.sessionsLast30Days?.N),
        sessionsLast90Days: toNumber(item.sessionsLast90Days?.N),
        membershipTenureDays: item.membershipTenureDays?.NULL ? null : toNumber(item.membershipTenureDays?.N),
        activityStatus: item.activityStatus.S as UserStats['activityStatus'],
        favoriteLocation: item.favoriteLocation?.NULL ? null : item.favoriteLocation?.S || null,
        preferredDayOfWeek: item.preferredDayOfWeek?.NULL ? null : item.preferredDayOfWeek?.S || null,
        ticketCount: toNumber(item.ticketCount?.N),
        hasOpenIssue: item.hasOpenIssue?.BOOL || false,
        profileCompletenessScore: toNumber(item.profileCompletenessScore?.N),
        tags: item.tags?.SS || [],
        attendanceRate: item.attendanceRate?.NULL ? null : toNullableNumber(item.attendanceRate?.N),
        computedAt: new Date(parseInt(item.computedAt.N)),
        statsVersion: item.statsVersion.S,
    };
}

function marshallNullableDate(value: Date | null): { N: string } | { NULL: boolean } {
    return value ? { N: value.getTime().toString() } : { NULL: true };
}

function marshallNullableString(value: string | null): { S: string } | { NULL: boolean } {
    return value ? { S: value } : { NULL: true };
}

function marshallNullableNumber(value: number | null): { N: string } | { NULL: boolean } {
    return value === null ? { NULL: true } : { N: value.toString() };
}

function marshallUserStats(stats: UserStats): MarshalledUserStats {
    return {
        userId: { S: stats.userId },
        nbOfSeances: { N: stats.nbOfSeances.toString() },
        firstSeenAt: marshallNullableDate(stats.firstSeenAt),
        lastActivityAt: marshallNullableDate(stats.lastActivityAt),
        lastSessionDate: marshallNullableDate(stats.lastSessionDate),
        sessionsLast30Days: { N: stats.sessionsLast30Days.toString() },
        sessionsLast90Days: { N: stats.sessionsLast90Days.toString() },
        membershipTenureDays: marshallNullableNumber(stats.membershipTenureDays),
        activityStatus: { S: stats.activityStatus },
        favoriteLocation: marshallNullableString(stats.favoriteLocation),
        preferredDayOfWeek: marshallNullableString(stats.preferredDayOfWeek),
        ticketCount: { N: stats.ticketCount.toString() },
        hasOpenIssue: { BOOL: stats.hasOpenIssue },
        profileCompletenessScore: { N: stats.profileCompletenessScore.toString() },
        tags: { SS: stats.tags },
        attendanceRate: marshallNullableNumber(stats.attendanceRate),
        computedAt: { N: stats.computedAt.getTime().toString() },
        statsVersion: { S: stats.statsVersion },
    };
}

export async function getUserStats(userId: string): Promise<UserStats | undefined> {
    const { Item } = await client.send(
        new GetItemCommand({
            TableName: USER_STATS_TABLE_NAME,
            Key: { userId: { S: userId } },
        }),
    );
    return unmarshallUserStats(Item as MarshalledUserStats | undefined) || undefined;
}

export async function putUserStats(stats: UserStats): Promise<void> {
    await batchPutUserStats([stats]);
}

export async function batchPutUserStats(statsItems: UserStats[]): Promise<void> {
    for (let index = 0; index < statsItems.length; index += 25) {
        const chunk = statsItems.slice(index, index + 25);
        const requestItems: WriteRequest[] = chunk.map((stats) => ({
            PutRequest: {
                Item: marshallUserStats(stats),
            },
        }));
        await client.send(
            new BatchWriteItemCommand({
                RequestItems: {
                    [USER_STATS_TABLE_NAME]: requestItems,
                },
            }),
        );
    }
}

export async function listUserStats(): Promise<UserStats[]> {
    const stats: UserStats[] = [];
    let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
        const response = await client.send(
            new ScanCommand({
                TableName: USER_STATS_TABLE_NAME,
                ExclusiveStartKey,
            }),
        );
        for (const item of response.Items || []) {
            const unmarshalled = unmarshallUserStats(item as MarshalledUserStats);
            if (unmarshalled) {
                stats.push(unmarshalled);
            }
        }
        ExclusiveStartKey = response.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
    } while (ExclusiveStartKey);
    return stats;
}
