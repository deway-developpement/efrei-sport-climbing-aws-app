jest.mock('commons/aws.secret', () => ({
    getSecret: jest.fn(),
}));

jest.mock('commons/dynamodb.session_recommendations', () => ({
    getSessionRecommendation: jest.fn(),
    putSessionRecommendation: jest.fn(),
    updateSessionRecommendationState: jest.fn(),
    buildRecommendationSortId: jest.fn((campaignId: string, sessionId: string) => `campaign#${campaignId}#session#${sessionId}`),
    listPendingReminderRecommendations: jest.fn(),
}));

jest.mock('commons/dynamodb.sessions', () => ({
    listSessionUnexpired: jest.fn(),
}));

jest.mock('commons/dynamodb.user_stats', () => ({
    listUserStats: jest.fn(),
}));

jest.mock('commons/dynamodb.users', () => ({
    listUsers: jest.fn(),
}));

import { getSecret } from 'commons/aws.secret';
import { listPendingReminderRecommendations, updateSessionRecommendationState } from 'commons/dynamodb.session_recommendations';
import { listSessionUnexpired } from 'commons/dynamodb.sessions';
import { runPendingRecommendationReminders } from '../../src/recommender.handler';

const getSecretMock = getSecret as jest.Mock;
const listPendingReminderRecommendationsMock = listPendingReminderRecommendations as jest.Mock;
const updateSessionRecommendationStateMock = updateSessionRecommendationState as jest.Mock;
const listSessionUnexpiredMock = listSessionUnexpired as jest.Mock;

function buildSession(participants: Array<{ id: string; firstName: string; lastName: string; promo: string }>) {
    return {
        id: 'session-1',
        date: new Date('2026-03-26T18:00:00.000Z'),
        location: 'antrebloc',
        participants,
    };
}

function buildRecommendation() {
    return {
        userId: 'user-1',
        sortId: 'campaign#w260319#session#session-1',
        campaignId: 'w260319',
        sessionId: 'session-1',
        sessionDate: new Date('2026-03-26T18:00:00.000Z'),
        sessionLocation: 'antrebloc',
        recommendedAt: new Date('2026-03-19T10:00:00.000Z'),
        expiresAt: new Date('2026-04-09T18:00:00.000Z'),
        score: 42,
        reasons: ['favorite_location'],
        recommendationState: 'remind_requested',
        deliveryStatus: 'sent',
        deliveryChannelId: 'channel-1',
        deliveryMessageId: 'message-1',
        expandedAt: null,
        remindAt: new Date('2026-03-21T10:00:00.000Z'),
        remindCount: 1,
        dismissedAt: null,
        feedback: 'remind_later',
        similarSessionIds: [],
        algoliaClickSent: false,
        algoliaConversionSent: false,
        joinedAt: null,
    };
}

describe('recommender.handler reminders', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        jest.clearAllMocks();
        getSecretMock.mockResolvedValue({ DISCORD_BOT_TOKEN: 'bot-token' });
    });

    afterAll(() => {
        global.fetch = originalFetch;
    });

    it('sends pending reminders and clears remindAt after delivery', async () => {
        listPendingReminderRecommendationsMock.mockResolvedValue([buildRecommendation()]);
        listSessionUnexpiredMock.mockResolvedValue([buildSession([{ id: 'user-2', firstName: 'A', lastName: 'B', promo: 'P2027' }])]);
        global.fetch = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: 'dm-channel-1' }),
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: 'reminder-message-1', channel_id: 'dm-channel-1' }),
            } as Response);

        await runPendingRecommendationReminders(new Date('2026-03-21T10:00:00.000Z'));

        expect(updateSessionRecommendationStateMock).toHaveBeenCalledWith(
            'user-1',
            'campaign#w260319#session#session-1',
            'sent',
            expect.objectContaining({
                remindAt: null,
                deliveryChannelId: 'dm-channel-1',
                deliveryMessageId: 'reminder-message-1',
                deliveryStatus: 'sent',
            }),
        );
    });

    it('marks reminders as joined instead of sending them when the user already joined the session', async () => {
        listPendingReminderRecommendationsMock.mockResolvedValue([buildRecommendation()]);
        listSessionUnexpiredMock.mockResolvedValue([buildSession([{ id: 'user-1', firstName: 'Paul', lastName: 'M', promo: 'P2027' }])]);
        global.fetch = jest.fn();

        await runPendingRecommendationReminders(new Date('2026-03-21T10:00:00.000Z'));

        expect(global.fetch).not.toHaveBeenCalled();
        expect(updateSessionRecommendationStateMock).toHaveBeenCalledWith(
            'user-1',
            'campaign#w260319#session#session-1',
            'joined',
            expect.objectContaining({
                remindAt: null,
                joinedAt: new Date('2026-03-21T10:00:00.000Z'),
            }),
        );
    });
});
