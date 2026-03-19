import { APIEmbed, ChannelType, Client, Events, GatewayIntentBits, Message, PartialMessage, Partials } from 'discord.js';
import { mkdir, open, readFile, rm } from 'fs/promises';
import path from 'path';
import {
    buildAlgoliaAgentMessages,
    streamAlgoliaAgentMessages,
} from '../../../layers/commons/algolia.agent';
import { getSecret } from '../../../layers/commons/aws.secret';
import {
    deleteAssociationAnnouncement,
    listAssociationAnnouncementsForWindow,
    putAssociationAnnouncement,
} from '../../../layers/commons/dynamodb.association_announcements';
import { User } from '../../../layers/commons/dynamodb.types';
import { getUser } from '../../../layers/commons/dynamodb.users';
import { executePendingSessionTools, ToolExecutionOutput } from './agent.tools';
import {
    buildAnnouncementWindowStart,
    buildAnnouncementWindowEnd,
    buildAssociationAnnouncementFromDiscordMessage,
    formatAnnouncementsPromptContext,
    isTrackedAnnouncementChannel,
    parseAnnouncementChannelIds,
    parseAnnouncementLookbackDays,
    parseAnnouncementLookaheadDays,
    parseAnnouncementRetentionDays,
    parseDiscordAnnouncementActiveDays,
} from './association.announcements';
import { compactAnnouncementWithFallback } from './association.announcements.compactor';
import { createConversationStore } from './conversation.store';
import {
    buildConversationId,
    buildUpdatedConversation,
    DEFAULT_CONTEXT_RESET_HOURS,
    DEFAULT_HISTORY_LIMIT,
    DEFAULT_RETENTION_DAYS,
    isConversationExpired,
    normalizeUserInput,
    splitDiscordMessage,
} from './discord.dm.worker';

const DISCORD_BOT_TOKEN_SECRET_PATH =
    process.env.DISCORD_BOT_TOKEN_SECRET_PATH || 'Efrei-Sport-Climbing-App/secrets/discord_bot_token';
const HISTORY_LIMIT = parseInteger(process.env.DM_CONVERSATION_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT);
const CONTEXT_RESET_HOURS = parseInteger(process.env.DM_CONVERSATION_RESET_HOURS, DEFAULT_CONTEXT_RESET_HOURS);
const RETENTION_DAYS = resolveConversationRetentionDays();
const ANNOUNCEMENT_LOOKBACK_DAYS = parseAnnouncementLookbackDays(process.env.DM_ANNOUNCEMENT_LOOKBACK_DAYS);
const ANNOUNCEMENT_LOOKAHEAD_DAYS = parseAnnouncementLookaheadDays(process.env.DM_ANNOUNCEMENT_LOOKAHEAD_DAYS);
const ANNOUNCEMENT_RETENTION_DAYS = parseAnnouncementRetentionDays(process.env.DM_ANNOUNCEMENT_RETENTION_DAYS);
const DISCORD_ANNOUNCEMENT_ACTIVE_DAYS = parseDiscordAnnouncementActiveDays(process.env.DISCORD_ANNOUNCEMENT_ACTIVE_DAYS);
const DISCORD_ANNOUNCEMENT_CHANNEL_IDS = parseAnnouncementChannelIds(process.env.DISCORD_ANNOUNCEMENTS_CHANNEL_IDS);
const DISABLE_REGISTERED_USER_LOOKUP = process.env.DM_DISABLE_REGISTERED_USER_LOOKUP === 'true';
const conversationStore = createConversationStore();
const userProcessingQueue = new Map<string, Promise<void>>();
const recentDmMessageIds = new Map<string, number>();
const RECENT_DM_MESSAGE_TTL_MS = 10 * 60 * 1000;
const WORKER_LOCK_FILE_PATH = path.resolve(process.cwd(), '.data/discord-dm-worker.lock');
const TYPING_KEEPALIVE_INTERVAL_MS = 8 * 1000;
const MAX_TOOL_ROUND_TRIPS = 8;

type DiscordSecret = {
    DISCORD_BOT_TOKEN: string;
};

type LiveReplyController = {
    update(textParts: string[], force?: boolean): Promise<void>;
    reset(): Promise<void>;
    finalize(): Promise<void>;
    getCurrentText(): string;
    getCurrentParts(): string[];
    hasRenderedMessage(): boolean;
};

