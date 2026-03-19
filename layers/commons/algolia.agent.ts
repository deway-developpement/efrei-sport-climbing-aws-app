import { getSecret } from './aws.secret';
import { createHmac } from 'crypto';

type ConversationHistoryMessage = {
    role: 'user' | 'assistant' | 'system';
    content: string;
    createdAt?: Date;
};

type RegisteredUserContext = {
    id: string;
    firstName: string;
    lastName: string;
    promo: string;
};

type AlgoliaCredentials = {
    ALGOLIA_APP_ID: string;
    ALGOLIA_SEARCH_API_KEY?: string;
    ALGOLIA_ADMIN_API_KEY?: string;
    ALGOLIA_KEY_ID?: string;
    ALGOLIA_SECRET_KEY?: string;
};

type AlgoliaAgentPart = {
    type: 'text';
    text: string;
};

export type AlgoliaAgentMessage = {
    role: 'user' | 'assistant';
    parts: unknown[];
};

type AlgoliaAgentRequest = {
    id: string;
    messages: AlgoliaAgentMessage[];
};

export type AlgoliaAgentResponse = {
    id: string | null;
    text: string;
    textParts: string[];
    raw: unknown;
};

export type AlgoliaAgentStreamUpdate = {
    text: string;
    textParts: string[];
    raw: unknown;
};

function assertEnvironment(): void {
    const algoliaSecretPath = process.env.ALGOLIA_SECRET_PATH;
    const algoliaAgentUrl = process.env.ALGOLIA_AGENT_URL;

    if (!algoliaSecretPath) {
        throw new Error('Missing ALGOLIA_SECRET_PATH environment variable');
    }
    if (!algoliaAgentUrl) {
        throw new Error('Missing ALGOLIA_AGENT_URL environment variable');
    }
}

function messageToText(role: 'user' | 'assistant', content: string): AlgoliaAgentMessage {
    return {
        role,
        parts: [{ type: 'text', text: content }],
    };
}

function shouldSkipIdentityHistoryMessage(content: string): boolean {
    const normalized = content
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();

    return (
        normalized.includes('who am i speaking with') ||
        normalized.includes('before i help, who am i speaking with') ||
        normalized.includes('a qui ai-je affaire') ||
        normalized.includes('dis-moi ton prenom et ton nom') ||
        normalized.includes('who are you') ||
        normalized.startsWith('je suis ') ||
        normalized.startsWith('i am ')
    );
}

function normalizeAgentUrl(rawUrl: string, stream: boolean): string {
    const normalized = rawUrl.trim().replace(/\s+/g, '');
    const parsed = new URL(normalized);
    const compatibilityMode = parsed.searchParams.get('compatibilityMode');
    if (compatibilityMode) {
        parsed.searchParams.set('compatibilityMode', compatibilityMode.replace(/\s+/g, ''));
    }
    parsed.searchParams.set('stream', stream ? 'true' : 'false');
    return parsed.toString();
}

function extractJsonFromSsePayload(payload: string): unknown {
    const events = payload
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((line) => line.length > 0 && line !== '[DONE]');

    if (events.length === 0) {
        throw new Error('Algolia streaming response did not contain data events');
    }

    const lastEvent = events[events.length - 1];
    return JSON.parse(lastEvent);
}

function flattenText(value: unknown, seen: Set<unknown> = new Set()): string[] {
    if (typeof value === 'string') {
        return value.trim().length > 0 ? [value.trim()] : [];
    }
    if (Array.isArray(value)) {
        return value.flatMap((entry) => flattenText(entry, seen));
    }
    if (!value || typeof value !== 'object') {
        return [];
    }
    if (seen.has(value)) {
        return [];
    }
    seen.add(value);

    const candidate = value as {
        text?: unknown;
        content?: unknown;
        parts?: unknown;
        message?: unknown;
        messages?: unknown;
        output_text?: unknown;
        type?: unknown;
        delta?: unknown;
    };

    const directText =
        candidate.type === 'text' && typeof candidate.text === 'string' && candidate.text.trim().length > 0
            ? [candidate.text.trim()]
            : typeof candidate.delta === 'string' && candidate.delta.trim().length > 0
              ? [candidate.delta.trim()]
              : [];

    return [
        ...directText,
        ...flattenText(candidate.output_text, seen),
        ...flattenText(candidate.text, seen),
        ...flattenText(candidate.content, seen),
        ...flattenText(candidate.parts, seen),
        ...flattenText(candidate.message, seen),
        ...flattenText(candidate.messages, seen),
    ];
}

