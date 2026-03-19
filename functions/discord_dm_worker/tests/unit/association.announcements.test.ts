import {
    buildAnnouncementWindowEnd,
    buildAnnouncementWindowStart,
    buildAssociationAnnouncementFromDiscordMessage,
    formatAnnouncementsPromptContext,
    isTrackedAnnouncementChannel,
    parseAnnouncementChannelIds,
    parseAnnouncementLookaheadDays,
    parseAnnouncementLookbackDays,
    parseAnnouncementRetentionDays,
    parseDiscordAnnouncementActiveDays,
} from '../../src/association.announcements';

describe('association.announcements', () => {
    it('builds a persisted announcement from a Discord channel message', () => {
        const announcement = buildAssociationAnnouncementFromDiscordMessage(
            {
                id: 'message-1',
                channelId: 'channel-1',
                content: 'Soiree decouverte\nVenez grimper jeudi avec les nouveaux. #debutant #evenement',
                url: 'https://discord.com/channels/guild/channel/message-1',
                createdAt: new Date('2026-03-19T18:00:00.000Z'),
                attachments: [{ url: 'https://cdn.discordapp.com/file.pdf', name: 'programme.pdf' }],
            },
            {
                activeDays: 7,
                retentionDays: 30,
            },
        );

        expect(announcement).not.toBeNull();
        expect(announcement?.id).toBe('message-1');
        expect(announcement?.sourceMessageId).toBe('message-1');
        expect(announcement?.sourceChannelId).toBe('channel-1');
        expect(announcement?.title).toBe('Soiree decouverte');
        expect(announcement?.content).toContain('programme.pdf');
        expect(announcement?.tags).toEqual(['debutant', 'evenement']);
        expect(announcement?.expiresAt.toISOString()).toBe('2026-04-25T18:00:00.000Z');
        expect(announcement?.summaryFresh).toContain('Soiree decouverte');
        expect(announcement?.compactionStatus).toBe('fallback');
    });

    it('formats prompt context with progressive compaction by announcement age', () => {
        const now = new Date('2026-03-19T12:00:00.000Z');
        const context = formatAnnouncementsPromptContext(
            [
                {
                    id: 'fresh',
                    sourceMessageId: 'fresh-msg',
                    sourceChannelId: 'announce-channel',
                    title: 'Sortie falaise',
                    content: 'Samedi sortie falaise a Fontainebleau avec covoiturage.',
                    startsAt: new Date('2026-03-21T08:00:00.000Z'),
                    endsAt: new Date('2026-03-21T18:00:00.000Z'),
                    expiresAt: new Date('2026-04-20T18:00:00.000Z'),
                    priority: 10,
                    tags: ['falaise'],
                    source: 'discord_channel',
                    sourceUrl: 'https://discord.com/channels/guild/channel/fresh',
                    updatedAt: now,
                    category: 'event',
                    audience: ['grimpeur'],
                    importantFacts: ['Sortie samedi'],
                    callToAction: 'Inscription en DM',
                    summaryFresh: 'Sortie falaise samedi a Fontainebleau avec covoiturage.',
                    summaryRecent: 'Sortie falaise a Fontainebleau.',
                    summaryArchive: 'Sortie falaise.',
                    compactionStatus: 'completed',
                    compactionModel: 'qwen3:8b',
                    compactedAt: now,
                },
                {
                    id: 'recent',
                    sourceMessageId: 'recent-msg',
                    sourceChannelId: 'announce-channel',
                    title: 'Tournoi bloc',
                    content: 'Le tournoi bloc de la semaine derniere etait ouvert a tous.',
                    startsAt: new Date('2026-03-10T18:00:00.000Z'),
                    endsAt: new Date('2026-03-12T20:00:00.000Z'),
                    expiresAt: new Date('2026-04-11T20:00:00.000Z'),
                    priority: 5,
                    tags: ['competition'],
                    source: 'discord_channel',
                    sourceUrl: null,
                    updatedAt: now,
                    category: 'competition',
                    audience: [],
                    importantFacts: ['Tournoi interne'],
                    callToAction: null,
                    summaryFresh: 'Tournoi bloc interne ouvert a tous.',
                    summaryRecent: 'Tournoi bloc interne.',
                    summaryArchive: 'Tournoi bloc.',
                    compactionStatus: 'completed',
                    compactionModel: 'qwen3:8b',
                    compactedAt: now,
                },
                {
                    id: 'archive',
                    sourceMessageId: 'archive-msg',
                    sourceChannelId: 'announce-channel',
                    title: 'Atelier assureur',
                    content: 'Atelier assureur et securite organise en debut de mois.',
                    startsAt: new Date('2026-02-20T18:00:00.000Z'),
                    endsAt: new Date('2026-02-22T20:00:00.000Z'),
                    expiresAt: new Date('2026-03-24T20:00:00.000Z'),
                    priority: 2,
                    tags: ['formation', 'securite'],
                    source: 'discord_channel',
                    sourceUrl: null,
                    updatedAt: now,
                    category: 'training',
                    audience: [],
                    importantFacts: ['Atelier securite'],
                    callToAction: null,
                    summaryFresh: 'Atelier assureur et securite organise en debut de mois.',
                    summaryRecent: 'Atelier assureur et securite.',
                    summaryArchive: 'Atelier securite.',
                    compactionStatus: 'completed',
                    compactionModel: 'qwen3:8b',
                    compactedAt: now,
                },
            ],
            {
                now,
                lookbackDays: 30,
                lookaheadDays: 7,
            },
        );

        expect(context).toContain('Upcoming or ongoing announcements:');
        expect(context).toContain('Sortie falaise');
        expect(context).toContain('[ref: fresh-msg]');
        expect(context).toContain('Recently ended announcements (0-7 days old):');
        expect(context).toContain('Tournoi bloc interne.');
        expect(context).toContain('[ref: recent-msg]');
        expect(context).toContain('Compressed archive:');
        expect(context).toContain('Older archive (15-30 days old): 1 announcement.');
        expect(context).toContain('Themes: formation, securite.');
        expect(context).toContain('- Atelier securite. [ref: archive-msg]');
    });

    it('parses channel ids and retention settings with safe floors', () => {
        expect(parseAnnouncementChannelIds('123,456,123')).toEqual(['123', '456']);
        expect(parseAnnouncementLookaheadDays(undefined)).toBe(7);
        expect(parseAnnouncementLookbackDays('5')).toBe(30);
        expect(parseAnnouncementRetentionDays('12')).toBe(30);
        expect(parseDiscordAnnouncementActiveDays('10')).toBe(10);
    });

    it('computes a symmetric prompt window around now', () => {
        const now = new Date('2026-03-19T12:00:00.000Z');
        expect(buildAnnouncementWindowStart(now, 30).toISOString()).toBe('2026-02-17T12:00:00.000Z');
        expect(buildAnnouncementWindowEnd(now, 7).toISOString()).toBe('2026-03-26T12:00:00.000Z');
    });

    it('matches tracked announcement channels', () => {
        expect(isTrackedAnnouncementChannel('123', ['123', '456'])).toBe(true);
        expect(isTrackedAnnouncementChannel('999', ['123', '456'])).toBe(false);
    });
});
