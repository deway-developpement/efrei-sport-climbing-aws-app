import { getSecret } from './aws.secret';
import { deleteAlgoliaRecord, toAlgoliaSessionRecord, upsertAlgoliaRecord } from './algolia.client';
import { sendAlgoliaSessionConversionEvent } from './algolia.insights';
import {
    addUserToSession,
    countParticipants,
    deleteSession,
    findSession,
    getSession,
    listSessionParticipantIds,
    putSession,
    removeUserFromSession,
} from './dynamodb.sessions';
import { getSessionUrl } from './session.recommendations';
import { getS3Blob } from './s3.files';
import { User, Session } from './dynamodb.types';
import { DiscordActionRow, DiscordButton, DiscordButtonStyle, DiscordComponentType, DiscordEmbed, DiscordMessage, DiscordMessagePost } from './discord.types';
import { findLatestRecommendationForUserSession, updateSessionRecommendationState } from './dynamodb.session_recommendations';
import { getUser } from './dynamodb.users';

const DISCORD_BOT_TOKEN_SECRET_PATH =
    process.env.DISCORD_BOT_TOKEN_SECRET_PATH || 'Efrei-Sport-Climbing-App/secrets/discord_bot_token';
const ALGOLIA_SESSIONS_INDEX = process.env.ALGOLIA_SESSIONS_INDEX || 'esc_sessions';
const CHANNELS: { [key: string]: string } = {
    antrebloc: process.env.ANTREBLOC_CHANNEL as string,
    'climb-up': process.env.CLIMBUP_CHANNEL as string,
    'climb-up-bordeaux': process.env.CLIMBUP_BORDEAUX_CHANNEL as string,
};

type DiscordSecret = {
    DISCORD_BOT_TOKEN: string;
};

export type SessionAuthorMeta = {
    authorName?: string;
    authorIconUrl?: string;
    authorUrl?: string;
};

export type SessionWorkflowResult = {
    action: 'created' | 'joined' | 'left' | 'deleted';
    session: Session;
    response: DiscordMessagePost;
    sessionUrl: string | null;
};

async function syncAlgoliaSessionRecord(session: Session): Promise<void> {
    const participantIds = await listSessionParticipantIds(session.id);
    const users = await Promise.all(
        participantIds.map(async (participantId) => {
            try {
                return await getUser(participantId);
            } catch (error) {
                console.warn(`Failed to load participant ${participantId} for session ${session.id} Algolia sync`, error);
                return undefined;
            }
        }),
    );
    const participants = users.filter((user): user is User => user !== undefined);
    await upsertAlgoliaRecord(ALGOLIA_SESSIONS_INDEX, session.id, toAlgoliaSessionRecord(session, participants));
}

async function getDiscordBotToken(): Promise<string> {
    const secret = (await getSecret(DISCORD_BOT_TOKEN_SECRET_PATH)) as DiscordSecret | undefined;
    if (!secret?.DISCORD_BOT_TOKEN) {
        throw new Error('Missing DISCORD_BOT_TOKEN');
    }
    return secret.DISCORD_BOT_TOKEN;
}

function buildSessionMessage(user: User, session: Session, author?: SessionAuthorMeta): DiscordMessagePost {
    const joinButton: DiscordButton = {
        type: DiscordComponentType.Button,
        style: DiscordButtonStyle.Primary,
        label: 'Rejoindre',
        custom_id: 'register',
    };
    const leaveButton: DiscordButton = {
        type: DiscordComponentType.Button,
        style: DiscordButtonStyle.Danger,
        label: 'Se désinscrire',
        custom_id: 'leave',
    };
    const actionRow: DiscordActionRow = {
        type: DiscordComponentType.ActionRow,
        components: [joinButton, leaveButton],
    };

    const embed: DiscordEmbed = {
        title: session.date.toLocaleDateString('fr-FR', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
        }),
        description: `Séance de grimpe à **${session.location.charAt(0).toUpperCase() + session.location.slice(1)}**.`,
        fields: [
            {
                name: 'Participants :',
                value: `- ${user.firstName} ${user.lastName}\n`,
                inline: false,
            },
        ],
        color: 15844367,
        thumbnail: {
            url: `attachment://${session.location}.png`,
        },
    };

    if (author?.authorName) {
        embed.author = {
            name: author.authorName,
            icon_url: author.authorIconUrl,
            url: author.authorUrl,
        };
    }

    return {
        embeds: [embed],
        components: [actionRow],
        attachments: [
            {
                filename: `${session.location}.png`,
                id: '0',
                description: 'image',
            },
        ],
    };
}

