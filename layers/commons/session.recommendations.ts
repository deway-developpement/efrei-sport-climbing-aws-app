import { DiscordActionRow, DiscordButton, DiscordButtonStyle, DiscordComponent, DiscordComponentType, DiscordEmbed } from './discord.types';
import {
    AlgoliaSessionRecord,
    RecommendationFeedback,
    RecommendationState,
    Session,
    SessionRecommendation,
    User,
    UserStats,
} from './dynamodb.types';
import { buildCoAttendanceCounts, toAlgoliaSessionRecord } from './algolia.client';

const CHANNELS: { [key: string]: string } = {
    antrebloc: process.env.ANTREBLOC_CHANNEL as string,
    'climb-up': process.env.CLIMBUP_CHANNEL as string,
    'climb-up-bordeaux': process.env.CLIMBUP_BORDEAUX_CHANNEL as string,
};

export type ScoredSessionRecommendation = {
    session: AlgoliaSessionRecord;
    score: number;
    reasons: string[];
};

export function buildCampaignId(now: Date = new Date()): string {
    return `weekly-${now.toISOString().slice(0, 10)}`;
}

export function buildCompactCampaignToken(campaignId: string): string {
    const datePart = campaignId.replace('weekly-', '').replace(/-/g, '').slice(2);
    return `w${datePart}`;
}

export function parseRecommendationCustomId(customId: string): { action: string; campaignId: string; sessionId: string } | null {
    const [action, encodedPayload] = customId.split('=');
    if (!action || !encodedPayload) {
        return null;
    }
    const [campaignId, sessionId] = encodedPayload.split(':');
    if (!campaignId || !sessionId) {
        return null;
    }
    return { action, campaignId, sessionId };
}

export function buildRecommendationCustomId(
    action: 'rec_more' | 'rec_remind' | 'rec_similar' | 'rec_nope' | 'rec_back' | 'rec_pick',
    campaignId: string,
    sessionId: string,
): string {
    return `${action}=${campaignId}:${sessionId}`;
}

export function buildSessionUrl(session: Pick<Session, 'id' | 'location'>): string {
    const channelId = CHANNELS[session.location];
    if (!channelId) {
        throw new Error(`Unknown Discord channel for session location ${session.location}`);
    }
    return `https://discord.com/channels/${process.env.GUILD_ID}/${channelId}/${session.id}`;
}

export function getSessionUrl(session: Pick<Session, 'id' | 'location'>): string | null {
    const channelId = CHANNELS[session.location];
    if (!channelId) {
        return null;
    }
    return `https://discord.com/channels/${process.env.GUILD_ID}/${channelId}/${session.id}`;
}

export function buildSessionRecordCandidates(sessions: Session[], now: Date = new Date()): AlgoliaSessionRecord[] {
    const participantIdsBySession = new Map<string, string[]>();
    for (const session of sessions) {
        if (session.participants && session.participants.length > 0) {
            participantIdsBySession.set(session.id, session.participants.map((p) => p.id));
        }
    }
    const coAttendanceCounts = buildCoAttendanceCounts(participantIdsBySession);

    return sessions
        .filter((session) => session.date >= now)
        .map((session) => toAlgoliaSessionRecord(session, session.participants || [], now, coAttendanceCounts))
        .sort((left, right) => left.timestamp - right.timestamp);
}

export function scoreSessionRecommendation(
    user: User,
    userStats: UserStats,
    session: AlgoliaSessionRecord,
): ScoredSessionRecommendation {
    let score = 0;
    const reasons: string[] = [];

    if (userStats.favoriteLocation && session.location === userStats.favoriteLocation) {
        score += 50;
        reasons.push('favorite_location');
    }
    if (userStats.preferredDayOfWeek && session.weekday === userStats.preferredDayOfWeek) {
        score += 35;
        reasons.push('preferred_day');
    }
    if (user.promo && session.participantPromos.includes(user.promo)) {
        score += 15;
        reasons.push('promo_overlap');
    }
    if (session.repeatParticipantIds.length > 0) {
        score += 10;
        reasons.push('regular_group');
    }
    if (userStats.activityStatus === 'power_user' && session.activityLevel !== 'small') {
        score += 8;
        reasons.push('high_energy_match');
    }
    if ((userStats.activityStatus === 'new' || userStats.activityStatus === 'inactive') && session.activityLevel === 'small') {
        score += 4;
        reasons.push('easy_join');
    }
    score += Math.min(session.participantCount, 12);

    return { session, score, reasons };
}

