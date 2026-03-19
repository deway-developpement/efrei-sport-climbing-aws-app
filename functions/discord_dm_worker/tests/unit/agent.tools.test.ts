jest.mock('../../../../layers/commons/session.discord.embed', () => ({
    buildDiscordSessionEmbed: jest.fn().mockResolvedValue({
        title: 'Session test',
        fields: [{ name: 'Pourquoi je te la recommande', value: 'Message perso' }],
    }),
}));

jest.mock('../../../../layers/commons/calendar.events', () => ({
    fetchCalendarEventsFromUrl: jest.fn().mockResolvedValue([]),
    getCalendarEventsForUser: jest.fn().mockResolvedValue({
        events: [
            {
                title: 'Cours',
                startIso: '2026-03-24T08:00:00.000Z',
                endIso: '2026-03-24T10:00:00.000Z',
            },
        ],
        missingCalendarFeed: false,
        calendarUrl: 'https://example.com/calendar.ics',
    }),
}));

jest.mock('../../../../layers/commons/dynamodb.user_calendar_feeds', () => ({
    putUserCalendarFeed: jest.fn().mockResolvedValue(undefined),
    deleteUserCalendarFeed: jest.fn().mockResolvedValue(undefined),
    updateUserCalendarFeedFetchStatus: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../../layers/commons/dynamodb.association_announcements', () => ({
    getAssociationAnnouncement: jest.fn().mockResolvedValue({
        id: 'announce-1',
        sourceMessageId: 'announce-1',
        sourceChannelId: 'channel-announce',
        title: 'Soiree decouverte',
        content: 'Contenu complet de l annonce',
        startsAt: new Date('2026-03-20T18:00:00.000Z'),
        endsAt: new Date('2026-03-20T20:00:00.000Z'),
        expiresAt: new Date('2026-04-19T20:00:00.000Z'),
        priority: 0,
        tags: ['debutant'],
        source: 'discord_channel',
        sourceUrl: 'https://discord.com/channels/guild/channel/announce-1',
        updatedAt: new Date('2026-03-19T10:00:00.000Z'),
        category: 'event',
        audience: ['debutant'],
        importantFacts: ['Ouvert aux debutants'],
        callToAction: 'Inscription sur Discord',
        summaryFresh: 'Soiree decouverte jeudi soir a Antrebloc.',
        summaryRecent: 'Soiree decouverte a Antrebloc.',
        summaryArchive: 'Evenement debutant a Antrebloc.',
        compactionStatus: 'completed',
        compactionModel: 'qwen3:8b',
        compactedAt: new Date('2026-03-19T10:00:30.000Z'),
    }),
}));

import {
    executePendingSessionTools,
    extractPendingSessionToolCalls,
    extractSessionToolOutputMessages,
    parseSessionDate,
} from '../../src/agent.tools';