function parseInteger(value: string | undefined, defaultValue: number): number {
    const parsed = value ? parseInt(value) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function resolveConversationRetentionDays(): number {
    const retentionDays = parseInteger(process.env.DM_CONVERSATION_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
    if (process.env.DM_CONVERSATION_RETENTION_DAYS) {
        return retentionDays;
    }

    const legacyTtlDays = parseInteger(process.env.DM_CONVERSATION_TTL_DAYS, 0);
    if (legacyTtlDays > 0) {
        return legacyTtlDays;
    }

    return DEFAULT_RETENTION_DAYS;
}

function previewLogText(value: string, limit = 500): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= limit) {
        return normalized;
    }
    return `${normalized.slice(0, limit)}…`;
}

function previewJsonForLog(value: unknown, limit = 1200): string {
    try {
        const serialized = JSON.stringify(value);
        if (serialized.length <= limit) {
            return serialized;
        }
        return `${serialized.slice(0, limit)}…`;
    } catch (error) {
        return `[unserializable:${error instanceof Error ? error.message : 'unknown'}]`;
    }
}

function buildDisplayableStreamingText(nextText: string, previousText: string, force = false): string {
    const trimmed = nextText.trim();
    if (force || trimmed.length === 0) {
        return trimmed;
    }

    const lastCharacter = trimmed.at(-1) || '';
    if (/[\s.,!?;:)\]]/.test(lastCharacter)) {
        return trimmed;
    }

    const boundaryCandidates = [
        trimmed.lastIndexOf('\n'),
        trimmed.lastIndexOf(' '),
        trimmed.lastIndexOf('.'),
        trimmed.lastIndexOf(','),
        trimmed.lastIndexOf('!'),
        trimmed.lastIndexOf('?'),
        trimmed.lastIndexOf(';'),
        trimmed.lastIndexOf(':'),
    ];
    const lastBoundary = Math.max(...boundaryCandidates);
    if (lastBoundary <= 0) {
        return previousText;
    }

    const candidate = trimmed.slice(0, lastBoundary).trim();
    return candidate.length >= previousText.length ? candidate : previousText;
}

function cleanupRecentDmMessageIds(now: number): void {
    for (const [messageId, timestamp] of recentDmMessageIds.entries()) {
        if (now - timestamp > RECENT_DM_MESSAGE_TTL_MS) {
            recentDmMessageIds.delete(messageId);
        }
    }
}

function markDmMessageSeen(messageId: string): void {
    const now = Date.now();
    cleanupRecentDmMessageIds(now);
    recentDmMessageIds.set(messageId, now);
}

function hasRecentlySeenDmMessage(messageId: string): boolean {
    const now = Date.now();
    cleanupRecentDmMessageIds(now);
    return recentDmMessageIds.has(messageId);
}

function startTypingKeepAlive(message: Message): () => void {
    let stopped = false;
    let interval: NodeJS.Timeout | null = null;
    const typingChannel = message.channel as Message['channel'] & {
        sendTyping(): Promise<void>;
    };

    const sendTyping = async () => {
        if (stopped) {
            return;
        }
        await typingChannel.sendTyping().catch((error: unknown) => {
            console.warn(`[discord-dm-worker] failed_typing_keepalive user=${message.author.id} messageId=${message.id}`, error);
        });
    };

    void sendTyping();
    interval = setInterval(() => {
        void sendTyping();
    }, TYPING_KEEPALIVE_INTERVAL_MS);

    return () => {
        stopped = true;
        if (interval) {
            clearInterval(interval);
            interval = null;
        }
    };
}

function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

async function acquireWorkerLock(): Promise<() => Promise<void>> {
    await mkdir(path.dirname(WORKER_LOCK_FILE_PATH), { recursive: true });

    async function createLockFile(): Promise<() => Promise<void>> {
        const handle = await open(WORKER_LOCK_FILE_PATH, 'wx');
        await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        await handle.close();

        return async () => {
            await rm(WORKER_LOCK_FILE_PATH, { force: true });
        };
    }

    try {
        return await createLockFile();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }

        try {
            const existingLock = JSON.parse(await readFile(WORKER_LOCK_FILE_PATH, 'utf8')) as { pid?: unknown };
            const existingPid =
                typeof existingLock.pid === 'number'
                    ? existingLock.pid
                    : typeof existingLock.pid === 'string'
                      ? parseInt(existingLock.pid, 10)
                      : Number.NaN;

            if (Number.isFinite(existingPid) && isProcessRunning(existingPid)) {
                throw new Error(`Another Discord DM worker is already running (pid ${existingPid}).`);
            }
        } catch (readError) {
            if (readError instanceof Error && readError.message.startsWith('Another Discord DM worker is already running')) {
                throw readError;
            }
        }

        await rm(WORKER_LOCK_FILE_PATH, { force: true });
        return createLockFile();
    }
}