export function recommendSessionsForUser(
    user: User,
    userStats: UserStats,
    sessions: AlgoliaSessionRecord[],
    limit = 5,
): ScoredSessionRecommendation[] {
    return sessions
        .filter((session) => session.isUpcoming && !session.participantIds.includes(user.id))
        .map((session) => scoreSessionRecommendation(user, userStats, session))
        .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }
            return left.session.timestamp - right.session.timestamp;
        })
        .slice(0, limit);
}

function formatRecommendationReasons(reasons: string[]): string[] {
    return reasons.map((reason) => {
        switch (reason) {
            case 'favorite_location':
                return 'Vous grimpez souvent ici';
            case 'preferred_day':
                return 'Le jour correspond à votre habitude';
            case 'promo_overlap':
                return 'Des membres de votre promo sont déjà inscrits';
            case 'regular_group':
                return 'Vous y retrouverez un groupe familier';
            case 'high_energy_match':
                return 'Le niveau d’activité correspond à votre rythme';
            case 'easy_join':
                return 'Format facile pour reprendre';
            default:
                return reason;
        }
    });
}

export function buildInitialRecommendationEmbed(recommendation: ScoredSessionRecommendation): DiscordEmbed {
    return {
        title: `${recommendation.session.weekday} ${new Date(recommendation.session.date).toLocaleString('fr-FR', {
            day: '2-digit',
            month: 'long',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'UTC',
        })}`,
        description: `Séance recommandée à **${recommendation.session.location}** pour la semaine à venir.`,
        color: 0x4a7c59,
        fields: [
            {
                name: 'Participants',
                value: `${recommendation.session.participantCount}`,
                inline: true,
            },
            {
                name: 'Ambiance',
                value: recommendation.session.activityLevel,
                inline: true,
            },
            {
                name: 'Aperçu',
                value: recommendation.session.participantPreview.slice(0, 3).join('\n') || 'À découvrir',
                inline: false,
            },
        ],
    };
}

export function buildExpandedRecommendationEmbed(recommendation: ScoredSessionRecommendation): DiscordEmbed {
    return {
        title: `Pourquoi ${recommendation.session.location} ?`,
        description: `Voici pourquoi cette séance peut vous correspondre.`,
        color: 0x3c6e71,
        fields: [
            {
                name: 'Why this one?',
                value: formatRecommendationReasons(recommendation.reasons).join('\n') || 'Séance sélectionnée pour vous.',
                inline: false,
            },
            {
                name: 'People you may know',
                value: recommendation.session.repeatParticipantNames.join('\n') || recommendation.session.participantPreview.join('\n') || 'Nouveaux visages',
                inline: false,
            },
            {
                name: 'Session vibe',
                value: [
                    `Promo dominante : ${recommendation.session.dominantPromo || 'mixte'}`,
                    `Tags : ${recommendation.session.similarityTags.join(', ') || 'général'}`,
                ].join('\n'),
                inline: false,
            },
        ],
    };
}

export function buildSimilarSessionsEmbed(sessions: AlgoliaSessionRecord[]): DiscordEmbed {
    return {
        title: 'Séances similaires',
        description:
            sessions.length === 0
                ? "Aucune alternative proche n'est disponible pour le moment."
                : 'Voici quelques alternatives proches pour la semaine à venir.',
        color: 0x284b63,
        fields: sessions.slice(0, 3).map((session) => ({
            name: `${session.location} · ${new Date(session.date).toLocaleString('fr-FR', {
                day: '2-digit',
                month: 'long',
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'UTC',
            })}`,
            value: [
                `Participants : ${session.participantCount}`,
                `Ambiance : ${session.activityLevel}`,
                `Aperçu : ${session.participantPreview.slice(0, 2).join(', ') || 'À découvrir'}`,
            ].join('\n'),
            inline: false,
        })),
    };
}

