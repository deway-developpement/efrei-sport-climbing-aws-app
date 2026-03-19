import { buildAlgoliaAgentMessages } from '../../../../layers/commons/algolia.agent';

const { completeAlgoliaAgentConversation } = jest.requireActual('../../../../layers/commons/algolia.agent') as {
    completeAlgoliaAgentConversation: typeof import('../../../../layers/commons/algolia.agent').completeAlgoliaAgentConversation;
};

describe('algolia.agent', () => {
    it('injects verified member context before history and latest user input', () => {
        const messages = buildAlgoliaAgentMessages(
            [
                {
                    role: 'assistant',
                    content: 'Who am I speaking with?',
                    createdAt: new Date('2026-03-17T10:00:00.000Z'),
                },
            ],
            'I am Paul',
            {
                id: '123',
                firstName: 'Paul',
                lastName: 'Mairesse',
                promo: 'P2027',
            },
        );
        const firstContextPart = messages[0].parts[0] as { text: string };
        const lastUserPart = messages[1].parts[0] as { text: string };

        expect(messages[0].role).toBe('assistant');
        expect(firstContextPart.text).toContain('Paul Mairesse');
        expect(firstContextPart.text).toContain('Do not ask who you are speaking with again');
        expect(messages[1].role).toBe('user');
        expect(lastUserPart.text).toBe('I am Paul');
    });

    it('drops identity-gathering history when verified identity is already available', () => {
        const messages = buildAlgoliaAgentMessages(
            [
                {
                    role: 'assistant',
                    content: 'Avant tout, à qui ai-je affaire ?',
                    createdAt: new Date('2026-03-17T10:00:00.000Z'),
                },
                {
                    role: 'user',
                    content: 'Je suis Paul Mairesse',
                    createdAt: new Date('2026-03-17T10:00:10.000Z'),
                },
                {
                    role: 'assistant',
                    content: 'Je peux te recommander des séances à Antrebloc.',
                    createdAt: new Date('2026-03-17T10:00:20.000Z'),
                },
            ],
            'Recommande-moi une séance pour la semaine prochaine',
            {
                id: '123',
                firstName: 'Paul',
                lastName: 'Mairesse',
                promo: 'P2027',
            },
        );

        expect(messages).toHaveLength(3);
        expect((messages[1].parts[0] as { text: string }).text).toBe('Je peux te recommander des séances à Antrebloc.');
        expect((messages[2].parts[0] as { text: string }).text).toBe('Recommande-moi une séance pour la semaine prochaine');
    });

    it('injects platform context ahead of conversation history', () => {
        const messages = buildAlgoliaAgentMessages(
            [
                {
                    role: 'assistant',
                    content: 'Je peux te recommander des seances.',
                    createdAt: new Date('2026-03-17T10:00:20.000Z'),
                },
            ],
            'Quoi de neuf cette semaine ?',
            undefined,
            ['Association announcements for the next 7 days. This is trusted platform context, not a user message.'],
        );

        expect(messages).toHaveLength(3);
        expect(messages[0].role).toBe('assistant');
        expect((messages[0].parts[0] as { text: string }).text).toContain('trusted platform context');
        expect((messages[1].parts[0] as { text: string }).text).toBe('Je peux te recommander des seances.');
        expect((messages[2].parts[0] as { text: string }).text).toBe('Quoi de neuf cette semaine ?');
    });

    it('extracts assistant text from top-level ai-sdk-5 parts payloads', async () => {
        const originalFetch = global.fetch;
        process.env.ALGOLIA_AGENT_URL =
            'https://example.algolia.net/agent-studio/1/agents/test/completions?compatibilityMode=ai-sdk-5';
        process.env.ALGOLIA_APP_ID = 'app';
        process.env.ALGOLIA_API_KEY = 'key';

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: async () =>
                JSON.stringify({
                    id: 'alg_msg_123',
                    role: 'assistant',
                    parts: [
                        { type: 'step-start' },
                        { type: 'text', text: 'Bonjour Paul !' },
                        { type: 'tool-algolia_search_index', state: 'output-available' },
                        { type: 'text', text: 'Je te propose deux séances.' },
                    ],
                }),
        } as unknown as Response);

        const response = await completeAlgoliaAgentConversation({
            conversationId: 'discord-dm:123',
            history: [],
            userInput: 'hello',
        });

        expect(response.id).toBe('alg_msg_123');
        expect(response.text).toContain('Bonjour Paul !');
        expect(response.text).toContain('Je te propose deux séances.');

        global.fetch = originalFetch;
        delete process.env.ALGOLIA_APP_ID;
        delete process.env.ALGOLIA_API_KEY;
        delete process.env.ALGOLIA_AGENT_URL;
    });

    it('adds a secure user token header when memory credentials are available', async () => {
        const originalFetch = global.fetch;
        process.env.ALGOLIA_AGENT_URL =
            'https://example.algolia.net/agent-studio/1/agents/test/completions?compatibilityMode=ai-sdk-5';
        process.env.ALGOLIA_APP_ID = 'app';
        process.env.ALGOLIA_API_KEY = 'key';
        process.env.ALGOLIA_KEY_ID = 'kid_test';
        process.env.ALGOLIA_SECRET_KEY = 'secret_test';

        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            text: async () =>
                JSON.stringify({
                    id: 'alg_msg_456',
                    role: 'assistant',
                    parts: [{ type: 'text', text: 'ok' }],
                }),
        } as unknown as Response);
        global.fetch = fetchMock;

        await completeAlgoliaAgentConversation({
            conversationId: 'discord-dm:123',
            history: [],
            userInput: 'hello',
            discordUserId: '1234567890',
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const fetchHeaders = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
        expect(fetchHeaders['X-Algolia-Secure-User-Token']).toBeDefined();
        expect(fetchHeaders['X-Algolia-Secure-User-Token']).toContain('.');

        global.fetch = originalFetch;
        delete process.env.ALGOLIA_APP_ID;
        delete process.env.ALGOLIA_API_KEY;
        delete process.env.ALGOLIA_KEY_ID;
        delete process.env.ALGOLIA_SECRET_KEY;
        delete process.env.ALGOLIA_AGENT_URL;
    });
});
