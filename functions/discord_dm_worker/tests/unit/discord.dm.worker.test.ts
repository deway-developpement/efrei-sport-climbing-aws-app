import {
    buildUpdatedConversation,
    buildConversationId,
    isConversationExpired,
    splitDiscordMessage,
} from '../../src/discord.dm.worker';

describe('discord.dm.worker', () => {
    it('splits long Discord replies on whitespace', () => {
        const message = `Bonjour ${'mot '.repeat(800)}`;
        const chunks = splitDiscordMessage(message, 200);

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((chunk) => chunk.length <= 200)).toBe(true);
    });

    it('builds and trims conversation history', () => {
        const now = new Date('2026-03-17T12:00:00.000Z');
        const existingMessages = Array.from({ length: 4 }, (_, index) => ({
            role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
            content: `message-${index}`,
            createdAt: new Date(now.getTime() - (4 - index) * 1000),
        }));

        const conversation = buildUpdatedConversation({
            existing: {
                discordUserId: '123',
                discordUsername: 'paul',
                registeredUserId: null,
                registeredFirstName: null,
                registeredLastName: null,
                registeredPromo: null,
                identifiedUserName: null,
                algoliaConversationId: buildConversationId('123', now),
                lastProcessedMessageId: 'old',
                messages: existingMessages,
                updatedAt: now,
                expiresAt: now,
            },
            discordUserId: '123',
            discordUsername: 'paul',
            userMessageId: 'new-message',
            userInput: 'hello',
            assistantReply: 'hi',
            now,
            historyLimit: 3,
            retentionDays: 30,
        });

        expect(conversation.messages).toHaveLength(3);
        expect(conversation.messages[0].content).toBe('message-3');
        expect(conversation.messages[1].content).toBe('hello');
        expect(conversation.messages[2].content).toBe('hi');
        expect(conversation.lastProcessedMessageId).toBe('new-message');
        expect(conversation.expiresAt.toISOString()).toBe('2026-04-16T12:00:00.000Z');
    });

    it('treats expired conversations as inactive', () => {
        const now = new Date('2026-03-17T12:00:00.000Z');
        expect(
            isConversationExpired(
                {
                    discordUserId: '123',
                    discordUsername: 'paul',
                    registeredUserId: null,
                    registeredFirstName: null,
                    registeredLastName: null,
                    registeredPromo: null,
                    identifiedUserName: null,
                    algoliaConversationId: buildConversationId('123', new Date('2026-03-17T10:00:00.000Z')),
                    lastProcessedMessageId: 'old',
                    messages: [],
                    updatedAt: new Date('2026-03-17T10:00:00.000Z'),
                    expiresAt: new Date('2026-04-16T10:00:00.000Z'),
                },
                now,
                1,
            ),
        ).toBe(true);
    });
});
