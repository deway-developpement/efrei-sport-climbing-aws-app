import { DmConversation, DmConversationMessage, User } from '../../../layers/commons/dynamodb.types';
import { trimConversationMessages } from '../../../layers/commons/dynamodb.dm_conversations';

export const DEFAULT_HISTORY_LIMIT = 20;
export const DEFAULT_CONTEXT_RESET_HOURS = 1;
export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_DISCORD_MESSAGE_LENGTH = 2000;

export function buildConversationId(discordUserId: string, now: Date = new Date()): string {
    return `discord-dm:${discordUserId}:${now.getTime()}`;
}

export function normalizeUserInput(content: string): string {
    return content.trim();
}

export function splitDiscordMessage(content: string, maxLength: number = MAX_DISCORD_MESSAGE_LENGTH): string[] {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
        return [];
    }
    if (trimmed.length <= maxLength) {
        return [trimmed];
    }

    const chunks: string[] = [];
    let remaining = trimmed;
    while (remaining.length > maxLength) {
        const candidate = remaining.slice(0, maxLength);
        const splitAt = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));
        const index = splitAt > 0 ? splitAt : maxLength;
        chunks.push(remaining.slice(0, index).trim());
        remaining = remaining.slice(index).trim();
    }
    if (remaining.length > 0) {
        chunks.push(remaining);
    }
    return chunks;
}

export function buildConversationExpiration(now: Date, retentionDays: number): Date {
    return new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

export function isConversationExpired(
    conversation: DmConversation | undefined,
    now: Date,
    contextResetHours: number = DEFAULT_CONTEXT_RESET_HOURS,
): boolean {
    if (!conversation) {
        return false;
    }
    const resetAt = conversation.updatedAt.getTime() + contextResetHours * 60 * 60 * 1000;
    return resetAt <= now.getTime();
}

export function buildUpdatedConversation(params: {
    existing?: DmConversation;
    discordUserId: string;
    discordUsername: string | null;
    registeredUser?: User;
    userMessageId: string;
    userInput: string;
    assistantReply: string;
    now: Date;
    historyLimit?: number;
    retentionDays?: number;
}): DmConversation {
    const historyLimit = params.historyLimit || DEFAULT_HISTORY_LIMIT;
    const retentionDays = params.retentionDays || DEFAULT_RETENTION_DAYS;
    const history = params.existing?.messages || [];
    const nextMessages: DmConversationMessage[] = trimConversationMessages(
        [
            ...history,
            {
                role: 'user',
                content: params.userInput,
                createdAt: params.now,
            },
            {
                role: 'assistant',
                content: params.assistantReply,
                createdAt: params.now,
            },
        ],
        historyLimit,
    );

    return {
        discordUserId: params.discordUserId,
        discordUsername: params.discordUsername,
        registeredUserId: params.registeredUser?.id || params.existing?.registeredUserId || null,
        registeredFirstName: params.registeredUser?.firstName || params.existing?.registeredFirstName || null,
        registeredLastName: params.registeredUser?.lastName || params.existing?.registeredLastName || null,
        registeredPromo: params.registeredUser?.promo || params.existing?.registeredPromo || null,
        identifiedUserName: params.existing?.identifiedUserName || null,
        algoliaConversationId: params.existing?.algoliaConversationId || buildConversationId(params.discordUserId, params.now),
        lastProcessedMessageId: params.userMessageId,
        messages: nextMessages,
        updatedAt: params.now,
        expiresAt: buildConversationExpiration(params.now, retentionDays),
    };
}