async function fetchDiscordMessage(channelId: string, messageId: string, botToken: string): Promise<DiscordMessage> {
    const response = await fetch(`https://discord.com/api/v8/channels/${channelId}/messages/${messageId}`, {
        method: 'GET',
        headers: {
            Authorization: `Bot ${botToken}`,
        },
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch Discord message ${messageId}: ${response.statusText}`);
    }
    return (await response.json()) as DiscordMessage;
}

async function patchDiscordMessage(
    channelId: string,
    messageId: string,
    payload: Partial<DiscordMessagePost>,
    botToken: string,
): Promise<void> {
    const response = await fetch(`https://discord.com/api/v8/channels/${channelId}/messages/${messageId}`, {
        method: 'PATCH',
        headers: {
            Authorization: `Bot ${botToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        throw new Error(`Failed to patch Discord message ${messageId}: ${response.statusText}`);
    }
}

function getParticipantsField(message: DiscordMessage): { embed: DiscordEmbed; fieldValue: string } {
    const embed = message.embeds[0];
    if (!embed) {
        throw new Error('Session message embed not found');
    }
    const field = embed.fields?.find((item) => item.name === 'Participants :');
    if (!field?.value) {
        throw new Error('Participants field not found');
    }
    return { embed, fieldValue: field.value };
}

export async function createSessionWorkflow(
    user: User,
    date: Date,
    location: string,
    author?: SessionAuthorMeta,
): Promise<SessionWorkflowResult> {
    const botToken = await getDiscordBotToken();
    const sessionMessage = buildSessionMessage(
        user,
        {
            id: '',
            date,
            location,
        },
        author,
    );
    const formData = new FormData();
    formData.append('payload_json', JSON.stringify(sessionMessage));
    formData.append('files[0]', await getS3Blob(`images/${location}.png`), `${location}.png`);

    const response = await fetch(`https://discord.com/api/v8/channels/${CHANNELS[location]}/messages`, {
        method: 'POST',
        headers: {
            Authorization: `Bot ${botToken}`,
        },
        body: formData,
    });
    if (!response.ok) {
        throw new Error(`Failed to create Discord session message: ${response.statusText}`);
    }
    const discordMessage = (await response.json()) as DiscordMessage;
    const session = {
        id: discordMessage.id,
        date,
        location,
    };

    await putSession(session, [user.id]);
    await syncAlgoliaSessionRecord(session).catch((error) => {
        console.error('Failed to upsert Algolia session after creation', error);
    });

    const dayString = date.toLocaleDateString('fr-FR', { weekday: 'long' });
    const hourString = date.toLocaleTimeString('fr-FR', { hour: 'numeric' });

    return {
        action: 'created',
        session,
        response: {
            content: `Ajout d'une séance de grimpe à **${
                location.charAt(0).toUpperCase() + location.slice(1)
            }** le **${dayString}** à **${hourString}**.`,
        },
        sessionUrl: getSessionUrl(session),
    };
}

export async function joinSessionWorkflow(user: User, sessionId: string): Promise<SessionWorkflowResult> {
    const botToken = await getDiscordBotToken();

    try {
        await addUserToSession(sessionId, user.id);
    } catch (error) {
        return {
            action: 'joined',
            session: await getSession(sessionId),
            response: { content: '-# Vous êtes déjà inscrit à cette séance.' },
            sessionUrl: getSessionUrl(await getSession(sessionId)),
        };
    }

    const session = await getSession(sessionId);
    const channelId = CHANNELS[session.location];
    const message = await fetchDiscordMessage(channelId, sessionId, botToken);
    const { embed, fieldValue } = getParticipantsField(message);
    const nextValue = `${fieldValue}\n- ${user.firstName} ${user.lastName}\n`.replace(/\n\n+/g, '\n');
    const field = embed.fields?.find((item) => item.name === 'Participants :');
    if (!field) {
        throw new Error('Participants field not found for join');
    }
    field.value = nextValue;
    embed.thumbnail = { url: `attachment://${session.location}.png` };

    await patchDiscordMessage(channelId, sessionId, { embeds: [embed] }, botToken);
    await syncAlgoliaSessionRecord(session).catch((error) => {
        console.error('Failed to sync Algolia session after join', error);
    });

    await sendAlgoliaSessionConversionEvent('Session Joined', user.id, session.id).catch((error) => {
        console.error('Failed to send generic Algolia conversion event', error);
    });
    const latestRecommendation = await findLatestRecommendationForUserSession(user.id, session.id).catch((error) => {
        console.error('Failed to load latest recommendation for conversion attribution', error);
        return undefined;
    });
    if (latestRecommendation && !latestRecommendation.algoliaConversionSent) {
        await sendAlgoliaSessionConversionEvent('Session Joined After Recommendation', user.id, session.id).catch(
            (error) => {
                console.error('Failed to send attributed Algolia conversion event', error);
            },
        );
        await updateSessionRecommendationState(user.id, latestRecommendation.sortId, 'joined', {
            joinedAt: new Date(),
            algoliaConversionSent: true,
        }).catch((error) => {
            console.error('Failed to update recommendation conversion state', error);
        });
    }

    return {
        action: 'joined',
        session,
        response: { content: '-# Vous avez été ajouté à la séance.' },
        sessionUrl: getSessionUrl(session),
    };
}

export async function leaveSessionWorkflow(user: User, sessionId: string): Promise<SessionWorkflowResult> {
    const botToken = await getDiscordBotToken();
    try {
        await removeUserFromSession(sessionId, user.id);
    } catch (error) {
        return {
            action: 'left',
            session: await getSession(sessionId),
            response: { content: "-# Vous n'êtes pas inscrit à cette séance." },
            sessionUrl: getSessionUrl(await getSession(sessionId)),
        };
    }

    const session = await getSession(sessionId);
    const channelId = CHANNELS[session.location];
    const nbParticipants = await countParticipants(sessionId);

    if (nbParticipants === 0) {
        await deleteSession(sessionId);
        await deleteAlgoliaRecord(ALGOLIA_SESSIONS_INDEX, sessionId).catch((error) => {
            console.error('Failed to delete Algolia session after session removal', error);
        });
        await fetch(`https://discord.com/api/v8/channels/${channelId}/messages/${sessionId}`, {
            method: 'DELETE',
            headers: {
                Authorization: `Bot ${botToken}`,
            },
        });
        return {
            action: 'deleted',
            session,
            response: { content: '-# La séance a été supprimée.' },
            sessionUrl: null,
        };
    }

    const message = await fetchDiscordMessage(channelId, sessionId, botToken);
    const { embed, fieldValue } = getParticipantsField(message);
    const field = embed.fields?.find((item) => item.name === 'Participants :');
    if (!field) {
        throw new Error('Participants field not found for leave');
    }
    field.value = fieldValue
        .replace(`- ${user.firstName} ${user.lastName}`, '')
        .replace(/\n\n+/g, '\n')
        .trimEnd()
        .concat('\n');
    embed.thumbnail = { url: `attachment://${session.location}.png` };
    await patchDiscordMessage(channelId, sessionId, { embeds: [embed] }, botToken);
    await syncAlgoliaSessionRecord(session).catch((error) => {
        console.error('Failed to sync Algolia session after leave', error);
    });

    return {
        action: 'left',
        session,
        response: { content: '-# Vous avez été retiré de la séance.' },
        sessionUrl: getSessionUrl(session),
    };
}

export async function createOrJoinSessionWorkflow(
    user: User,
    date: Date,
    location: string,
    author?: SessionAuthorMeta,
): Promise<SessionWorkflowResult> {
    const existingSession = await findSession(date, location).catch(() => undefined);
    if (existingSession) {
        return joinSessionWorkflow(user, existingSession.id);
    }
    return createSessionWorkflow(user, date, location, author);
}
