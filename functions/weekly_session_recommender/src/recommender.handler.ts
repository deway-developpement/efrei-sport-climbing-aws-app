import { getSecret } from 'commons/aws.secret';
import {
    buildInitialRecommendationComponents,
    buildInitialRecommendationEmbed,
    buildSessionRecommendationRecord,
    buildSessionRecordCandidates,
    recommendSessionsForUser,
    ScoredSessionRecommendation,
} from 'commons/session.recommendations';
import {
    buildRecommendationSortId,
    getSessionRecommendation,
    listPendingReminderRecommendations,
    putSessionRecommendation,
    updateSessionRecommendationState,
} from 'commons/dynamodb.session_recommendations';
import { listSessionUnexpired } from 'commons/dynamodb.sessions';
import { listUserStats } from 'commons/dynamodb.user_stats';
import { SessionRecommendation, User, UserStats } from 'commons/dynamodb.types';
import { listUsers } from 'commons/dynamodb.users';

const DISCORD_BOT_TOKEN_SECRET_PATH = 'Efrei-Sport-Climbing-App/secrets/discord_bot_token';
const WEEKLY_RECOMMENDER_TARGET_USER_ID = process.env.WEEKLY_RECOMMENDER_TARGET_USER_ID;

type DiscordSecret = {
    DISCORD_BOT_TOKEN: string;
};

type DiscordChannel = {
    id: string;
};

type DiscordMessage = {
    id: string;
    channel_id: string;
};

function isEligibleForWeeklyRecommendation(userStats: UserStats): boolean {
    return userStats.activityStatus !== 'inactive' || userStats.sessionsLast90Days > 0;
}

async function getDiscordBotToken(): Promise<string> {
    const secret = (await getSecret(DISCORD_BOT_TOKEN_SECRET_PATH)) as DiscordSecret | undefined;
    if (!secret?.DISCORD_BOT_TOKEN) {
        throw new Error('Missing DISCORD_BOT_TOKEN');
    }
    return secret.DISCORD_BOT_TOKEN;
}

