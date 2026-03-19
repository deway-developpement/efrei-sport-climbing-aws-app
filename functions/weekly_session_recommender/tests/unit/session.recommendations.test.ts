import { recommendSessionsForUser } from '../../../../layers/commons/session.recommendations';
import { AlgoliaSessionRecord, User, UserStats } from '../../../../layers/commons/dynamodb.types';

function buildUser(): User {
    return {
        id: 'user-1',
        firstName: 'Paul',
        lastName: 'Mairesse',
        promo: 'P2027',
    };
}

function buildUserStats(): UserStats {
    return {
        userId: 'user-1',
        nbOfSeances: 4,
        firstSeenAt: null,
        lastActivityAt: null,
        lastSessionDate: null,
        sessionsLast30Days: 2,
        sessionsLast90Days: 4,
        membershipTenureDays: null,
        activityStatus: 'active',
        favoriteLocation: 'antrebloc',
        preferredDayOfWeek: 'Wednesday',
        ticketCount: 0,
        hasOpenIssue: false,
        profileCompletenessScore: 80,
        tags: [],
        attendanceRate: null,
        computedAt: new Date('2026-03-19T10:00:00.000Z'),
        statsVersion: 'v1',
    };
}

function buildSession(id: string, participantIds: string[]): AlgoliaSessionRecord {
    return {
        objectID: id,
        id,
        date: '2026-03-26T18:00:00.000Z',
        timestamp: new Date('2026-03-26T18:00:00.000Z').getTime(),
        location: 'antrebloc',
        isExpired: false,
        isUpcoming: true,
        participantCount: participantIds.length,
        participantIds,
        participantNames: [],
        participantPromos: ['P2027'],
        weekday: 'Wednesday',
        hour: 18,
        month: 'March',
        activityLevel: 'small',
        favoriteParticipantPromos: [],
        participantPreview: [],
        repeatParticipantIds: [],
        repeatParticipantNames: [],
        dominantPromo: 'P2027',
        similarityTags: [],
        tags: ['antrebloc'],
    };
}

describe('session recommendations', () => {
    it('skips upcoming sessions already joined by the target user', () => {
        const recommendations = recommendSessionsForUser(buildUser(), buildUserStats(), [
            buildSession('joined-session', ['user-1', 'user-2']),
            buildSession('open-session', ['user-2']),
        ]);

        expect(recommendations).toHaveLength(1);
        expect(recommendations[0].session.id).toBe('open-session');
    });
});
