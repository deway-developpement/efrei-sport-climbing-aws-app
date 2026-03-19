import { APIGatewayProxyResult } from 'aws-lambda';
import { deleteSession, expireSession, listSessionsExpired } from 'commons/dynamodb.sessions';
import { getSecret } from 'commons/aws.secret';
import { Session } from 'commons/dynamodb.types';
import { deleteAlgoliaRecord } from 'commons/algolia.client';

const SECRET_PATH = 'Efrei-Sport-Climbing-App/secrets/discord_bot_token';
const ALGOLIA_SESSIONS_INDEX = process.env.ALGOLIA_SESSIONS_INDEX || 'esc_sessions';
const DUMMY_RESPONSE: APIGatewayProxyResult = {
    statusCode: 200,
    body: JSON.stringify({
        message: 'ok !',
    }),
};
const CHANNELS: { [key: string]: string } = {
    antrebloc: process.env.ANTREBLOC_CHANNEL as string,
    'climb-up': process.env.CLIMBUP_CHANNEL as string,
    'climb-up-bordeaux': process.env.CLIMBUP_BORDEAUX_CHANNEL as string,
};
const MAX_DELETE_RETRIES = 5;
const DEFAULT_RETRY_AFTER_MS = 2000;

function getChannelId(location: string): string | null {
    return CHANNELS[location] || null;
}

async function deleteAlgoliaSession(sessionId: string): Promise<void> {
    await deleteAlgoliaRecord(ALGOLIA_SESSIONS_INDEX, sessionId).catch((error) => {
        console.error(`Failed to delete Algolia session ${sessionId} during garbage collection`, error);
    });
}

async function cleanupUnsupportedExpiredSession(session: Session): Promise<void> {
    console.warn(`Deleting unsupported expired session ${session.id} at location ${session.location}`);
    await deleteSession(session.id);
    await deleteAlgoliaSession(session.id);
}

async function finalizeExpiredSession(session: Session): Promise<void> {
    await expireSession(session.id);
    await deleteAlgoliaSession(session.id);
}

async function getRetryAfterMs(response: Response): Promise<number> {
    const headerValue = response.headers.get('retry-after') || response.headers.get('x-ratelimit-reset-after');
    if (headerValue) {
        const parsed = Number.parseFloat(headerValue);
        if (Number.isFinite(parsed) && parsed > 0) {
            return Math.ceil(parsed * 1000);
        }
    }

    try {
        const payload = (await response.clone().json()) as { retry_after?: unknown };
        if (typeof payload.retry_after === 'number' && payload.retry_after > 0) {
            return Math.ceil(payload.retry_after * 1000);
        }
    } catch (error) {
        console.warn('Unable to parse retry_after payload from Discord 429 response', error);
    }

    return DEFAULT_RETRY_AFTER_MS;
}

async function deleteDiscordMessageWithRetry(session: Session, discordBotToken: string): Promise<void> {
    const channelId = getChannelId(session.location);
    if (!channelId) {
        await cleanupUnsupportedExpiredSession(session);
        return;
    }

    for (let attempt = 1; attempt <= MAX_DELETE_RETRIES; attempt += 1) {
        const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${session.id}`, {
            method: 'DELETE',
            headers: {
                Authorization: `Bot ${discordBotToken}`,
            },
        });

        if (response.status === 204 || response.status === 404) {
            await finalizeExpiredSession(session);
            return;
        }

        if (response.status === 429) {
            const retryAfterMs = await getRetryAfterMs(response);
            console.warn(
                `Discord rate limited garbage collector for session ${session.id}; retrying in ${retryAfterMs}ms (attempt ${attempt}/${MAX_DELETE_RETRIES})`,
            );
            await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
            continue;
        }

        const body = await response.text();
        throw new Error(`Failed to delete message (status: ${response.status}) ${body}`);
    }

    throw new Error(`Max retries reached for session ${session.id}. Giving up.`);
}

/**
 *
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 *
 */
export const lambdaHandler = async (): Promise<APIGatewayProxyResult> => {
    const sessions = await listSessionsExpired();
    const { DISCORD_BOT_TOKEN } = await getSecret(SECRET_PATH);

    for (const session of sessions) {
        try {
            await deleteDiscordMessageWithRetry(session, DISCORD_BOT_TOKEN);
        } catch (error) {
            console.error(`Error deleting message for session ${session.id}:`, error, 'retrying in next run');
        }
    }

    return DUMMY_RESPONSE;
};