export function buildSimilarSessionsComponents(campaignId: string, originSessionId: string, sessions: AlgoliaSessionRecord[]): DiscordActionRow[] {
    const rows: DiscordActionRow[] = [];
    if (sessions.length > 0) {
        rows.push({
            type: DiscordComponentType.ActionRow,
            components: [
                {
                    type: DiscordComponentType.SelectMenu,
                    custom_id: buildRecommendationCustomId('rec_pick', campaignId, originSessionId),
                    placeholder: 'Choisissez une séance similaire',
                    min_values: 1,
                    max_values: 1,
                    options: sessions.slice(0, 3).map((session) => ({
                        label: `${session.location} · ${new Date(session.date).toLocaleString('fr-FR', {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                            timeZone: 'UTC',
                        })}`.slice(0, 100),
                        value: session.id,
                        description: `Participants ${session.participantCount} · ${session.activityLevel}`.slice(0, 100),
                    })),
                } as DiscordComponent,
            ],
        });
    }
    rows.push({
        type: DiscordComponentType.ActionRow,
        components: [
            {
                type: DiscordComponentType.Button,
                style: DiscordButtonStyle.Secondary,
                label: 'Back',
                custom_id: buildRecommendationCustomId('rec_back', campaignId, originSessionId),
            },
        ],
    });
    return rows;
}

export function buildInitialRecommendationComponents(campaignId: string, sessionId: string): DiscordActionRow[] {
    const button: DiscordButton = {
        type: DiscordComponentType.Button,
        style: DiscordButtonStyle.Primary,
        label: 'More',
        custom_id: buildRecommendationCustomId('rec_more', campaignId, sessionId),
    };
    return [{ type: DiscordComponentType.ActionRow, components: [button] }];
}

export function buildExpandedRecommendationComponents(campaignId: string, recommendation: ScoredSessionRecommendation): DiscordActionRow[] {
    const sessionUrl = getSessionUrl({ id: recommendation.session.id, location: recommendation.session.location });
    const components: DiscordComponent[] = [];
    if (sessionUrl) {
        components.push({
            type: DiscordComponentType.Button,
            style: DiscordButtonStyle.Link,
            label: 'Open Session',
            url: sessionUrl,
        });
    }
    components.push(
        {
            type: DiscordComponentType.Button,
            style: DiscordButtonStyle.Secondary,
            label: 'Remind Me Later',
            custom_id: buildRecommendationCustomId('rec_remind', campaignId, recommendation.session.id),
        },
        {
            type: DiscordComponentType.Button,
            style: DiscordButtonStyle.Secondary,
            label: 'Show Similar',
            custom_id: buildRecommendationCustomId('rec_similar', campaignId, recommendation.session.id),
        },
        {
            type: DiscordComponentType.Button,
            style: DiscordButtonStyle.Danger,
            label: 'Not For Me',
            custom_id: buildRecommendationCustomId('rec_nope', campaignId, recommendation.session.id),
        },
    );
    return [
        {
            type: DiscordComponentType.ActionRow,
            components,
        },
    ];
}

export function buildSessionRecommendationRecord(input: {
    userId: string;
    campaignId: string;
    recommendation: ScoredSessionRecommendation;
    similarSessionIds: string[];
    recommendedAt?: Date;
}): SessionRecommendation {
    const recommendedAt = input.recommendedAt || new Date();
    const expiresAt = new Date(input.recommendation.session.timestamp);
    expiresAt.setUTCDate(expiresAt.getUTCDate() + 14);

    return {
        userId: input.userId,
        sortId: `campaign#${input.campaignId}#session#${input.recommendation.session.id}`,
        campaignId: input.campaignId,
        sessionId: input.recommendation.session.id,
        sessionDate: new Date(input.recommendation.session.timestamp),
        sessionLocation: input.recommendation.session.location,
        recommendedAt,
        expiresAt,
        score: input.recommendation.score,
        reasons: input.recommendation.reasons,
        recommendationState: 'sent',
        deliveryStatus: 'sent',
        deliveryChannelId: null,
        deliveryMessageId: null,
        expandedAt: null,
        remindAt: null,
        remindCount: 0,
        dismissedAt: null,
        feedback: null,
        similarSessionIds: input.similarSessionIds,
        algoliaClickSent: false,
        algoliaConversionSent: false,
        joinedAt: null,
    };
}

export function getRecommendationStateFeedback(state: RecommendationState): RecommendationFeedback | null {
    if (state === 'expanded') {
        return 'more';
    }
    if (state === 'remind_requested') {
        return 'remind_later';
    }
    if (state === 'dismissed') {
        return 'not_for_me';
    }
    return null;
}
