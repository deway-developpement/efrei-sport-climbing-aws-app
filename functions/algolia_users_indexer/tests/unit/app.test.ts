process.env.ALGOLIA_USERS_INDEX = 'esc_users';

jest.mock('commons/algolia.client', () => ({
    deleteAlgoliaRecord: jest.fn(),
    toAlgoliaUserRecord: jest.fn((user, stats) => ({ objectID: user.id, ...user, stats })),
    upsertAlgoliaRecord: jest.fn(),
}));

jest.mock('commons/dynamodb.user_stats', () => ({
    getUserStats: jest.fn(),
}));

jest.mock('commons/dynamodb.users', () => ({
    getUser: jest.fn(),
}));

import { deleteAlgoliaRecord, upsertAlgoliaRecord } from 'commons/algolia.client';
import { getUserStats } from 'commons/dynamodb.user_stats';
import { getUser } from 'commons/dynamodb.users';

const deleteAlgoliaRecordMock = deleteAlgoliaRecord as jest.Mock;
const upsertAlgoliaRecordMock = upsertAlgoliaRecord as jest.Mock;
const getUserStatsMock = getUserStats as jest.Mock;
const getUserMock = getUser as jest.Mock;

const { lambdaHandler } = require('../../app') as typeof import('../../app');

describe('algolia_users_indexer', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('reindexes a user when user stats are updated', async () => {
        getUserMock.mockResolvedValue({
            id: 'user-1',
            firstName: 'Paul',
            lastName: 'Mairesse',
            promo: 'P2027',
        });
        getUserStatsMock.mockResolvedValue({
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
            preferredDayOfWeek: null,
            ticketCount: 0,
            hasOpenIssue: false,
            profileCompletenessScore: 80,
            tags: [],
            attendanceRate: null,
            computedAt: new Date('2026-03-19T10:00:00.000Z'),
            statsVersion: 'v1',
        });

        const event = {
            Records: [
                {
                    eventID: '1',
                    eventName: 'MODIFY',
                    eventVersion: '1.1',
                    eventSource: 'aws:dynamodb',
                    awsRegion: 'eu-west-3',
                    dynamodb: {
                        Keys: { userId: { S: 'user-1' } },
                        NewImage: {
                            userId: { S: 'user-1' },
                            activityStatus: { S: 'active' },
                            computedAt: { N: '1773943200000' },
                            statsVersion: { S: 'v1' },
                        },
                        SequenceNumber: '1',
                        SizeBytes: 1,
                        StreamViewType: 'NEW_AND_OLD_IMAGES',
                    },
                    eventSourceARN: 'arn:aws:dynamodb:eu-west-3:123:table/user-stats/stream/2026-03-19',
                },
            ],
        } as const;

        await lambdaHandler(event as never);

        expect(getUserMock).toHaveBeenCalledWith('user-1');
        expect(upsertAlgoliaRecordMock).toHaveBeenCalledWith(
            'esc_users',
            'user-1',
            expect.objectContaining({ id: 'user-1' }),
        );
    });

    it('deletes the Algolia record on user removal events', async () => {
        const event = {
            Records: [
                {
                    eventID: '2',
                    eventName: 'REMOVE',
                    eventVersion: '1.1',
                    eventSource: 'aws:dynamodb',
                    awsRegion: 'eu-west-3',
                    dynamodb: {
                        Keys: { id: { S: 'user-1' } },
                        OldImage: { id: { S: 'user-1' } },
                        SequenceNumber: '2',
                        SizeBytes: 1,
                        StreamViewType: 'NEW_AND_OLD_IMAGES',
                    },
                    eventSourceARN: 'arn:aws:dynamodb:eu-west-3:123:table/users/stream/2026-03-19',
                },
            ],
        } as const;

        await lambdaHandler(event as never);

        expect(deleteAlgoliaRecordMock).toHaveBeenCalledWith('esc_users', 'user-1');
    });
});
