import {
    AttributeValue,
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    QueryCommand,
    ScanCommand,
    UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { RecommendationFeedback, RecommendationState, SessionRecommendation } from './dynamodb.types';

const client = new DynamoDBClient({ region: 'eu-west-3' });
const SESSION_RECOMMENDATIONS_TABLE_NAME =
    process.env.SESSION_RECOMMENDATIONS_TABLE_NAME || 'Efrei-Sport-Climbing-App.session-recommendations';

type MarshalledSessionRecommendation = Record<string, AttributeValue>;

function toDate(value?: string): Date | null {
    return value ? new Date(parseInt(value)) : null;
}

function toTtlDate(value?: string): Date | null {
    return value ? new Date(parseInt(value) * 1000) : null;
}

function marshallDate(value: Date): { N: string } {
    return { N: value.getTime().toString() };
}

function marshallTtlDate(value: Date): { N: string } {
    return { N: Math.floor(value.getTime() / 1000).toString() };
}

function marshallNullableDate(value: Date | null): { N: string } | { NULL: boolean } {
    return value ? { N: value.getTime().toString() } : { NULL: true };
}

function marshallNullableString(value: string | null): { S: string } | { NULL: boolean } {
    return value ? { S: value } : { NULL: true };
}

function marshallStringList(values: string[]): { L: AttributeValue[] } {
    return {
        L: Array.from(new Set(values.filter((value) => value.length > 0))).map((value) => ({
            S: value,
        })),
    };
}

export function unmarshallSessionRecommendationItem(item?: MarshalledSessionRecommendation): SessionRecommendation | null {
    if (
        !item?.userId?.S ||
        !item.sortId?.S ||
        !item.campaignId?.S ||
        !item.sessionId?.S ||
        !item.sessionDate?.N ||
        !item.recommendedAt?.N ||
        !item.expiresAt?.N ||
        !item.recommendationState?.S ||
        !item.deliveryStatus?.S
    ) {
        return null;
    }

    return {
        userId: item.userId.S,
        sortId: item.sortId.S,
        campaignId: item.campaignId.S,
        sessionId: item.sessionId.S,
        sessionDate: new Date(parseInt(item.sessionDate.N)),
        sessionLocation: item.sessionLocation?.S || '',
        recommendedAt: new Date(parseInt(item.recommendedAt.N)),
        expiresAt: toTtlDate(item.expiresAt.N)!,
        score: item.score?.N ? parseFloat(item.score.N) : 0,
        reasons: item.reasons?.L?.flatMap((value) => (value.S ? [value.S] : [])) || [],
        recommendationState: item.recommendationState.S as RecommendationState,
        deliveryStatus: item.deliveryStatus.S as SessionRecommendation['deliveryStatus'],
        deliveryChannelId: item.deliveryChannelId?.NULL ? null : item.deliveryChannelId?.S || null,
        deliveryMessageId: item.deliveryMessageId?.NULL ? null : item.deliveryMessageId?.S || null,
        expandedAt: item.expandedAt?.NULL ? null : toDate(item.expandedAt?.N),
        remindAt: item.remindAt?.NULL ? null : toDate(item.remindAt?.N),
        remindCount: item.remindCount?.N ? parseInt(item.remindCount.N) : 0,
        dismissedAt: item.dismissedAt?.NULL ? null : toDate(item.dismissedAt?.N),
        feedback: item.feedback?.NULL ? null : (item.feedback?.S as RecommendationFeedback | undefined) || null,
        similarSessionIds: item.similarSessionIds?.L?.flatMap((value) => (value.S ? [value.S] : [])) || [],
        algoliaClickSent: item.algoliaClickSent?.BOOL || false,
        algoliaConversionSent: item.algoliaConversionSent?.BOOL || false,
        joinedAt: item.joinedAt?.NULL ? null : toDate(item.joinedAt?.N),
    };
}

export function marshallSessionRecommendationItem(recommendation: SessionRecommendation): MarshalledSessionRecommendation {
    return {
        userId: { S: recommendation.userId },
        sortId: { S: recommendation.sortId },
        campaignId: { S: recommendation.campaignId },
        sessionId: { S: recommendation.sessionId },
        sessionDate: marshallDate(recommendation.sessionDate),
        sessionLocation: { S: recommendation.sessionLocation },
        recommendedAt: marshallDate(recommendation.recommendedAt),
        expiresAt: marshallTtlDate(recommendation.expiresAt),
        score: { N: recommendation.score.toString() },
        reasons: marshallStringList(recommendation.reasons),
        recommendationState: { S: recommendation.recommendationState },
        deliveryStatus: { S: recommendation.deliveryStatus },
        deliveryChannelId: marshallNullableString(recommendation.deliveryChannelId),
        deliveryMessageId: marshallNullableString(recommendation.deliveryMessageId),
        expandedAt: marshallNullableDate(recommendation.expandedAt),
        remindAt: marshallNullableDate(recommendation.remindAt),
        remindCount: { N: recommendation.remindCount.toString() },
        dismissedAt: marshallNullableDate(recommendation.dismissedAt),
        feedback: marshallNullableString(recommendation.feedback),
        similarSessionIds: marshallStringList(recommendation.similarSessionIds),
        algoliaClickSent: { BOOL: recommendation.algoliaClickSent },
        algoliaConversionSent: { BOOL: recommendation.algoliaConversionSent },
        joinedAt: marshallNullableDate(recommendation.joinedAt),
    };
}

export function buildRecommendationSortId(campaignId: string, sessionId: string): string {
    return `campaign#${campaignId}#session#${sessionId}`;
}

export async function putSessionRecommendation(recommendation: SessionRecommendation): Promise<void> {
    await client.send(
        new PutItemCommand({
            TableName: SESSION_RECOMMENDATIONS_TABLE_NAME,
            Item: marshallSessionRecommendationItem(recommendation),
        }),
    );
}

export async function getSessionRecommendation(userId: string, sortId: string): Promise<SessionRecommendation | undefined> {
    const { Item } = await client.send(
        new GetItemCommand({
            TableName: SESSION_RECOMMENDATIONS_TABLE_NAME,
            Key: { userId: { S: userId }, sortId: { S: sortId } },
        }),
    );
    return unmarshallSessionRecommendationItem(Item as MarshalledSessionRecommendation | undefined) || undefined;
}

export async function listSessionRecommendationsByUser(userId: string): Promise<SessionRecommendation[]> {
    const recommendations: SessionRecommendation[] = [];
    let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
        const response = await client.send(
            new QueryCommand({
                TableName: SESSION_RECOMMENDATIONS_TABLE_NAME,
                KeyConditionExpression: '#userId = :userId',
                ExpressionAttributeNames: { '#userId': 'userId' },
                ExpressionAttributeValues: { ':userId': { S: userId } },
                ExclusiveStartKey,
            }),
        );
        for (const item of response.Items || []) {
            const recommendation = unmarshallSessionRecommendationItem(item as MarshalledSessionRecommendation);
            if (recommendation) {
                recommendations.push(recommendation);
            }
        }
        ExclusiveStartKey = response.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
    } while (ExclusiveStartKey);
    return recommendations;
}

