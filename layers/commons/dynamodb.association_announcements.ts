import {
    AttributeValue,
    BatchWriteItemCommand,
    DeleteItemCommand,
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    ScanCommand,
    WriteRequest,
} from '@aws-sdk/client-dynamodb';
import { AssociationAnnouncement } from './dynamodb.types';

const client = new DynamoDBClient({ region: 'eu-west-3' });
const ASSOCIATION_ANNOUNCEMENTS_TABLE_NAME =
    process.env.ASSOCIATION_ANNOUNCEMENTS_TABLE_NAME || 'Efrei-Sport-Climbing-App.association-announcements';

type MarshalledAssociationAnnouncement = Record<string, AttributeValue>;

function marshallNullableString(value: string | null): AttributeValue {
    return value ? { S: value } : { NULL: true };
}

function unmarshallNullableString(value?: AttributeValue): string | null {
    if (!value || ('NULL' in value && value.NULL)) {
        return null;
    }
    return 'S' in value && value.S ? value.S : null;
}

function marshallStringList(values: string[]): AttributeValue {
    return {
        L: values.map((value) => ({ S: value })),
    };
}

function unmarshallStringList(value?: AttributeValue): string[] {
    if (!value || !('L' in value) || !value.L) {
        return [];
    }
    return value.L.flatMap((entry) => ('S' in entry && entry.S ? [entry.S] : []));
}

function marshallNullableDate(value: Date | null): AttributeValue {
    return value ? { N: value.getTime().toString() } : { NULL: true };
}

function unmarshallNullableDate(value?: AttributeValue): Date | null {
    if (!value || ('NULL' in value && value.NULL)) {
        return null;
    }
    return 'N' in value && value.N ? new Date(parseInt(value.N, 10)) : null;
}

function marshallAssociationAnnouncement(announcement: AssociationAnnouncement): MarshalledAssociationAnnouncement {
    return {
        id: { S: announcement.id },
        sourceMessageId: marshallNullableString(announcement.sourceMessageId),
        sourceChannelId: marshallNullableString(announcement.sourceChannelId),
        title: { S: announcement.title },
        content: { S: announcement.content },
        startsAt: { N: announcement.startsAt.getTime().toString() },
        endsAt: { N: announcement.endsAt.getTime().toString() },
        expiresAt: { N: Math.floor(announcement.expiresAt.getTime() / 1000).toString() },
        priority: { N: announcement.priority.toString() },
        tags: marshallStringList(announcement.tags),
        source: marshallNullableString(announcement.source),
        sourceUrl: marshallNullableString(announcement.sourceUrl),
        updatedAt: { N: announcement.updatedAt.getTime().toString() },
        category: marshallNullableString(announcement.category),
        audience: marshallStringList(announcement.audience),
        importantFacts: marshallStringList(announcement.importantFacts),
        callToAction: marshallNullableString(announcement.callToAction),
        summaryFresh: marshallNullableString(announcement.summaryFresh),
        summaryRecent: marshallNullableString(announcement.summaryRecent),
        summaryArchive: marshallNullableString(announcement.summaryArchive),
        compactionStatus: { S: announcement.compactionStatus },
        compactionModel: marshallNullableString(announcement.compactionModel),
        compactedAt: marshallNullableDate(announcement.compactedAt),
    };
}

