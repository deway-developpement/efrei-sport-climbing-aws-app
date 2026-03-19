import { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { deleteAlgoliaRecord, toAlgoliaUserRecord, upsertAlgoliaRecord } from 'commons/algolia.client';
import { User } from 'commons/dynamodb.types';
import { getUserStats } from 'commons/dynamodb.user_stats';
import { getUser } from 'commons/dynamodb.users';

const ALGOLIA_USERS_INDEX = process.env.ALGOLIA_USERS_INDEX as string;

type AttributeValue = {
    S?: string;
    N?: string;
    BOOL?: boolean;
};

function requireUsersIndex(): string {
    if (!ALGOLIA_USERS_INDEX) {
        throw new Error('Missing ALGOLIA_USERS_INDEX environment variable');
    }
    return ALGOLIA_USERS_INDEX;
}

function unmarshallUser(image?: Record<string, AttributeValue>): User | null {
    if (!image?.id?.S || !image.firstName?.S || !image.lastName?.S || !image.promo?.S) {
        return null;
    }
    return {
        id: image.id.S,
        firstName: image.firstName.S,
        lastName: image.lastName.S,
        promo: image.promo.S,
    };
}

function isUserStatsRecord(record: DynamoDBRecord): boolean {
    return Boolean(record.dynamodb?.Keys?.userId?.S || record.dynamodb?.NewImage?.userId?.S || record.dynamodb?.OldImage?.userId?.S);
}

async function upsertEnrichedUser(indexName: string, userId: string): Promise<void> {
    let user: User | undefined;
    try {
        user = await getUser(userId);
    } catch (error) {
        console.log(`Skipping Algolia reindex for missing user ${userId}`, error instanceof Error ? error.message : error);
        return;
    }
    const userStats = await getUserStats(user.id);
    await upsertAlgoliaRecord(indexName, user.id, toAlgoliaUserRecord(user, userStats));
}

async function handleRecord(record: DynamoDBRecord): Promise<void> {
    const indexName = requireUsersIndex();
    const eventName = record.eventName;
    const keys = record.dynamodb?.Keys;
    const oldImage = record.dynamodb?.OldImage as Record<string, AttributeValue> | undefined;
    const newImage = record.dynamodb?.NewImage as Record<string, AttributeValue> | undefined;

    if (isUserStatsRecord(record)) {
        const userId = keys?.userId?.S || newImage?.userId?.S || oldImage?.userId?.S;
        if (!userId) {
            console.log('Skipping UserStats stream event without userId', JSON.stringify(record));
            return;
        }
        await upsertEnrichedUser(indexName, userId);
        return;
    }

    if (eventName === 'REMOVE') {
        const objectID = keys?.id?.S || oldImage?.id?.S;
        if (!objectID) {
            console.log('Skipping REMOVE event without id', JSON.stringify(record));
            return;
        }
        await deleteAlgoliaRecord(indexName, objectID);
        return;
    }

    const user = unmarshallUser(newImage);
    if (!user) {
        console.log('Skipping non-user stream image', JSON.stringify(record));
        return;
    }
    await upsertEnrichedUser(indexName, user.id);
}

export const lambdaHandler = async (event: DynamoDBStreamEvent): Promise<void> => {
    console.log('Algolia users stream batch size:', event.Records.length);
    for (const record of event.Records) {
        try {
            await handleRecord(record);
        } catch (error) {
            console.error('Failed to process stream record', JSON.stringify(record.dynamodb?.Keys), error);
        }
    }
};
