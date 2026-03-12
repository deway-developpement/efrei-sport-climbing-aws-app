import { getSecret } from './aws.secret';
import { User } from './dynamodb.types';

const ALGOLIA_SECRET_PATH = process.env.ALGOLIA_SECRET_PATH as string;

type AlgoliaCredentials = {
    ALGOLIA_APP_ID: string;
    ALGOLIA_ADMIN_API_KEY: string;
};

export type AlgoliaUserRecord = User & {
    objectID: string;
    fullName: string;
};

async function getAlgoliaCredentials(): Promise<AlgoliaCredentials> {
    if (!ALGOLIA_SECRET_PATH) {
        throw new Error('Missing ALGOLIA_SECRET_PATH environment variable');
    }
    const secret = (await getSecret(ALGOLIA_SECRET_PATH)) as AlgoliaCredentials | undefined;
    if (!secret?.ALGOLIA_APP_ID || !secret?.ALGOLIA_ADMIN_API_KEY) {
        throw new Error('Missing Algolia credentials in Secrets Manager');
    }
    return secret;
}

async function createRequestConfig(indexName: string): Promise<{ headers: Record<string, string>; indexUrl: string }> {
    const { ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY } = await getAlgoliaCredentials();
    return {
        indexUrl: `https://${encodeURIComponent(ALGOLIA_APP_ID)}-dsn.algolia.net/1/indexes/${encodeURIComponent(
            indexName,
        )}`,
        headers: {
            'Content-Type': 'application/json',
            'X-Algolia-API-Key': ALGOLIA_ADMIN_API_KEY,
            'X-Algolia-Application-Id': ALGOLIA_APP_ID,
        },
    };
}

async function assertAlgoliaResponse(response: Response, context: string): Promise<void> {
    if (response.ok) {
        return;
    }
    const body = await response.text();
    throw new Error(`Algolia ${context} failed: ${response.status} ${response.statusText} - ${body}`);
}

export function toAlgoliaUserRecord(user: User): AlgoliaUserRecord {
    return {
        objectID: user.id,
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        promo: user.promo,
        fullName: `${user.firstName} ${user.lastName}`.trim(),
    };
}

export async function upsertAlgoliaRecord(indexName: string, objectID: string, payload: unknown): Promise<void> {
    const { headers, indexUrl } = await createRequestConfig(indexName);
    const response = await fetch(`${indexUrl}/${encodeURIComponent(objectID)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload),
    });
    await assertAlgoliaResponse(response, `upsert for ${indexName}/${objectID}`);
}

export async function deleteAlgoliaRecord(indexName: string, objectID: string): Promise<void> {
    const { headers, indexUrl } = await createRequestConfig(indexName);
    const response = await fetch(`${indexUrl}/${encodeURIComponent(objectID)}`, {
        method: 'DELETE',
        headers,
    });
    await assertAlgoliaResponse(response, `delete for ${indexName}/${objectID}`);
}