describe('agent.tools', () => {
    const calendarEventsModule = jest.requireMock('../../../../layers/commons/calendar.events') as {
        getCalendarEventsForUser: jest.Mock;
    };

    it('extracts pending client-side session tools', () => {
        const calls = extractPendingSessionToolCalls({
            role: 'assistant',
            parts: [
                {
                    type: 'tool-create_session',
                    state: 'input-available',
                    input: {
                        dayOfWeek: 'lundi',
                        relativeWeek: 'next',
                        hour: 18,
                        location: 'antrebloc',
                    },
                },
            ],
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].toolName).toBe('create_session');
    });

    it('extracts pending session embed tools', () => {
        const calls = extractPendingSessionToolCalls({
            role: 'assistant',
            parts: [
                {
                    type: 'tool-create_session_embed',
                    state: 'input-available',
                    input: {
                        sessionId: 'session-123',
                        message: 'Je te recommande celle-ci.',
                    },
                },
            ],
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].toolName).toBe('create_session_embed');
    });

    it('extracts pending calendar tools', () => {
        const calls = extractPendingSessionToolCalls({
            role: 'assistant',
            parts: [
                {
                    type: 'tool-save_calendar_feed',
                    state: 'input-available',
                    input: {
                        url: 'https://example.com/calendar.ics',
                    },
                },
                {
                    type: 'tool-get_calendar_events',
                    state: 'input-available',
                    input: {
                        startIso: '2026-03-24T00:00:00.000Z',
                        endIso: '2026-03-31T00:00:00.000Z',
                    },
                },
                {
                    type: 'tool-remove_calendar_feed',
                    state: 'input-available',
                    input: {},
                },
                {
                    type: 'tool-get_announce_detail',
                    state: 'input-available',
                    input: {
                        announcementId: 'announce-1',
                    },
                },
            ],
        });

        expect(calls).toHaveLength(4);
        expect(calls.map((call) => call.toolName)).toEqual([
            'save_calendar_feed',
            'get_calendar_events',
            'remove_calendar_feed',
            'get_announce_detail',
        ]);
    });

    it('extracts textual tool outputs for conversation persistence fallback', () => {
        const messages = extractSessionToolOutputMessages({
            role: 'assistant',
            parts: [
                {
                    type: 'tool-create_session',
                    state: 'output-available',
                    output: {
                        kind: 'session_action',
                        message: 'Je t’ai créé une séance lundi à 18h à Antrebloc.',
                    },
                },
            ],
        });

        expect(messages).toEqual(['Je t’ai créé une séance lundi à 18h à Antrebloc.']);
    });

    it('prefers structured local date fields over a conflicting dateIso', () => {
        const parsed = parseSessionDate({
            dateIso: '2026-03-23T18:00:00.000Z',
            localDate: '2026-03-23',
            localTime: '18:00',
            timezone: 'Europe/Paris',
        });

        expect(parsed.toISOString()).toBe('2026-03-23T17:00:00.000Z');
    });

    it('executes create_session_embed without requiring a registered user', async () => {
        const execution = await executePendingSessionTools({
            raw: {
                role: 'assistant',
                parts: [
                    {
                        type: 'step-start',
                    },
                    {
                        type: 'tool-algolia_search_index',
                        state: 'input-available',
                        input: {
                            index: 'esc_sessions',
                            query: 'antrebloc upcoming',
                        },
                    },
                    {
                        type: 'tool-create_session_embed',
                        state: 'input-available',
                        input: {
                            sessionId: 'session-123',
                            message: 'Je te recommande celle-ci.',
                        },
                    },
                ],
            },
        });

        expect(execution.applied).toBe(true);
        expect(execution.outputs).toHaveLength(1);
        expect(execution.outputs[0].kind).toBe('session_embed');
        if (execution.outputs[0].kind !== 'session_embed') {
            throw new Error('Expected session_embed output');
        }
        expect(execution.outputs[0].embed.title).toBe('Session test');
        expect(execution.message?.parts).toHaveLength(1);
        expect(execution.message?.parts[0]).toMatchObject({
            type: 'tool-create_session_embed',
            state: 'output-available',
            output: {
                kind: 'session_embed',
                sessionId: 'session-123',
                message: 'Session embed rendered successfully.',
            },
        });
        expect((execution.message?.parts[0] as { output?: { embed?: unknown } }).output?.embed).toBeUndefined();
    });

    it('executes save_calendar_feed for the discord user', async () => {
        const execution = await executePendingSessionTools({
            discordUserId: 'discord-user-1',
            raw: {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool-save_calendar_feed',
                        state: 'input-available',
                        input: {
                            url: 'https://example.com/calendar.ics',
                        },
                    },
                ],
            },
        });

        expect(execution.outputs).toHaveLength(1);
        expect(execution.outputs[0]).toMatchObject({
            kind: 'calendar_feed_saved',
            url: 'https://example.com/calendar.ics',
        });
        expect(execution.message?.parts[0]).toMatchObject({
            type: 'tool-save_calendar_feed',
            output: {
                kind: 'calendar_feed_saved',
                message: 'Calendar feed saved successfully.',
            },
        });
    });

    it('loads full announcement detail from a compact reference', async () => {
        const execution = await executePendingSessionTools({
            raw: {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool-get_announce_detail',
                        state: 'input-available',
                        input: {
                            announcementId: 'announce-1',
                        },
                    },
                ],
            },
        });

        expect(execution.outputs).toHaveLength(1);
        expect(execution.outputs[0]).toMatchObject({
            kind: 'announcement_detail',
            announcementId: 'announce-1',
            sourceMessageId: 'announce-1',
            title: 'Soiree decouverte',
            content: 'Contenu complet de l annonce',
        });
        expect(execution.message?.parts[0]).toMatchObject({
            type: 'tool-get_announce_detail',
            output: {
                kind: 'announcement_detail',
                message: 'Announcement detail loaded successfully.',
            },
        });
    });

    it('executes get_calendar_events for the discord user', async () => {
        const execution = await executePendingSessionTools({
            discordUserId: 'discord-user-1',
            raw: {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool-get_calendar_events',
                        state: 'input-available',
                        input: {
                            startIso: '2026-03-24T00:00:00.000Z',
                            endIso: '2026-03-31T00:00:00.000Z',
                        },
                    },
                ],
            },
        });

        expect(execution.outputs[0]).toMatchObject({
            kind: 'calendar_events',
            missingCalendarFeed: false,
        });
        expect(execution.message?.parts[0]).toMatchObject({
            type: 'tool-get_calendar_events',
            output: {
                kind: 'calendar_events',
                events: [
                    {
                        title: 'Cours',
                        startIso: '2026-03-24T08:00:00.000Z',
                        endIso: '2026-03-24T10:00:00.000Z',
                    },
                ],
            },
        });
    });

    it('returns missingCalendarFeed when no saved feed exists', async () => {
        calendarEventsModule.getCalendarEventsForUser.mockResolvedValueOnce({
            events: [],
            missingCalendarFeed: true,
            calendarUrl: null,
        });

        const execution = await executePendingSessionTools({
            discordUserId: 'discord-user-1',
            raw: {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool-get_calendar_events',
                        state: 'input-available',
                        input: {
                            startIso: '2026-03-24T00:00:00.000Z',
                            endIso: '2026-03-31T00:00:00.000Z',
                        },
                    },
                ],
            },
        });

        expect(execution.outputs[0]).toMatchObject({
            kind: 'calendar_events',
            missingCalendarFeed: true,
            message: 'No calendar feed is saved for this user.',
        });
    });

    it('executes remove_calendar_feed for the discord user', async () => {
        const execution = await executePendingSessionTools({
            discordUserId: 'discord-user-1',
            raw: {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool-remove_calendar_feed',
                        state: 'input-available',
                        input: {},
                    },
                ],
            },
        });

        expect(execution.outputs[0]).toMatchObject({
            kind: 'calendar_feed_removed',
            message: 'Calendar feed removed successfully.',
        });
    });
});
