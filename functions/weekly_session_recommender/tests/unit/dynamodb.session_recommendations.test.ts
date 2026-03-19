import {
    marshallSessionRecommendationItem,
    unmarshallSessionRecommendationItem,
} from '../../../../layers/commons/dynamodb.session_recommendations';

function buildRecommendation() {
    return {
        userId: 'user-1',
        sortId: 'campaign#w260319#session#session-1',
        campaignId: 'w260319',
        sessionId: 'session-1',
        sessionDate: new Date('2026-03-26T18:00:00.000Z'),
        sessionLocation: 'antrebloc',
        recommendedAt: new Date('2026-03-19T10:00:00.000Z'),
        expiresAt: new Date('2026-03-28T18:00:00.000Z'),
        score: 42,
        reasons: ['favorite_location'],
        recommendationState: 'sent' as const,
        deliveryStatus: 'sent' as const,
        deliveryChannelId: 'channel-1',
        deliveryMessageId: 'message-1',
        expandedAt: null,
        remindAt: null,
        remindCount: 0,
        dismissedAt: null,
        feedback: null,
        similarSessionIds: ['session-2'],
        algoliaClickSent: false,
        algoliaConversionSent: false,
        joinedAt: null,
    };
}

describe('dynamodb.session_recommendations', () => {
    it('stores recommendation TTL in epoch seconds', () => {
        const recommendation = buildRecommendation();

        const item = marshallSessionRecommendationItem(recommendation);

        expect(item.expiresAt).toEqual({
            N: Math.floor(recommendation.expiresAt.getTime() / 1000).toString(),
        });
    });

    it('reads recommendation TTL back as a JavaScript Date', () => {
        const expiresAt = new Date('2026-03-28T18:00:00.000Z');

        const recommendation = unmarshallSessionRecommendationItem({
            userId: { S: 'user-1' },
            sortId: { S: 'campaign#w260319#session#session-1' },
            campaignId: { S: 'w260319' },
            sessionId: { S: 'session-1' },
            sessionDate: { N: '1774557600000' },
            sessionLocation: { S: 'antrebloc' },
            recommendedAt: { N: '1773943200000' },
            expiresAt: { N: Math.floor(expiresAt.getTime() / 1000).toString() },
            score: { N: '42' },
            reasons: { L: [{ S: 'favorite_location' }] },
            recommendationState: { S: 'sent' },
            deliveryStatus: { S: 'sent' },
            deliveryChannelId: { S: 'channel-1' },
            deliveryMessageId: { S: 'message-1' },
            expandedAt: { NULL: true },
            remindAt: { NULL: true },
            remindCount: { N: '0' },
            dismissedAt: { NULL: true },
            feedback: { NULL: true },
            similarSessionIds: { L: [] },
            algoliaClickSent: { BOOL: false },
            algoliaConversionSent: { BOOL: false },
            joinedAt: { NULL: true },
        });

        expect(recommendation?.expiresAt.toISOString()).toBe(expiresAt.toISOString());
    });
});
