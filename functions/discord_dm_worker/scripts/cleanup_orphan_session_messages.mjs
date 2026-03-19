import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const REGION = process.env.AWS_REGION || 'eu-west-3';
const SESSION_TABLE = 'Efrei-Sport-Climbing-App.sessions';
const ALGOLIA_INDEX = process.env.ALGOLIA_SESSIONS_INDEX || 'esc_sessions';
const DISCORD_BOT_TOKEN_SECRET_PATH =
    process.env.DISCORD_BOT_TOKEN_SECRET_PATH || 'Efrei-Sport-Climbing-App/secrets/discord_bot_token';
const ALGOLIA_SECRET_PATH = process.env.ALGOLIA_SECRET_PATH || 'Efrei-Sport-Climbing-App/secrets/algolia';
const CHANNELS = {
    antrebloc: process.env.ANTREBLOC_CHANNEL || '1371521997594689547',
    'climb-up': process.env.CLIMBUP_CHANNEL || '1371522019254075412',
    'climb-up-bordeaux': process.env.CLIMBUP_BORDEAUX_CHANNEL || '1371522048303562872',
};

const deleteMode = process.argv.includes('--delete');

const secrets = new SecretsManagerClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });

async function getSecret(secretId) {
    const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
    return JSON.parse(response.SecretString || '{}');
}

async function assertOk(response, context) {
    if (response.ok) {
        return;
    }
    const body = await response.text();
    throw new Error(`${context} failed: ${response.status} ${response.statusText} - ${body}`);
}

async function loadSessionIds() {
    const sessionIds = new Set();
    let exclusiveStartKey;
    do {
        const response = await ddb.send(
            new ScanCommand({
                TableName: SESSION_TABLE,
                ProjectionExpression: '#id, #sortId',
                FilterExpression: '#id = #sortId',
                ExpressionAttributeNames: {
                    '#id': 'id',
                    '#sortId': 'sortId',
                },
                ExclusiveStartKey: exclusiveStartKey,
            }),
        );
        for (const item of response.Items || []) {
            if (item.id?.S) {
                sessionIds.add(item.id.S);
            }
        }
        exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return sessionIds;
}

async function loadAlgoliaSessionIds(credentials) {
    const ids = new Set();
    let cursor = null;
    do {
        const response = await fetch(
            `https://${encodeURIComponent(credentials.ALGOLIA_APP_ID)}-dsn.algolia.net/1/indexes/${encodeURIComponent(ALGOLIA_INDEX)}/browse`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Algolia-API-Key': credentials.ALGOLIA_ADMIN_API_KEY,
                    'X-Algolia-Application-Id': credentials.ALGOLIA_APP_ID,
                },
                body: JSON.stringify(cursor ? { cursor } : { attributesToRetrieve: ['objectID'] }),
            },
        );
        await assertOk(response, 'Algolia browse');
        const payload = await response.json();
        for (const hit of payload.hits || []) {
            if (hit.objectID) {
                ids.add(String(hit.objectID));
            }
        }
        cursor = payload.cursor || null;
    } while (cursor);
    return ids;
}

function isLikelySessionMessage(message) {
    return Boolean(message.author?.bot) && ((message.embeds || []).length > 0 || (message.components || []).length > 0);
}

async function listChannelMessages(channelId, botToken) {
    const messages = [];
    let before = null;
    while (true) {
        const query = new URLSearchParams({ limit: '100' });
        if (before) {
            query.set('before', before);
        }
        const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?${query.toString()}`, {
            headers: {
                Authorization: `Bot ${botToken}`,
            },
        });
        await assertOk(response, `Discord list messages for channel ${channelId}`);
        const payload = await response.json();
        if (!Array.isArray(payload) || payload.length === 0) {
            break;
        }
        messages.push(...payload);
        before = payload[payload.length - 1].id;
        if (payload.length < 100) {
            break;
        }
    }
    return messages;
}

async function deleteDiscordMessage(channelId, messageId, botToken) {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
        method: 'DELETE',
        headers: {
            Authorization: `Bot ${botToken}`,
        },
    });
    await assertOk(response, `Discord delete message ${messageId}`);
}

async function main() {
    const [{ DISCORD_BOT_TOKEN }, algoliaCredentials] = await Promise.all([
        getSecret(DISCORD_BOT_TOKEN_SECRET_PATH),
        getSecret(ALGOLIA_SECRET_PATH),
    ]);

    const [ddbSessionIds, algoliaIds] = await Promise.all([loadSessionIds(), loadAlgoliaSessionIds(algoliaCredentials)]);

    const orphans = [];
    for (const [location, channelId] of Object.entries(CHANNELS)) {
        const messages = await listChannelMessages(channelId, DISCORD_BOT_TOKEN);
        for (const message of messages) {
            if (!isLikelySessionMessage(message)) {
                continue;
            }
            const missingInDdb = !ddbSessionIds.has(message.id);
            const missingInAlgolia = !algoliaIds.has(message.id);
            if (!missingInDdb && !missingInAlgolia) {
                continue;
            }
            orphans.push({
                id: message.id,
                channel: location,
                missingInDdb,
                missingInAlgolia,
                embeds: (message.embeds || []).length,
                components: (message.components || []).length,
                contentPreview: (message.content || '').slice(0, 120),
                titlePreview: message.embeds?.[0]?.title || null,
            });
        }
    }

    if (!deleteMode) {
        console.log(
            JSON.stringify(
                {
                    deleteMode: false,
                    orphanCount: orphans.length,
                    orphans,
                },
                null,
                2,
            ),
        );
        return;
    }

    for (const orphan of orphans) {
        await deleteDiscordMessage(CHANNELS[orphan.channel], orphan.id, DISCORD_BOT_TOKEN);
    }

    console.log(
        JSON.stringify(
            {
                deleteMode: true,
                deletedCount: orphans.length,
                deleted: orphans,
            },
            null,
            2,
        ),
    );
}

await main();