export function extractAssistantTextParts(payload: unknown): string[] {
    if (!payload || typeof payload !== 'object') {
        return [];
    }

    const candidate = payload as {
        parts?: unknown;
        text?: unknown;
        output_text?: unknown;
        message?: unknown;
        messages?: unknown;
        choices?: unknown;
        response?: unknown;
    };

    return [
        ...flattenText(candidate.parts),
        ...flattenText(candidate.output_text),
        ...flattenText(candidate.text),
        ...flattenText(candidate.message),
        ...flattenText(candidate.messages),
        ...flattenText(candidate.choices),
        ...flattenText(candidate.response),
        ...flattenText(payload),
    ].filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);
}

function extractAssistantText(payload: unknown): string {
    const textParts = extractAssistantTextParts(payload);
    return textParts.join('\n\n').trim();
}

function base64UrlEncode(value: string): string {
    return Buffer.from(value)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function buildAlgoliaSecureUserToken(userId: string, keyId: string, secretKey: string): string {
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const header = {
        alg: 'HS256',
        typ: 'JWT',
        kid: keyId,
    };
    const payload = {
        sub: userId,
        exp: nowInSeconds + 24 * 60 * 60,
        iat: nowInSeconds,
    };
    const unsignedToken = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
    const signature = createHmac('sha256', secretKey)
        .update(unsignedToken)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');

    return `${unsignedToken}.${signature}`;
}

function buildAlgoliaMemoryUserId(discordUserId: string): string {
    return `discord:${discordUserId}`;
}

type AlgoliaRequestAuth = {
    headers: Record<string, string>;
    secureUserToken: string | null;
};

async function getAlgoliaRequestAuth(discordUserId?: string): Promise<AlgoliaRequestAuth> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    const appId = process.env.ALGOLIA_APP_ID;
    const apiKey = process.env.ALGOLIA_API_KEY;
    const keyIdFromEnv = process.env.ALGOLIA_KEY_ID;
    const secretKeyFromEnv = process.env.ALGOLIA_SECRET_KEY;

    if (appId && apiKey) {
        headers['X-Algolia-Application-Id'] = appId;
        headers['X-Algolia-API-Key'] = apiKey;

        if (discordUserId && keyIdFromEnv && secretKeyFromEnv) {
            const secureUserToken = buildAlgoliaSecureUserToken(
                buildAlgoliaMemoryUserId(discordUserId),
                keyIdFromEnv,
                secretKeyFromEnv,
            );
            headers['X-Algolia-Secure-User-Token'] = secureUserToken;
            return { headers, secureUserToken };
        }

        return { headers, secureUserToken: null };
    }

    assertEnvironment();
    const secret = (await getSecret(process.env.ALGOLIA_SECRET_PATH as string)) as AlgoliaCredentials | undefined;
    const fallbackApiKey = secret?.ALGOLIA_SEARCH_API_KEY || secret?.ALGOLIA_ADMIN_API_KEY;

    if (!secret?.ALGOLIA_APP_ID || !fallbackApiKey) {
        throw new Error('Missing Algolia credentials in Secrets Manager or environment');
    }

    headers['X-Algolia-Application-Id'] = secret.ALGOLIA_APP_ID;
    headers['X-Algolia-API-Key'] = fallbackApiKey;

    if (discordUserId && secret.ALGOLIA_KEY_ID && secret.ALGOLIA_SECRET_KEY) {
        const secureUserToken = buildAlgoliaSecureUserToken(
            buildAlgoliaMemoryUserId(discordUserId),
            secret.ALGOLIA_KEY_ID,
            secret.ALGOLIA_SECRET_KEY,
        );
        headers['X-Algolia-Secure-User-Token'] = secureUserToken;
        return { headers, secureUserToken };
    }

    return { headers, secureUserToken: null };
}