function createLiveReplyController(triggerMessage: Message): LiveReplyController {
    let renderedParts: string[] = [];
    let pendingParts: string[] = [];
    const renderedMessages: Message[] = [];
    const channel = triggerMessage.channel as Message['channel'] & {
        send(content: string): Promise<Message>;
    };
    let lastFlushAt = 0;

    function flattenPartsToChunks(parts: string[]): string[] {
        return parts.flatMap((part) => splitDiscordMessage(part));
    }

    async function flush(force = false): Promise<void> {
        if (JSON.stringify(pendingParts) === JSON.stringify(renderedParts)) {
            return;
        }
        if (!force && Date.now() - lastFlushAt < 700) {
            return;
        }

        const chunks = flattenPartsToChunks(pendingParts);
        const safeChunks = chunks.length > 0 ? chunks : ['…'];

        for (let index = 0; index < safeChunks.length; index += 1) {
            if (!renderedMessages[index]) {
                renderedMessages[index] = await channel.send(safeChunks[index]);
            } else if (renderedMessages[index].content !== safeChunks[index]) {
                await renderedMessages[index].edit(safeChunks[index]);
            }
        }
        if (renderedMessages.length > safeChunks.length) {
            const extraMessages = renderedMessages.splice(safeChunks.length);
            for (const extraMessage of extraMessages) {
                await extraMessage.delete().catch(() => undefined);
            }
        }

        renderedParts = [...pendingParts];
        lastFlushAt = Date.now();
    }

    return {
        async update(textParts: string[], force = false) {
            pendingParts = textParts
                .map((part, index) => buildDisplayableStreamingText(part, renderedParts[index] || '', force))
                .filter((part) => part.trim().length > 0);
            await flush(force);
        },
        async reset() {
            pendingParts = [];
            renderedParts = [];
            lastFlushAt = 0;
            for (const renderedMessage of renderedMessages.splice(0, renderedMessages.length)) {
                await renderedMessage.delete().catch(() => undefined);
            }
        },
        async finalize() {
            await flush(true);
        },
        getCurrentText() {
            return (pendingParts.length > 0 ? pendingParts : renderedParts).join('\n\n').trim();
        },
        getCurrentParts() {
            return pendingParts.length > 0 ? [...pendingParts] : [...renderedParts];
        },
        hasRenderedMessage() {
            return renderedMessages.length > 0;
        },
    };
}

async function getDiscordBotToken(): Promise<string> {
    if (process.env.DISCORD_BOT_TOKEN) {
        return process.env.DISCORD_BOT_TOKEN;
    }
    const secret = (await getSecret(DISCORD_BOT_TOKEN_SECRET_PATH)) as DiscordSecret | undefined;
    if (!secret?.DISCORD_BOT_TOKEN) {
        throw new Error('Missing DISCORD_BOT_TOKEN in Secrets Manager or environment');
    }
    return secret.DISCORD_BOT_TOKEN;
}

async function getRegisteredUser(discordUserId: string): Promise<User | undefined> {
    if (DISABLE_REGISTERED_USER_LOOKUP) {
        return;
    }
    try {
        return await getUser(discordUserId);
    } catch (error) {
        if (error instanceof Error && error.message === 'User not found') {
            return;
        }
        console.warn(`Registered user lookup failed for ${discordUserId}`, error);
        throw error;
    }
}

async function syncAnnouncementMessage(message: Message): Promise<void> {
    const baseAnnouncement = buildAssociationAnnouncementFromDiscordMessage(
        {
            id: message.id,
            channelId: message.channelId,
            content: message.content,
            url: message.url,
            createdAt: message.createdAt,
            attachments: Array.from(message.attachments.values()).map((attachment) => ({
                url: attachment.url,
                name: attachment.name,
            })),
        },
        {
            activeDays: DISCORD_ANNOUNCEMENT_ACTIVE_DAYS,
            retentionDays: ANNOUNCEMENT_RETENTION_DAYS,
            source: 'discord_channel',
        },
    );

    if (!baseAnnouncement) {
        console.log(`[discord-dm-worker] skipped_empty_announcement_sync messageId=${message.id} channelId=${message.channelId}`);
        return;
    }

    const announcement = await compactAnnouncementWithFallback(baseAnnouncement);
    await putAssociationAnnouncement(announcement);
    console.log(
        `[discord-dm-worker] synced_announcement messageId=${message.id} channelId=${message.channelId} status=${announcement.compactionStatus} model=${announcement.compactionModel || 'none'} title="${previewLogText(
            announcement.title,
            120,
        )}"`,
    );
}