async function createDmChannel(recipientId: string, botToken: string): Promise<DiscordChannel> {
    const response = await fetch('https://discord.com/api/v8/users/@me/channels', {
        method: 'POST',
        headers: {
            Authorization: `Bot ${botToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ recipient_id: recipientId }),
    });
    if (!response.ok) {
        throw new Error(`Failed to create DM channel for ${recipientId}: ${response.statusText}`);
    }
    return (await response.json()) as DiscordChannel;
}

async function sendRecommendationDm(channelId: string, message: unknown, botToken: string): Promise<DiscordMessage> {
    const response = await fetch(`https://discord.com/api/v8/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
            Authorization: `Bot ${botToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
    });
    if (!response.ok) {
        throw new Error(`Failed to send recommendation DM: ${response.statusText}`);
    }
    return (await response.json()) as DiscordMessage;
}

async function sendDirectMessage(recipientId: string, message: unknown, botToken: string): Promise<DiscordMessage> {
    const dmChannel = await createDmChannel(recipientId, botToken);
    return sendRecommendationDm(dmChannel.id, message, botToken);
}

function getCampaignId(now: Date): string {
    return `w${now.toISOString().slice(2, 10).replace(/-/g, '')}`;
}

function buildReminderPayload(
    recommendation: SessionRecommendation,
    scoredRecommendation: ScoredSessionRecommendation,
): {
    content: string;
    embeds: ReturnType<typeof buildInitialRecommendationEmbed>[];
    components: ReturnType<typeof buildInitialRecommendationComponents>;
} {
    return {
        content: 'Petit rappel: cette séance peut toujours vous intéresser.',
        embeds: [buildInitialRecommendationEmbed(scoredRecommendation)],
        components: buildInitialRecommendationComponents(recommendation.campaignId, recommendation.sessionId),
    };
}

export async function runWeeklySessionRecommender(now: Date = new Date()): Promise<void> {
    const [users, userStats, sessions, botToken] = await Promise.all([
        listUsers(),
        listUserStats(),
        listSessionUnexpired(),
        getDiscordBotToken(),
    ]);
    const statsByUserId = new Map<string, UserStats>(userStats.map((stats) => [stats.userId, stats]));
    const sessionCandidates = buildSessionRecordCandidates(sessions, now);
    const campaignId = getCampaignId(now);

    for (const user of users) {
        if (WEEKLY_RECOMMENDER_TARGET_USER_ID && user.id !== WEEKLY_RECOMMENDER_TARGET_USER_ID) {
            continue;
        }
        const stats = statsByUserId.get(user.id);
        if (!stats || !isEligibleForWeeklyRecommendation(stats)) {
            continue;
        }
        const recommendations = recommendSessionsForUser(user, stats, sessionCandidates, 4);
        if (recommendations.length === 0) {
            continue;
        }

        let selectedRecommendation: ScoredSessionRecommendation | undefined;
        for (const recommendation of recommendations) {
            const existing = await getSessionRecommendation(user.id, buildRecommendationSortId(campaignId, recommendation.session.id));
            if (!existing) {
                selectedRecommendation = recommendation;
                break;
            }
        }
        if (!selectedRecommendation) {
            continue;
        }
        const recommendationToSend = selectedRecommendation;
        const sortId = buildRecommendationSortId(campaignId, recommendationToSend.session.id);

        const recommendationRecord = buildSessionRecommendationRecord({
            userId: user.id,
            campaignId,
            recommendation: recommendationToSend,
            similarSessionIds: recommendations
                .filter((item) => item.session.id !== recommendationToSend.session.id)
                .slice(0, 3)
                .map((item) => item.session.id),
            recommendedAt: now,
        });

        try {
            const dmChannel = await createDmChannel(user.id, botToken);
            const sentMessage = await sendRecommendationDm(
                dmChannel.id,
                {
                    content: `Salut ${user.firstName}, voici une recommandation de séance pour la semaine à venir.`,
                    embeds: [buildInitialRecommendationEmbed(recommendationToSend)],
                    components: buildInitialRecommendationComponents(campaignId, recommendationToSend.session.id),
                },
                botToken,
            );
            recommendationRecord.deliveryChannelId = dmChannel.id;
            recommendationRecord.deliveryMessageId = sentMessage.id;
            await putSessionRecommendation(recommendationRecord);
        } catch (error) {
            console.error(`Failed to send recommendation to ${user.id}`, error);
            recommendationRecord.deliveryStatus = 'failed';
            await putSessionRecommendation(recommendationRecord);
            await updateSessionRecommendationState(user.id, sortId, 'sent', {
                deliveryStatus: 'failed',
            });
        }
    }
}

export async function runPendingRecommendationReminders(now: Date = new Date()): Promise<void> {
    const [pendingRecommendations, sessions, botToken] = await Promise.all([
        listPendingReminderRecommendations(now),
        listSessionUnexpired(),
        getDiscordBotToken(),
    ]);
    const sessionCandidates = buildSessionRecordCandidates(sessions, now);
    const sessionsById = new Map(sessionCandidates.map((session) => [session.id, session]));

    for (const recommendation of pendingRecommendations) {
        const session = sessionsById.get(recommendation.sessionId);
        if (!session || !session.isUpcoming) {
            await updateSessionRecommendationState(recommendation.userId, recommendation.sortId, 'dismissed', {
                dismissedAt: now,
                remindAt: null,
            });
            continue;
        }
        if (session.participantIds.includes(recommendation.userId)) {
            await updateSessionRecommendationState(recommendation.userId, recommendation.sortId, 'joined', {
                joinedAt: now,
                remindAt: null,
            });
            continue;
        }

        const scoredRecommendation: ScoredSessionRecommendation = {
            session,
            score: recommendation.score,
            reasons: recommendation.reasons,
        };

        try {
            const sentMessage = await sendDirectMessage(
                recommendation.userId,
                buildReminderPayload(recommendation, scoredRecommendation),
                botToken,
            );
            await updateSessionRecommendationState(recommendation.userId, recommendation.sortId, 'sent', {
                remindAt: null,
                deliveryChannelId: sentMessage.channel_id,
                deliveryMessageId: sentMessage.id,
                deliveryStatus: 'sent',
            });
        } catch (error) {
            console.error(`Failed to send reminder to ${recommendation.userId}`, error);
            await updateSessionRecommendationState(recommendation.userId, recommendation.sortId, 'remind_requested', {
                remindAt: new Date(now.getTime() + 60 * 60 * 1000),
                deliveryStatus: 'failed',
            });
        }
    }
}
