import { getSecret } from './aws.secret';
import { AlgoliaSessionRecord, Session, SessionActivityLevel, User, UserStats } from './dynamodb.types';

const ALGOLIA_SECRET_PATH = process.env.ALGOLIA_SECRET_PATH as string;

type AlgoliaCredentials = {
    ALGOLIA_APP_ID: string;
    ALGOLIA_ADMIN_API_KEY: string;
};

export type AlgoliaUserRecord = User & {
    objectID: string;
    fullName: string;
    fullNameNormalized: string;
    initials: string;
    promoYear: number | null;
    searchKeywords: string[];
    firstSeenAt: string | null;
    lastActivityAt: string | null;
    lastSessionDate: string | null;
    sessionsLast30Days: number;
    sessionsLast90Days: number;
    membershipTenureDays: number | null;
    activityStatus: UserStats['activityStatus'];
    favoriteLocation: string | null;
    preferredDayOfWeek: string | null;
    ticketCount: number;
    hasOpenIssue: boolean;
    profileCompletenessScore: number;
    tags: string[];
    attendanceRate: number | null;
    computedAt: string | null;
    statsVersion: string | null;
};

function normalizeString(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function getInitials(firstName: string, lastName: string): string {
    return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
}

function getPromoYear(promo: string): number | null {
    const match = promo.match(/\d{4}/);
    return match ? parseInt(match[0]) : null;
}

function toIsoString(value: Date | null | undefined): string | null {
    return value ? value.toISOString() : null;
}

function getSessionActivityLevel(participantCount: number): SessionActivityLevel {
    if (participantCount >= 12) {
        return 'very_popular';
    }
    if (participantCount >= 6) {
        return 'popular';
    }
    return 'small';
}

function getSessionTags(session: Session, participantCount: number, now: Date): string[] {
    const tags = new Set<string>();
    tags.add(session.location);
    tags.add(session.date >= now ? 'upcoming' : 'expired');
    if (session.date.getDay() === 0 || session.date.getDay() === 6) {
        tags.add('weekend');
    } else if (session.date.getHours() >= 17) {
        tags.add('weekday-evening');
    }
    tags.add(getSessionActivityLevel(participantCount));
    return Array.from(tags);
}

function getDominantPromo(participantPromos: string[]): string | null {
    const counts = new Map<string, number>();
    for (const promo of participantPromos) {
        counts.set(promo, (counts.get(promo) || 0) + 1);
    }
    let bestPromo: string | null = null;
    let bestCount = -1;
    for (const [promo, count] of counts.entries()) {
        if (count > bestCount || (count === bestCount && bestPromo !== null && promo < bestPromo)) {
            bestPromo = promo;
            bestCount = count;
        }
    }
    return bestPromo;
}

function getSimilarityTags(
    session: Session,
    participantCount: number,
    dominantPromo: string | null,
    repeatParticipantCount: number,
): string[] {
    const tags = new Set<string>();
    if (session.date.getDay() !== 0 && session.date.getDay() !== 6 && session.date.getHours() >= 17) {
        tags.add('afterwork');
    }
    if (session.date.getDay() === 0 || session.date.getDay() === 6) {
        tags.add('weekend');
    }
    if (participantCount >= 6) {
        tags.add(`popular-${session.location}`);
    }
    if (dominantPromo) {
        tags.add(`promo-${dominantPromo}`);
    }
    if (repeatParticipantCount > 0) {
        tags.add('regular-group');
    }
    return Array.from(tags).sort();
}

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

export function toAlgoliaUserRecord(user: User, stats?: UserStats): AlgoliaUserRecord {
    const fullName = `${user.firstName} ${user.lastName}`.trim();
    const searchKeywords = Array.from(
        new Set(
            [user.id, user.firstName, user.lastName, fullName, normalizeString(user.firstName), normalizeString(user.lastName), normalizeString(fullName), user.promo]
                .filter((value) => value.length > 0),
        ),
    );
    return {
        objectID: user.id,
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        promo: user.promo,
        nbOfSeances: stats?.nbOfSeances || user.nbOfSeances,
        fullName,
        fullNameNormalized: normalizeString(fullName),
        initials: getInitials(user.firstName, user.lastName),
        promoYear: getPromoYear(user.promo),
        searchKeywords,
        firstSeenAt: toIsoString(stats?.firstSeenAt),
        lastActivityAt: toIsoString(stats?.lastActivityAt),
        lastSessionDate: toIsoString(stats?.lastSessionDate),
        sessionsLast30Days: stats?.sessionsLast30Days || 0,
        sessionsLast90Days: stats?.sessionsLast90Days || 0,
        membershipTenureDays: stats?.membershipTenureDays ?? null,
        activityStatus: stats?.activityStatus || 'inactive',
        favoriteLocation: stats?.favoriteLocation ?? null,
        preferredDayOfWeek: stats?.preferredDayOfWeek ?? null,
        ticketCount: stats?.ticketCount || 0,
        hasOpenIssue: stats?.hasOpenIssue || false,
        profileCompletenessScore: stats?.profileCompletenessScore || 0,
        tags: stats?.tags || [],
        attendanceRate: stats?.attendanceRate ?? null,
        computedAt: toIsoString(stats?.computedAt),
        statsVersion: stats?.statsVersion || null,
    };
}

export function buildCoAttendanceCounts(participantIdsBySession: Map<string, string[]>): Map<string, number> {
    const counts = new Map<string, number>();
    for (const ids of participantIdsBySession.values()) {
        const sorted = [...new Set(ids)].sort();
        for (let i = 0; i < sorted.length; i++) {
            for (let j = i + 1; j < sorted.length; j++) {
                const key = `${sorted[i]}:${sorted[j]}`;
                counts.set(key, (counts.get(key) || 0) + 1);
            }
        }
    }
    return counts;
}

function getPairCount(coAttendanceCounts: Map<string, number>, a: string, b: string): number {
    const key = a <= b ? `${a}:${b}` : `${b}:${a}`;
    return coAttendanceCounts.get(key) || 0;
}

export function toAlgoliaSessionRecord(
    session: Session,
    participants: User[],
    now: Date = new Date(),
    coAttendanceCounts?: Map<string, number>,
): AlgoliaSessionRecord {
    const participantNames = participants.map((participant) => `${participant.firstName} ${participant.lastName}`.trim());
    const participantPromos = Array.from(new Set(participants.map((participant) => participant.promo))).sort();
    const participantCount = participants.length;
    const timestamp = session.date.getTime();
    const isUpcoming = session.date >= now;
    const dominantPromo = getDominantPromo(participants.map((participant) => participant.promo));
    const favoriteParticipantPromos = participantPromos.slice(0, 3);

    let repeatParticipantIds: string[];
    let repeatParticipantNames: string[];
    let participantPreview: string[];

    if (coAttendanceCounts) {
        const participantIds = participants.map((p) => p.id);
        const participantById = new Map(participants.map((p) => [p.id, p]));
        const repeatScores = new Map<string, number>();
        for (const userId of participantIds) {
            let score = 0;
            for (const otherId of participantIds) {
                if (userId === otherId) continue;
                const pairCount = getPairCount(coAttendanceCounts, userId, otherId);
                if (pairCount >= 2) score += pairCount - 1;
            }
            repeatScores.set(userId, score);
        }
        const formatName = (id: string) => {
            const user = participantById.get(id);
            return user ? `${user.firstName} ${user.lastName}`.trim() : id;
        };
        const sortedByRepeat = [...participantIds].sort((a, b) => {
            const diff = (repeatScores.get(b) || 0) - (repeatScores.get(a) || 0);
            if (diff !== 0) return diff;
            return (participantById.get(a)?.firstName || '').localeCompare(participantById.get(b)?.firstName || '');
        });
        const repeatIds = sortedByRepeat.filter((id) => (repeatScores.get(id) || 0) > 0).slice(0, 5);
        repeatParticipantIds = repeatIds;
        repeatParticipantNames = repeatIds.map(formatName);
        participantPreview = sortedByRepeat.slice(0, 4).map(formatName);
    } else {
        repeatParticipantIds = [];
        repeatParticipantNames = [];
        participantPreview = participantNames.slice(0, 4);
    }

    return {
        objectID: session.id,
        id: session.id,
        date: session.date.toISOString(),
        timestamp,
        location: session.location,
        isExpired: !isUpcoming,
        isUpcoming,
        participantCount,
        participantIds: participants.map((participant) => participant.id),
        participantNames,
        participantPromos,
        weekday: session.date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toLowerCase(),
        hour: session.date.getUTCHours(),
        month: session.date.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }).toLowerCase(),
        activityLevel: getSessionActivityLevel(participantCount),
        favoriteParticipantPromos,
        participantPreview,
        repeatParticipantIds,
        repeatParticipantNames,
        dominantPromo,
        similarityTags: getSimilarityTags(session, participantCount, dominantPromo, repeatParticipantIds.length),
        tags: getSessionTags(session, participantCount, now),
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