async function deleteAnnouncementMessage(messageId: string, channelId: string): Promise<void> {
    await deleteAssociationAnnouncement(messageId);
    console.log(`[discord-dm-worker] deleted_announcement messageId=${messageId} channelId=${channelId}`);
}

async function hydrateMessageIfNeeded(message: Message | PartialMessage): Promise<Message | null> {
    if (!message.partial) {
        return message as Message;
    }
    try {
        return await message.fetch();
    } catch (error) {
        console.warn(`[discord-dm-worker] failed_to_fetch_partial_message messageId=${message.id}`, error);
        return null;
    }
}

async function handleDirectMessage(message: Message): Promise<void> {
    if (message.author.bot || message.channel.type !== ChannelType.DM) {
        return;
    }

    const userInput = normalizeUserInput(message.content);
    const now = new Date();
    console.log(
        `[discord-dm-worker] received_dm user=${message.author.id} username=${message.author.username} messageId=${message.id} length=${userInput.length}`,
    );

    if (userInput.length === 0) {
        await message.channel.send('Je peux traiter uniquement les messages texte pour le moment.');
        return;
    }

    const storedConversation = await conversationStore.get(message.author.id);
    const existingConversation = isConversationExpired(storedConversation, now, CONTEXT_RESET_HOURS)
        ? undefined
        : storedConversation;
    if (existingConversation?.lastProcessedMessageId === message.id) {
        return;
    }

    let registeredUser: User | undefined;
    let platformContextMessages: string[] = [];
    try {
        registeredUser = await getRegisteredUser(message.author.id);
    } catch (error) {
        console.warn(`Continuing without registered user context for ${message.author.id}`, error);
    }

    try {
        const announcements = await listAssociationAnnouncementsForWindow(
            buildAnnouncementWindowStart(now, ANNOUNCEMENT_LOOKBACK_DAYS),
            buildAnnouncementWindowEnd(now, ANNOUNCEMENT_LOOKAHEAD_DAYS),
        );
        const announcementsContext = formatAnnouncementsPromptContext(announcements, {
            now,
            lookbackDays: ANNOUNCEMENT_LOOKBACK_DAYS,
            lookaheadDays: ANNOUNCEMENT_LOOKAHEAD_DAYS,
        });
        if (announcementsContext) {
            platformContextMessages = [announcementsContext];
        }
    } catch (error) {
        console.warn(`Continuing without association announcements context for ${message.author.id}`, error);
    }

    const liveReply = createLiveReplyController(message);
    const stopTypingKeepAlive = startTypingKeepAlive(message);
    try {
        const conversationId = existingConversation?.algoliaConversationId || buildConversationId(message.author.id, now);
        console.log(
            `[discord-dm-worker] start_completion user=${message.author.id} messageId=${message.id} conversationId=${conversationId}`,
        );
        let agentMessages = buildAlgoliaAgentMessages(
            existingConversation?.messages || [],
            userInput,
            registeredUser,
            platformContextMessages,
        );
        let latestVisibleReply = '';
        let latestVisibleParts: string[] = [];
        const executedToolOutputs: ToolExecutionOutput[] = [];
        let deferFinalTextUntilAfterEmbeds = false;
        const authorMeta = {
            authorName: message.member?.displayName || message.author.displayName || message.author.username,
            authorIconUrl: message.author.displayAvatarURL({ extension: 'png' }),
            authorUrl: `https://discord.com/users/${message.author.id}`,
        };
        let agentResponse = await streamAlgoliaAgentMessages(conversationId, agentMessages, message.author.id, async (update) => {
            if (update.text.length === 0) {
                return;
            }
            latestVisibleReply = update.text;
            latestVisibleParts = update.textParts;
            await liveReply.update(update.textParts);
        });

        let toolRoundTripCount = 0;
        while (true) {
            const toolExecution = await executePendingSessionTools({
                raw: agentResponse.raw,
                user: registeredUser,
                discordUserId: message.author.id,
                author: authorMeta,
            });
            if (!toolExecution.applied || !toolExecution.message) {
                break;
            }
            toolRoundTripCount += 1;
            if (toolRoundTripCount > MAX_TOOL_ROUND_TRIPS) {
                throw new Error(`Exceeded maximum tool round trips (${MAX_TOOL_ROUND_TRIPS}) before final assistant reply`);
            }
            executedToolOutputs.push(...toolExecution.outputs);
            if (toolExecution.outputs.some((output) => output.kind === 'session_embed')) {
                deferFinalTextUntilAfterEmbeds = true;
            }
            console.log(
                `[discord-dm-worker] tool_result_forwarded_to_model user=${message.author.id} messageId=${message.id} roundTrip=${toolRoundTripCount} payload=${previewJsonForLog(
                    toolExecution.message,
                )}`,
            );
            const hiddenIntermediateText =
                [agentResponse.text, latestVisibleReply, liveReply.getCurrentText()].find((value) => value.trim().length > 0)?.trim() || '';
            if (hiddenIntermediateText.length > 0) {
                console.log(
                    `[discord-dm-worker] hidden_intermediate_text_before_tool_reset user=${message.author.id} messageId=${message.id} roundTrip=${toolRoundTripCount} text="${previewLogText(
                        hiddenIntermediateText,
                    )}"`,
                );
            } else {
                console.log(
                    `[discord-dm-worker] hidden_intermediate_text_before_tool_reset user=${message.author.id} messageId=${message.id} roundTrip=${toolRoundTripCount} text=<empty>`,
                );
            }
            await liveReply.reset();
            agentMessages = [...agentMessages, toolExecution.message];
            agentResponse = await streamAlgoliaAgentMessages(conversationId, agentMessages, message.author.id, async (update) => {
                if (update.text.length === 0) {
                    return;
                }
                latestVisibleReply = update.text;
                latestVisibleParts = update.textParts;
                if (!deferFinalTextUntilAfterEmbeds) {
                    await liveReply.update(update.textParts);
                }
            });
        }
        const actionMessages = executedToolOutputs
            .flatMap((output) => (output.kind === 'session_action' ? [output.message.trim()] : []))
            .filter((messageText) => messageText.length > 0);
        const finalTextParts =
            agentResponse.textParts.length > 0
                ? agentResponse.textParts
                : latestVisibleParts.length > 0
                  ? latestVisibleParts
                  : liveReply.getCurrentParts();
        const finalVisibleReply =
            [agentResponse.text, latestVisibleReply, liveReply.getCurrentText()]
                .find((value) => value.trim().length > 0)
                ?.trim() || '';
        if (finalTextParts.length > 0 && !deferFinalTextUntilAfterEmbeds) {
            await liveReply.update(finalTextParts, true);
        }
        if (deferFinalTextUntilAfterEmbeds) {
            await liveReply.reset();
        } else {
            await liveReply.finalize();
        }
        console.log(
            `[discord-dm-worker] final_visible_reply user=${message.author.id} messageId=${message.id} text="${previewLogText(finalVisibleReply)}"`,
        );
        if (agentResponse.text.trim().length === 0) {
            console.log(
                `[discord-dm-worker] empty_final_agent_payload user=${message.author.id} messageId=${message.id} payload=${previewJsonForLog(
                    agentResponse.raw,
                )}`,
            );
        }
        console.log(
            `[discord-dm-worker] completion_received user=${message.author.id} messageId=${message.id} responseId=${agentResponse.id} replyLength=${agentResponse.text.length}`,
        );

        const sessionEmbedOutputs = executedToolOutputs.filter((output) => output.kind === 'session_embed');
        const finalActionStatus = actionMessages.at(-1) || '';
        const fullAssistantReply =
            finalActionStatus.length > 0 && finalActionStatus !== finalVisibleReply
                ? [finalVisibleReply, finalActionStatus].filter((value) => value.length > 0).join('\n\n')
                : finalVisibleReply;
        if (fullAssistantReply.length === 0 && sessionEmbedOutputs.length === 0) {
            throw new Error('Algolia agent returned an empty reply');
        }
        for (const embedOutput of sessionEmbedOutputs) {
            await message.channel.send({ embeds: [embedOutput.embed as APIEmbed] });
        }
        if (finalVisibleReply.length > 0 && deferFinalTextUntilAfterEmbeds) {
            await message.channel.send(finalVisibleReply);
        }
        if (finalActionStatus.length > 0) {
            await message.channel.send(finalActionStatus);
        }

        const conversation = buildUpdatedConversation({
            existing: existingConversation,
            discordUserId: message.author.id,
            discordUsername: message.author.username,
            registeredUser,
            userMessageId: message.id,
            userInput,
            assistantReply: fullAssistantReply,
            now,
            historyLimit: HISTORY_LIMIT,
            retentionDays: RETENTION_DAYS,
        });
        conversation.algoliaConversationId = agentResponse.id || conversationId;
        await conversationStore.put(conversation);
        console.log(
            `[discord-dm-worker] conversation_persisted user=${message.author.id} messageId=${message.id} storedMessages=${conversation.messages.length}`,
        );
    } catch (error) {
        const errorMessage = "Je n'ai pas pu traiter ton message. Réessaie dans quelques instants.";
            console.error(`Failed to handle DM for ${message.author.id}`, error);
            try {
                if (liveReply.hasRenderedMessage()) {
                    await liveReply.update([errorMessage], true);
                    await liveReply.finalize();
                } else {
                    await message.channel.send(errorMessage);
                }
        } catch (sendError) {
            console.error(`Failed to send DM error reply for ${message.author.id}`, sendError);
        }
    } finally {
        stopTypingKeepAlive();
    }
}

