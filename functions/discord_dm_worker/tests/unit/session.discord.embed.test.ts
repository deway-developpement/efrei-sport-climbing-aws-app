jest.mock('../../../../layers/commons/dynamodb.sessions', () => ({
    getSession: jest.fn().mockResolvedValue({
        id: 'session-123',
        date: new Date('2026-03-25T17:00:00.000Z'),
        location: 'antrebloc',
    }),
    listSessionParticipantIds: jest.fn().mockResolvedValue(['u1', 'u2']),
}));

jest.mock('../../../../layers/commons/dynamodb.users', () => ({
    getUser: jest
        .fn()
        .mockResolvedValueOnce({ id: 'u1', firstName: 'Paul', lastName: 'Mairesse', promo: '2026' })
        .mockResolvedValueOnce({ id: 'u2', firstName: 'Alice', lastName: 'Martin', promo: '2027' }),
}));

jest.mock('../../../../layers/commons/session.recommendations', () => ({
    getSessionUrl: jest.fn().mockReturnValue('https://discord.com/channels/guild/channel/session-123'),
}));

import { buildDiscordSessionEmbed } from '../../../../layers/commons/session.discord.embed';

describe('session.discord.embed', () => {
    it('builds a session embed from DynamoDB-backed session data', async () => {
        const embed = await buildDiscordSessionEmbed('session-123', 'Je te la recommande pour mercredi soir.');

        expect(embed.title).toContain('Mercredi');
        expect(embed.description).toBe('Séance à **Antrebloc**');
        expect(embed.url).toBe('https://discord.com/channels/guild/channel/session-123');
        expect(embed.fields?.[0]).toEqual({
            name: 'Pourquoi je te la recommande',
            value: 'Je te la recommande pour mercredi soir.',
            inline: false,
        });
        expect(embed.fields?.[1].value).toContain('Paul Mairesse');
        expect(embed.fields?.[1].value).toContain('Alice Martin');
    });
});