export async function findLatestRecommendationForUserSession(
    userId: string,
    sessionId: string,
    now: Date = new Date(),
): Promise<SessionRecommendation | undefined> {
    const recommendations = await listSessionRecommendationsByUser(userId);
    return recommendations
        .filter((recommendation) => recommendation.sessionId === sessionId && recommendation.expiresAt >= now)
        .sort((left, right) => right.recommendedAt.getTime() - left.recommendedAt.getTime())[0];
}

export async function updateSessionRecommendationState(
    userId: string,
    sortId: string,
    state: RecommendationState,
    options: {
        feedback?: RecommendationFeedback | null;
        expandedAt?: Date | null;
        remindAt?: Date | null;
        remindCount?: number;
        dismissedAt?: Date | null;
        joinedAt?: Date | null;
        algoliaClickSent?: boolean;
        algoliaConversionSent?: boolean;
        deliveryChannelId?: string | null;
        deliveryMessageId?: string | null;
        deliveryStatus?: SessionRecommendation['deliveryStatus'];
    } = {},
): Promise<void> {
    const expressionNames: Record<string, string> = { '#recommendationState': 'recommendationState' };
    const expressionValues: Record<string, AttributeValue> = { ':recommendationState': { S: state } };
    const updates = ['#recommendationState = :recommendationState'];

    const applyNullableDate = (field: string, value: Date | null | undefined) => {
        if (value === undefined) {
            return;
        }
        expressionNames[`#${field}`] = field;
        expressionValues[`:${field}`] = value ? { N: value.getTime().toString() } : { NULL: true };
        updates.push(`#${field} = :${field}`);
    };

    const applyNullableString = (field: string, value: string | null | undefined) => {
        if (value === undefined) {
            return;
        }
        expressionNames[`#${field}`] = field;
        expressionValues[`:${field}`] = value ? { S: value } : { NULL: true };
        updates.push(`#${field} = :${field}`);
    };

    const applyBoolean = (field: string, value: boolean | undefined) => {
        if (value === undefined) {
            return;
        }
        expressionNames[`#${field}`] = field;
        expressionValues[`:${field}`] = { BOOL: value };
        updates.push(`#${field} = :${field}`);
    };

    const applyNumber = (field: string, value: number | undefined) => {
        if (value === undefined) {
            return;
        }
        expressionNames[`#${field}`] = field;
        expressionValues[`:${field}`] = { N: value.toString() };
        updates.push(`#${field} = :${field}`);
    };

    applyNullableString('feedback', options.feedback);
    applyNullableDate('expandedAt', options.expandedAt);
    applyNullableDate('remindAt', options.remindAt);
    applyNumber('remindCount', options.remindCount);
    applyNullableDate('dismissedAt', options.dismissedAt);
    applyNullableDate('joinedAt', options.joinedAt);
    applyBoolean('algoliaClickSent', options.algoliaClickSent);
    applyBoolean('algoliaConversionSent', options.algoliaConversionSent);
    applyNullableString('deliveryChannelId', options.deliveryChannelId);
    applyNullableString('deliveryMessageId', options.deliveryMessageId);
    applyNullableString('deliveryStatus', options.deliveryStatus);

    await client.send(
        new UpdateItemCommand({
            TableName: SESSION_RECOMMENDATIONS_TABLE_NAME,
            Key: { userId: { S: userId }, sortId: { S: sortId } },
            UpdateExpression: `SET ${updates.join(', ')}`,
            ExpressionAttributeNames: expressionNames,
            ExpressionAttributeValues: expressionValues,
        }),
    );
}

export async function listPendingReminderRecommendations(now: Date = new Date()): Promise<SessionRecommendation[]> {
    const recommendations: SessionRecommendation[] = [];
    let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
        const response = await client.send(
            new ScanCommand({
                TableName: SESSION_RECOMMENDATIONS_TABLE_NAME,
                FilterExpression: '#recommendationState = :state AND #remindAt <= :now',
                ExpressionAttributeNames: {
                    '#recommendationState': 'recommendationState',
                    '#remindAt': 'remindAt',
                },
                ExpressionAttributeValues: {
                    ':state': { S: 'remind_requested' },
                    ':now': { N: now.getTime().toString() },
                },
                ExclusiveStartKey,
            }),
        );
        for (const item of response.Items || []) {
            const recommendation = unmarshallSessionRecommendationItem(item as MarshalledSessionRecommendation);
            if (recommendation) {
                recommendations.push(recommendation);
            }
        }
        ExclusiveStartKey = response.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
    } while (ExclusiveStartKey);
    return recommendations;
}