async function startWorker(): Promise<void> {
    const releaseWorkerLock = await acquireWorkerLock();
    const token = await getDiscordBotToken();
    const intents = [GatewayIntentBits.DirectMessages];
    if (DISCORD_ANNOUNCEMENT_CHANNEL_IDS.length > 0) {
        intents.push(GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
    }
    const client = new Client({
        intents,
        partials: [Partials.Channel, Partials.Message],
    });

    client.once(Events.ClientReady, (readyClient) => {
        console.log(`Discord DM worker connected as ${readyClient.user.tag}`);
    });

    client.on(Events.MessageCreate, async (message) => {
        if (
            !message.author.bot &&
            message.channel.type !== ChannelType.DM &&
            isTrackedAnnouncementChannel(message.channelId, DISCORD_ANNOUNCEMENT_CHANNEL_IDS)
        ) {
            await syncAnnouncementMessage(message).catch((error) => {
                console.error(`[discord-dm-worker] failed_announcement_sync messageId=${message.id}`, error);
            });
            return;
        }

        if (message.author.bot || message.channel.type !== ChannelType.DM) {
            return;
        }
        if (hasRecentlySeenDmMessage(message.id)) {
            console.log(`[discord-dm-worker] skipped_duplicate_dm user=${message.author.id} messageId=${message.id}`);
            return;
        }
        markDmMessageSeen(message.id);

        const previousTask = userProcessingQueue.get(message.author.id) || Promise.resolve();
        const currentTask = previousTask
            .catch(() => undefined)
            .then(async () => handleDirectMessage(message))
            .finally(() => {
                if (userProcessingQueue.get(message.author.id) === currentTask) {
                    userProcessingQueue.delete(message.author.id);
                }
            });

        userProcessingQueue.set(message.author.id, currentTask);
        await currentTask;
    });

    client.on(Events.MessageUpdate, async (_oldMessage, updatedMessage) => {
        const message = await hydrateMessageIfNeeded(updatedMessage);
        if (!message || message.author.bot) {
            return;
        }
        if (!isTrackedAnnouncementChannel(message.channelId, DISCORD_ANNOUNCEMENT_CHANNEL_IDS)) {
            return;
        }
        await syncAnnouncementMessage(message).catch((error) => {
            console.error(`[discord-dm-worker] failed_announcement_update_sync messageId=${message.id}`, error);
        });
    });

    client.on(Events.MessageDelete, async (deletedMessage) => {
        if (!isTrackedAnnouncementChannel(deletedMessage.channelId, DISCORD_ANNOUNCEMENT_CHANNEL_IDS)) {
            return;
        }
        await deleteAnnouncementMessage(deletedMessage.id, deletedMessage.channelId).catch((error) => {
            console.error(`[discord-dm-worker] failed_announcement_delete_sync messageId=${deletedMessage.id}`, error);
        });
    });

    const shutdown = async (signal: NodeJS.Signals) => {
        console.log(`Received ${signal}, shutting down Discord DM worker`);
        client.destroy();
        await releaseWorkerLock().catch(() => undefined);
        process.exit(0);
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    try {
        await client.login(token);
    } catch (error) {
        await releaseWorkerLock().catch(() => undefined);
        throw error;
    }
}

void startWorker().catch((error) => {
    console.error('Discord DM worker failed to start', error);
    process.exit(1);
});
