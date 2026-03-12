import { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { deleteAlgoliaRecord, toAlgoliaUserRecord, upsertAlgoliaRecord } from 'commons/algolia.client';
import { User } from 'commons/dynamodb.types';

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

async function handleRecord(record: DynamoDBRecord): Promise<void> {
    const indexName = requireUsersIndex();
    const eventName = record.eventName;
    const keys = record.dynamodb?.Keys;
    const oldImage = record.dynamodb?.OldImage as Record<string, AttributeValue> | undefined;
    const newImage = record.dynamodb?.NewImage as Record<string, AttributeValue> | undefined;

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
    await upsertAlgoliaRecord(indexName, user.id, toAlgoliaUserRecord(user));
}

export const lambdaHandler = async (event: DynamoDBStreamEvent): Promise<void> => {
    console.log('Algolia users stream batch size:', event.Records.length);
    for (const record of event.Records) {
        await handleRecord(record);
    }
};
