import { getSecret } from './aws.secret';

const ALGOLIA_SECRET_PATH = process.env.ALGOLIA_SECRET_PATH as string;
const DEFAULT_ALGOLIA_SESSIONS_INDEX = process.env.ALGOLIA_SESSIONS_INDEX || 'esc_sessions';

type AlgoliaCredentials = {
    ALGOLIA_APP_ID: string;
    ALGOLIA_ADMIN_API_KEY: string;
};

type AlgoliaInsightsEvent = {
    eventType: 'click' | 'conversion';
    eventName: string;
    index: string;
    userToken: string;
    objectIDs: string[];
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

async function sendInsightsEvents(events: AlgoliaInsightsEvent[]): Promise<void> {
    if (events.length === 0) {
        return;
    }
    const { ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY } = await getAlgoliaCredentials();
    const response = await fetch(`https://insights.algolia.io/1/events`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Algolia-API-Key': ALGOLIA_ADMIN_API_KEY,
            'X-Algolia-Application-Id': ALGOLIA_APP_ID,
        },
        body: JSON.stringify({ events }),
    });
    if (!response.ok) {
        throw new Error(`Algolia insights failed: ${response.status} ${response.statusText} - ${await response.text()}`);
    }
}

export async function sendAlgoliaSessionClickEvent(
    eventName: string,
    userToken: string,
    sessionId: string,
    indexName: string = DEFAULT_ALGOLIA_SESSIONS_INDEX,
): Promise<void> {
    await sendInsightsEvents([
        {
            eventType: 'click',
            eventName,
            index: indexName,
            userToken,
            objectIDs: [sessionId],
        },
    ]);
}

export async function sendAlgoliaSessionConversionEvent(
    eventName: string,
    userToken: string,
    sessionId: string,
    indexName: string = DEFAULT_ALGOLIA_SESSIONS_INDEX,
): Promise<void> {
    await sendInsightsEvents([
        {
            eventType: 'conversion',
            eventName,
            index: indexName,
            userToken,
            objectIDs: [sessionId],
        },
    ]);
}