function unmarshallAssociationAnnouncement(
    item?: MarshalledAssociationAnnouncement,
): AssociationAnnouncement | undefined {
    if (
        !item?.id?.S ||
        !item.title?.S ||
        !item.content?.S ||
        !item.startsAt?.N ||
        !item.endsAt?.N ||
        !item.expiresAt?.N ||
        !item.priority?.N ||
        !item.updatedAt?.N
    ) {
        return undefined;
    }

    return {
        id: item.id.S,
        sourceMessageId: unmarshallNullableString(item.sourceMessageId),
        sourceChannelId: unmarshallNullableString(item.sourceChannelId),
        title: item.title.S,
        content: item.content.S,
        startsAt: new Date(parseInt(item.startsAt.N, 10)),
        endsAt: new Date(parseInt(item.endsAt.N, 10)),
        expiresAt: new Date(parseInt(item.expiresAt.N, 10) * 1000),
        priority: parseInt(item.priority.N, 10),
        tags: unmarshallStringList(item.tags),
        source: unmarshallNullableString(item.source),
        sourceUrl: unmarshallNullableString(item.sourceUrl),
        updatedAt: new Date(parseInt(item.updatedAt.N, 10)),
        category: unmarshallNullableString(item.category),
        audience: unmarshallStringList(item.audience),
        importantFacts: unmarshallStringList(item.importantFacts),
        callToAction: unmarshallNullableString(item.callToAction),
        summaryFresh: unmarshallNullableString(item.summaryFresh),
        summaryRecent: unmarshallNullableString(item.summaryRecent),
        summaryArchive: unmarshallNullableString(item.summaryArchive),
        compactionStatus:
            ('S' in (item.compactionStatus || {}) && item.compactionStatus.S
                ? item.compactionStatus.S
                : 'pending') as AssociationAnnouncement['compactionStatus'],
        compactionModel: unmarshallNullableString(item.compactionModel),
        compactedAt: unmarshallNullableDate(item.compactedAt),
    };
}

export async function batchPutAssociationAnnouncements(announcements: AssociationAnnouncement[]): Promise<void> {
    for (let index = 0; index < announcements.length; index += 25) {
        const chunk = announcements.slice(index, index + 25);
        const requestItems: WriteRequest[] = chunk.map((announcement) => ({
            PutRequest: {
                Item: marshallAssociationAnnouncement(announcement),
            },
        }));

        await client.send(
            new BatchWriteItemCommand({
                RequestItems: {
                    [ASSOCIATION_ANNOUNCEMENTS_TABLE_NAME]: requestItems,
                },
            }),
        );
    }
}

export async function putAssociationAnnouncement(announcement: AssociationAnnouncement): Promise<void> {
    await client.send(
        new PutItemCommand({
            TableName: ASSOCIATION_ANNOUNCEMENTS_TABLE_NAME,
            Item: marshallAssociationAnnouncement(announcement),
        }),
    );
}

export async function deleteAssociationAnnouncement(id: string): Promise<void> {
    await client.send(
        new DeleteItemCommand({
            TableName: ASSOCIATION_ANNOUNCEMENTS_TABLE_NAME,
            Key: {
                id: { S: id },
            },
        }),
    );
}

export async function getAssociationAnnouncement(id: string): Promise<AssociationAnnouncement | undefined> {
    const response = await client.send(
        new GetItemCommand({
            TableName: ASSOCIATION_ANNOUNCEMENTS_TABLE_NAME,
            Key: {
                id: { S: id },
            },
        }),
    );

    return unmarshallAssociationAnnouncement(response.Item as MarshalledAssociationAnnouncement | undefined);
}

export async function listAssociationAnnouncementsForWindow(
    windowStart: Date,
    windowEnd: Date,
): Promise<AssociationAnnouncement[]> {
    const announcements: AssociationAnnouncement[] = [];
    let ExclusiveStartKey: Record<string, AttributeValue> | undefined;

    do {
        const response = await client.send(
            new ScanCommand({
                TableName: ASSOCIATION_ANNOUNCEMENTS_TABLE_NAME,
                ExclusiveStartKey,
                ExpressionAttributeNames: {
                    '#startsAt': 'startsAt',
                    '#endsAt': 'endsAt',
                },
                ExpressionAttributeValues: {
                    ':windowStart': { N: windowStart.getTime().toString() },
                    ':windowEnd': { N: windowEnd.getTime().toString() },
                },
                FilterExpression: '#startsAt <= :windowEnd AND #endsAt >= :windowStart',
            }),
        );

        for (const item of response.Items || []) {
            const announcement = unmarshallAssociationAnnouncement(item as MarshalledAssociationAnnouncement);
            if (announcement) {
                announcements.push(announcement);
            }
        }

        ExclusiveStartKey = response.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
    } while (ExclusiveStartKey);

    return announcements.sort((left, right) => {
        if (left.priority !== right.priority) {
            return right.priority - left.priority;
        }
        return left.startsAt.getTime() - right.startsAt.getTime();
    });
}