export function buildAlgoliaAgentMessages(
    history: ConversationHistoryMessage[],
    userInput: string,
    registeredUser?: RegisteredUserContext,
    platformContextMessages: string[] = [],
): AlgoliaAgentMessage[] {
    const messages: AlgoliaAgentMessage[] = [];

    if (registeredUser) {
        messages.push(
            messageToText(
                'assistant',
                `Verified member context from platform: Discord user ${registeredUser.id}, name ${registeredUser.firstName} ${registeredUser.lastName}, promo ${registeredUser.promo}. The user's identity is already verified. Do not ask who you are speaking with again. Use this verified identity directly for recommendations and actions.`,
            ),
        );
    }

    for (const contextMessage of platformContextMessages) {
        if (contextMessage.trim().length === 0) {
            continue;
        }
        messages.push(messageToText('assistant', contextMessage));
    }

    for (const message of history) {
        if (registeredUser && shouldSkipIdentityHistoryMessage(message.content)) {
            continue;
        }
        if (message.role === 'user' || message.role === 'assistant') {
            messages.push(messageToText(message.role, message.content));
        }
    }

    messages.push(messageToText('user', userInput));

    return messages;
}

export async function completeAlgoliaAgentConversation(params: {
    conversationId: string;
    history: ConversationHistoryMessage[];
    userInput: string;
    registeredUser?: RegisteredUserContext;
    discordUserId?: string;
}): Promise<AlgoliaAgentResponse> {
    const requestBody: AlgoliaAgentRequest = {
        id: params.conversationId,
        messages: buildAlgoliaAgentMessages(params.history, params.userInput, params.registeredUser),
    };

    return completeAlgoliaAgentMessages(params.conversationId, requestBody.messages, params.discordUserId);
}

