import {
    buildFallbackAnnouncementCompaction,
    compactAnnouncementWithFallback,
    compactAnnouncementWithOllama,
} from '../../src/association.announcements.compactor';
import { AssociationAnnouncement } from '../../../../layers/commons/dynamodb.types';

function buildAnnouncement(): AssociationAnnouncement {
    return {
        id: 'announce-1',
        sourceMessageId: 'announce-1',
        sourceChannelId: 'channel-announce',
        title: 'Soiree decouverte',
        content:
            'Jeudi soir a Antrebloc avec accueil des nouveaux membres. Inscription via le formulaire Discord. Materiel debutant disponible.',
        startsAt: new Date('2026-03-20T18:00:00.000Z'),
        endsAt: new Date('2026-03-20T20:00:00.000Z'),
        expiresAt: new Date('2026-04-19T20:00:00.000Z'),
        priority: 0,
        tags: ['debutant'],
        source: 'discord_channel',
        sourceUrl: 'https://discord.com/channels/guild/channel/announce-1',
        updatedAt: new Date('2026-03-19T10:00:00.000Z'),
        category: null,
        audience: [],
        importantFacts: [],
        callToAction: null,
        summaryFresh: null,
        summaryRecent: null,
        summaryArchive: null,
        compactionStatus: 'pending',
        compactionModel: null,
        compactedAt: null,
    };
}

describe('association.announcements.compactor', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
        delete process.env.ANNOUNCEMENT_COMPACTION_OLLAMA_MODEL;
        delete process.env.ANNOUNCEMENT_COMPACTION_OLLAMA_URL;
        jest.restoreAllMocks();
    });

    it('builds a deterministic fallback compaction', () => {
        const compaction = buildFallbackAnnouncementCompaction(buildAnnouncement());

        expect(compaction.compactionStatus).toBe('fallback');
        expect(compaction.compactionModel).toBe('deterministic-fallback');
        expect(compaction.summaryFresh).toContain('Jeudi soir');
        expect(compaction.summaryArchive).toContain('Soiree decouverte');
    });

    it('compacts an announcement with Ollama JSON output', async () => {
        process.env.ANNOUNCEMENT_COMPACTION_OLLAMA_MODEL = 'qwen3:8b';
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                message: {
                    content: JSON.stringify({
                        category: 'event',
                        audience: ['debutant', 'nouveau'],
                        importantFacts: ['Jeudi soir', 'Materiel debutant disponible'],
                        callToAction: 'Inscription via le formulaire Discord',
                        summaryFresh: 'Soiree decouverte jeudi soir a Antrebloc, ouverte aux debutants.',
                        summaryRecent: 'Soiree decouverte a Antrebloc pour debutants.',
                        summaryArchive: 'Evenement debutant a Antrebloc.',
                        tags: ['debutant', 'decouverte'],
                    }),
                },
            }),
        } as unknown as Response);

        const compaction = await compactAnnouncementWithOllama(buildAnnouncement());

        expect(compaction.compactionStatus).toBe('completed');
        expect(compaction.compactionModel).toBe('qwen3:8b');
        expect(compaction.category).toBe('event');
        expect(compaction.audience).toEqual(['debutant', 'nouveau']);
        expect(compaction.callToAction).toBe('Inscription via le formulaire Discord');
        expect(compaction.summaryArchive).toBe('Evenement debutant a Antrebloc.');
        expect(compaction.tags).toEqual(['debutant', 'decouverte']);
    });

    it('falls back if Ollama fails', async () => {
        process.env.ANNOUNCEMENT_COMPACTION_OLLAMA_MODEL = 'qwen3:8b';
        global.fetch = jest.fn().mockRejectedValue(new Error('connection refused'));
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        const compacted = await compactAnnouncementWithFallback(buildAnnouncement());

        expect(compacted.compactionStatus).toBe('fallback');
        expect(compacted.compactionModel).toBe('deterministic-fallback');
        expect(compacted.summaryFresh).toContain('Jeudi soir');
    });
});