export async function completeAlgoliaAgentMessages(
    conversationId: string,
    messages: AlgoliaAgentMessage[],
    discordUserId?: string,
): Promise<AlgoliaAgentResponse> {
    const { headers } = await getAlgoliaRequestAuth(discordUserId);
    const requestBody: AlgoliaAgentRequest = {
        id: conversationId,
        messages,
    };
    const response = await fetch(normalizeAgentUrl(process.env.ALGOLIA_AGENT_URL as string, false), {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Algolia agent completion failed: ${response.status} ${response.statusText} - ${body}`);
    }

    const responseText = await response.text();
    const payload = (
        responseText.trim().startsWith('data:')
            ? extractJsonFromSsePayload(responseText)
            : JSON.parse(responseText)
    ) as { id?: unknown };

    return {
        id: typeof payload.id === 'string' ? payload.id : conversationId,
        text: extractAssistantText(payload),
        textParts: extractAssistantTextParts(payload),
        raw: payload,
    };
}

type StreamingState = {
    id: string | null;
    parts: Array<Record<string, unknown>>;
    lastPayload: unknown;
};

function buildStreamingPayload(state: StreamingState): unknown {
    if (state.parts.length === 0) {
        return state.lastPayload;
    }
    return {
        id: state.id,
        role: 'assistant',
        parts: state.parts.map((part) => {
            const { __stream_id: _streamId, ...rest } = part;
            return rest;
        }),
    };
}

function ensureTextPart(state: StreamingState, partId: string): Record<string, unknown> {
    const existing = state.parts.find((part) => part.__stream_id === partId);
    if (existing) {
        return existing;
    }
    const created = {
        type: 'text',
        text: '',
        __stream_id: partId,
    };
    state.parts.push(created);
    return created;
}

function upsertToolPart(
    state: StreamingState,
    toolCallId: string,
    toolName: string,
    updates: Record<string, unknown>,
): Record<string, unknown> {
    const existing = state.parts.find((part) => part.tool_call_id === toolCallId);
    if (existing) {
        Object.assign(existing, updates);
        return existing;
    }
    const created = {
        type: `tool-${toolName}`,
        tool_call_id: toolCallId,
        ...updates,
    };
    state.parts.push(created);
    return created;
}

function applyStreamingEvent(state: StreamingState, payload: unknown): unknown {
    state.lastPayload = payload;
    if (!payload || typeof payload !== 'object') {
        return buildStreamingPayload(state);
    }

    const candidate = payload as Record<string, unknown>;
    if (typeof candidate.id === 'string') {
        state.id = candidate.id;
    }
    if (candidate.role === 'assistant' && Array.isArray(candidate.parts)) {
        state.parts = (candidate.parts as Array<Record<string, unknown>>).map((part) => ({ ...part }));
        return buildStreamingPayload(state);
    }

    const eventType = typeof candidate.type === 'string' ? candidate.type : undefined;
    if (!eventType) {
        return buildStreamingPayload(state);
    }

    if (eventType === 'start' && typeof candidate.messageId === 'string') {
        state.id = candidate.messageId;
        return buildStreamingPayload(state);
    }
    if (eventType === 'step-start' || eventType === 'start-step') {
        state.parts.push({ type: 'step-start' });
        return buildStreamingPayload(state);
    }
    if (eventType === 'text-start' && typeof candidate.id === 'string') {
        ensureTextPart(state, candidate.id);
        return buildStreamingPayload(state);
    }
    if (eventType === 'text-delta' && typeof candidate.id === 'string' && typeof candidate.delta === 'string') {
        const part = ensureTextPart(state, candidate.id);
        const currentText = typeof part.text === 'string' ? part.text : '';
        part.text = `${currentText}${candidate.delta}`;
        return buildStreamingPayload(state);
    }
    if (eventType === 'text-end') {
        return buildStreamingPayload(state);
    }

    const toolName =
        typeof candidate.toolName === 'string'
            ? candidate.toolName
            : typeof candidate.name === 'string'
              ? candidate.name
              : undefined;
    const toolCallId =
        typeof candidate.toolCallId === 'string'
            ? candidate.toolCallId
            : typeof candidate.tool_call_id === 'string'
              ? candidate.tool_call_id
              : undefined;

    if (toolName && toolCallId && eventType.includes('tool')) {
        if (candidate.input && typeof candidate.input === 'object') {
            upsertToolPart(state, toolCallId, toolName, {
                state: eventType.includes('output') ? 'output-available' : 'input-available',
                input: candidate.input,
                output: candidate.output,
            });
        } else if (candidate.output && typeof candidate.output === 'object') {
            upsertToolPart(state, toolCallId, toolName, {
                state: 'output-available',
                output: candidate.output,
            });
        }
    }

    return buildStreamingPayload(state);
}

function parseSseBlock(block: string): string | null {
    const dataLines = block
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());

    if (dataLines.length === 0) {
        return null;
    }

    return dataLines.join('\n');
}

export async function streamAlgoliaAgentMessages(
    conversationId: string,
    messages: AlgoliaAgentMessage[],
    discordUserId?: string,
    onUpdate?: (update: AlgoliaAgentStreamUpdate) => Promise<void> | void,
): Promise<AlgoliaAgentResponse> {
    const { headers } = await getAlgoliaRequestAuth(discordUserId);
    const requestBody: AlgoliaAgentRequest = {
        id: conversationId,
        messages,
    };
    const response = await fetch(normalizeAgentUrl(process.env.ALGOLIA_AGENT_URL as string, true), {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Algolia agent completion failed: ${response.status} ${response.statusText} - ${body}`);
    }

    if (!response.body) {
        return completeAlgoliaAgentMessages(conversationId, messages, discordUserId);
    }

    const state: StreamingState = {
        id: null,
        parts: [],
        lastPayload: null,
    };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastText = '';
    let lastPayload: unknown = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });
        let separatorIndex = buffer.indexOf('\n\n');
        while (separatorIndex !== -1) {
            const block = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);
            separatorIndex = buffer.indexOf('\n\n');

            const data = parseSseBlock(block);
            if (!data || data === '[DONE]') {
                continue;
            }

            const parsed = JSON.parse(data) as unknown;
            const payload = applyStreamingEvent(state, parsed);
            lastPayload = payload;
            const textParts = extractAssistantTextParts(payload);
            const text = textParts.join('\n\n').trim();

            if (onUpdate && text !== lastText) {
                await onUpdate({ text, textParts, raw: payload });
                lastText = text;
            }
        }
    }

    if (buffer.trim().length > 0) {
        const data = parseSseBlock(buffer);
        if (data && data !== '[DONE]') {
            const parsed = JSON.parse(data) as unknown;
            lastPayload = applyStreamingEvent(state, parsed);
        }
    }

    const payload = lastPayload || buildStreamingPayload(state);
    return {
        id:
            payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string'
                ? ((payload as { id: string }).id as string)
                : conversationId,
        text: extractAssistantText(payload),
        textParts: extractAssistantTextParts(payload),
        raw: payload,
    };
}
