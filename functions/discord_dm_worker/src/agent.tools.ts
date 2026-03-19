import { AlgoliaAgentMessage } from '../../../layers/commons/algolia.agent';
import { fetchCalendarEventsFromUrl, getCalendarEventsForUser } from '../../../layers/commons/calendar.events';
import { DiscordEmbed } from '../../../layers/commons/discord.types';
import { getAssociationAnnouncement } from '../../../layers/commons/dynamodb.association_announcements';
import {
    deleteUserCalendarFeed,
    putUserCalendarFeed,
    updateUserCalendarFeedFetchStatus,
} from '../../../layers/commons/dynamodb.user_calendar_feeds';
import { User } from '../../../layers/commons/dynamodb.types';
import { buildDiscordSessionEmbed } from '../../../layers/commons/session.discord.embed';
import {
    createOrJoinSessionWorkflow,
    joinSessionWorkflow,
    leaveSessionWorkflow,
    SessionAuthorMeta,
} from '../../../layers/commons/session.discord.workflows';

type ToolPart = {
    type?: unknown;
    state?: unknown;
    input?: unknown;
    output?: unknown;
    tool_call_id?: unknown;
    toolCallId?: unknown;
};

type ExecutableToolCall = {
    toolName:
        | 'create_session'
        | 'join_session'
        | 'leave_session'
        | 'create_session_embed'
        | 'save_calendar_feed'
        | 'get_calendar_events'
        | 'remove_calendar_feed'
        | 'get_announce_detail';
    index: number;
    part: ToolPart;
};

export type SessionActionToolOutput = {
    kind: 'session_action';
    toolName: 'create_session' | 'join_session' | 'leave_session';
    action: 'created' | 'joined' | 'left' | 'deleted';
    sessionId: string;
    sessionUrl: string | null;
    location: string;
    date: string;
    message: string;
};

export type SessionEmbedToolOutput = {
    kind: 'session_embed';
    toolName: 'create_session_embed';
    sessionId: string;
    personalizedMessage: string;
    embed: DiscordEmbed;
};

type SessionEmbedToolModelOutput = {
    kind: 'session_embed';
    toolName: 'create_session_embed';
    sessionId: string;
    personalizedMessage: string;
    message: string;
};

export type SessionToolOutput = SessionActionToolOutput | SessionEmbedToolOutput;

export type CalendarFeedSavedToolOutput = {
    kind: 'calendar_feed_saved';
    toolName: 'save_calendar_feed';
    url: string;
    message: string;
};

export type CalendarEventsToolOutput = {
    kind: 'calendar_events';
    toolName: 'get_calendar_events';
    events: Array<{
        title: string;
        startIso: string;
        endIso: string;
        allDay?: boolean;
        location?: string | null;
    }>;
    startIso: string;
    endIso: string;
    missingCalendarFeed: boolean;
    message?: string;
};

export type CalendarFeedRemovedToolOutput = {
    kind: 'calendar_feed_removed';
    toolName: 'remove_calendar_feed';
    message: string;
};

export type AnnouncementDetailToolOutput = {
    kind: 'announcement_detail';
    toolName: 'get_announce_detail';
    announcementId: string;
    sourceMessageId: string | null;
    sourceChannelId: string | null;
    title: string;
    content: string;
    startsAtIso: string;
    endsAtIso: string;
    sourceUrl: string | null;
    tags: string[];
    message: string;
};

export type ToolExecutionOutput =
    | SessionActionToolOutput
    | SessionEmbedToolOutput
    | CalendarFeedSavedToolOutput
    | CalendarEventsToolOutput
    | CalendarFeedRemovedToolOutput
    | AnnouncementDetailToolOutput;

function isClientToolName(name: string): name is ExecutableToolCall['toolName'] {
    return (
        name === 'create_session' ||
        name === 'join_session' ||
        name === 'leave_session' ||
        name === 'create_session_embed' ||
        name === 'save_calendar_feed' ||
        name === 'get_calendar_events' ||
        name === 'remove_calendar_feed' ||
        name === 'get_announce_detail'
    );
}

function getToolState(part: ToolPart): string | undefined {
    return typeof part.state === 'string' ? part.state : undefined;
}

function getToolName(part: ToolPart): ExecutableToolCall['toolName'] | undefined {
    if (typeof part.type !== 'string' || !part.type.startsWith('tool-')) {
        return;
    }
    const toolName = part.type.slice('tool-'.length);
    return isClientToolName(toolName) ? toolName : undefined;
}

export function parseSessionDate(input: Record<string, unknown>): Date {
    const timezone = typeof input.timezone === 'string' && input.timezone.trim().length > 0 ? input.timezone : 'Europe/Paris';
    const localDate = typeof input.localDate === 'string' ? input.localDate : undefined;
    const localTime = typeof input.localTime === 'string' ? input.localTime : undefined;
    if (localDate) {
        return buildLocalDateTime({
            localDate,
            localTime,
            hour: toOptionalNumber(input.hour),
            minute: toOptionalNumber(input.minute),
            timezone,
        });
    }

    const dayOfWeek = typeof input.dayOfWeek === 'string' ? input.dayOfWeek : undefined;
    if (dayOfWeek) {
        return buildRelativeWeekDateTime({
            dayOfWeek,
            relativeWeek: typeof input.relativeWeek === 'string' ? input.relativeWeek : undefined,
            weekOffset: toOptionalNumber(input.weekOffset),
            hour: toOptionalNumber(input.hour),
            minute: toOptionalNumber(input.minute),
            timezone,
        });
    }

    const rawIsoValue =
        input.dateIso || input.startsAt || input.datetime || input.dateTime || (typeof input.date === 'string' ? input.date : undefined);
    if (typeof rawIsoValue === 'string') {
        const parsed = new Date(rawIsoValue);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed;
        }
    }

    throw new Error(
        'create_session requires either dateIso or local scheduling fields (dayOfWeek/localDate plus hour or localTime)',
    );
}

function getStringInput(input: Record<string, unknown>, key: string): string {
    const value = input[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`Missing required tool input: ${key}`);
    }
    return value.trim();
}

function getOptionalStringInput(input: Record<string, unknown>, key: string): string | undefined {
    const value = input[key];
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function getWorkflowResponseMessage(response: { content?: string }): string {
    return typeof response.content === 'string' && response.content.trim().length > 0
        ? response.content.trim()
        : 'Action effectuée.';
}

function parseIsoDateInput(input: Record<string, unknown>, key: string): Date {
    const value = getStringInput(input, key);
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid ISO datetime for ${key}: ${value}`);
    }
    return parsed;
}

function validateCalendarUrl(value: string): string {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Unsupported calendar URL protocol: ${parsed.protocol}`);
    }
    return parsed.toString();
}

function toOptionalNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

function getTimeZoneOffsetMilliseconds(date: Date, timezone: string): number {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'shortOffset',
    });
    const timeZoneName = formatter.formatToParts(date).find((part) => part.type === 'timeZoneName')?.value;
    const match = timeZoneName?.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
    if (!match) {
        return 0;
    }
    const sign = match[1] === '-' ? -1 : 1;
    const hours = parseInt(match[2], 10);
    const minutes = match[3] ? parseInt(match[3], 10) : 0;
    return sign * (hours * 60 + minutes) * 60 * 1000;
}

function buildZonedDate(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date {
    const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
    const initialOffset = getTimeZoneOffsetMilliseconds(utcGuess, timezone);
    let resolved = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0) - initialOffset);
    const resolvedOffset = getTimeZoneOffsetMilliseconds(resolved, timezone);
    if (resolvedOffset !== initialOffset) {
        resolved = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0) - resolvedOffset);
    }
    return resolved;
}

function getLocalDateParts(now: Date, timezone: string): { year: number; month: number; day: number } {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const parts = formatter.formatToParts(now);
    return {
        year: parseInt(parts.find((part) => part.type === 'year')?.value || '0', 10),
        month: parseInt(parts.find((part) => part.type === 'month')?.value || '0', 10),
        day: parseInt(parts.find((part) => part.type === 'day')?.value || '0', 10),
    };
}

function normalizeWeekday(value: string): number {
    const normalized = value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
    const mapping: Record<string, number> = {
        monday: 0,
        lundi: 0,
        tuesday: 1,
        mardi: 1,
        wednesday: 2,
        mercredi: 2,
        thursday: 3,
        jeudi: 3,
        friday: 4,
        vendredi: 4,
        saturday: 5,
        samedi: 5,
        sunday: 6,
        dimanche: 6,
    };
    const mapped = mapping[normalized];
    if (mapped === undefined) {
        throw new Error(`Unsupported dayOfWeek value: ${value}`);
    }
    return mapped;
}

function resolveHourAndMinute(input: { localTime?: string; hour?: number; minute?: number }): { hour: number; minute: number } {
    if (input.localTime) {
        const match = input.localTime.match(/^(\d{1,2}):(\d{2})$/);
        if (!match) {
            throw new Error(`Invalid localTime value: ${input.localTime}`);
        }
        return {
            hour: parseInt(match[1], 10),
            minute: parseInt(match[2], 10),
        };
    }
    return {
        hour: input.hour ?? 18,
        minute: input.minute ?? 0,
    };
}

function buildLocalDateTime(params: {
    localDate: string;
    localTime?: string;
    hour?: number;
    minute?: number;
    timezone: string;
}): Date {
    const match = params.localDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        throw new Error(`Invalid localDate value: ${params.localDate}`);
    }
    const { hour, minute } = resolveHourAndMinute(params);
    return buildZonedDate(
        parseInt(match[1], 10),
        parseInt(match[2], 10),
        parseInt(match[3], 10),
        hour,
        minute,
        params.timezone,
    );
}

function buildRelativeWeekDateTime(params: {
    dayOfWeek: string;
    relativeWeek?: string;
    weekOffset?: number;
    hour?: number;
    minute?: number;
    timezone: string;
}): Date {
    const today = getLocalDateParts(new Date(), params.timezone);
    const todayReference = new Date(Date.UTC(today.year, today.month - 1, today.day));
    const todayIsoIndex = (todayReference.getUTCDay() + 6) % 7;
    const mondayReference = new Date(todayReference);
    mondayReference.setUTCDate(todayReference.getUTCDate() - todayIsoIndex);

    const relativeWeek = params.relativeWeek?.trim().toLowerCase();
    let weekOffset = params.weekOffset;
    if (weekOffset === undefined) {
        if (relativeWeek === 'next' || relativeWeek === 'next_week' || relativeWeek === 'semaine_prochaine') {
            weekOffset = 1;
        } else {
            weekOffset = 0;
        }
    }

    const targetIsoIndex = normalizeWeekday(params.dayOfWeek);
    const targetReference = new Date(mondayReference);
    targetReference.setUTCDate(mondayReference.getUTCDate() + weekOffset * 7 + targetIsoIndex);
    const { hour, minute } = resolveHourAndMinute(params);

    return buildZonedDate(
        targetReference.getUTCFullYear(),
        targetReference.getUTCMonth() + 1,
        targetReference.getUTCDate(),
        hour,
        minute,
        params.timezone,
    );
}

export function extractPendingSessionToolCalls(raw: unknown): ExecutableToolCall[] {
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { parts?: unknown }).parts)) {
        return [];
    }
    const parts = (raw as { parts: ToolPart[] }).parts;
    return parts.flatMap((part, index) => {
        const toolName = getToolName(part);
        const state = getToolState(part);
        if (!toolName || (state !== 'input-available' && state !== 'call')) {
            return [];
        }
        return [{ toolName, index, part }];
    });
}

export function extractSessionToolOutputMessages(raw: unknown): string[] {
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { parts?: unknown }).parts)) {
        return [];
    }
    const parts = (raw as { parts: ToolPart[] }).parts;
    return parts.flatMap((part) => {
        if (typeof part.type !== 'string' || !part.type.startsWith('tool-')) {
            return [];
        }
        const output = part.output as Record<string, unknown> | undefined;
        if (output?.kind !== 'session_action') {
            return [];
        }
        const message = output.message;
        return typeof message === 'string' && message.trim().length > 0 ? [message.trim()] : [];
    });
}

function toModelToolOutput(
    output: ToolExecutionOutput,
):
    | SessionActionToolOutput
    | SessionEmbedToolModelOutput
    | CalendarFeedSavedToolOutput
    | CalendarEventsToolOutput
    | CalendarFeedRemovedToolOutput
    | AnnouncementDetailToolOutput {
    if (output.kind === 'session_action') {
        return output;
    }
    if (output.kind !== 'session_embed') {
        return output;
    }

    return {
        kind: 'session_embed',
        toolName: 'create_session_embed',
        sessionId: output.sessionId,
        personalizedMessage: output.personalizedMessage,
        message: 'Session embed rendered successfully.',
    };
}

async function executeSingleToolCall(
    toolCall: ExecutableToolCall,
    user: User | undefined,
    discordUserId: string | undefined,
    author?: SessionAuthorMeta,
): Promise<ToolExecutionOutput> {
    const input = (toolCall.part.input || {}) as Record<string, unknown>;

    if (toolCall.toolName === 'create_session') {
        if (!user) {
            throw new Error("L'utilisateur doit être inscrit avant de créer une séance.");
        }
        const result = await createOrJoinSessionWorkflow(user, parseSessionDate(input), getStringInput(input, 'location'), author);
        return {
            kind: 'session_action',
            toolName: 'create_session',
            action: result.action,
            sessionId: result.session.id,
            sessionUrl: result.sessionUrl,
            location: result.session.location,
            date: result.session.date.toISOString(),
            message: getWorkflowResponseMessage(result.response),
        };
    }

    if (toolCall.toolName === 'join_session') {
        if (!user) {
            throw new Error("L'utilisateur doit être inscrit avant de rejoindre une séance.");
        }
        const result = await joinSessionWorkflow(user, getStringInput(input, 'sessionId'));
        return {
            kind: 'session_action',
            toolName: 'join_session',
            action: result.action,
            sessionId: result.session.id,
            sessionUrl: result.sessionUrl,
            location: result.session.location,
            date: result.session.date.toISOString(),
            message: getWorkflowResponseMessage(result.response),
        };
    }

    if (toolCall.toolName === 'leave_session') {
        if (!user) {
            throw new Error("L'utilisateur doit être inscrit avant de quitter une séance.");
        }
        const result = await leaveSessionWorkflow(user, getStringInput(input, 'sessionId'));
        return {
            kind: 'session_action',
            toolName: 'leave_session',
            action: result.action,
            sessionId: result.session.id,
            sessionUrl: result.sessionUrl,
            location: result.session.location,
            date: result.session.date.toISOString(),
            message: getWorkflowResponseMessage(result.response),
        };
    }

    if (toolCall.toolName === 'create_session_embed') {
        const sessionId = getStringInput(input, 'sessionId');
        const personalizedMessage =
            getOptionalStringInput(input, 'message') || 'Je pense que cette séance correspond bien à ce que tu cherches.';
        const embed = await buildDiscordSessionEmbed(sessionId, personalizedMessage);
        return {
            kind: 'session_embed',
            toolName: 'create_session_embed',
            sessionId,
            personalizedMessage,
            embed,
        };
    }

    if (toolCall.toolName === 'get_announce_detail') {
        const announcementId = getStringInput(input, 'announcementId');
        const announcement = await getAssociationAnnouncement(announcementId);
        if (!announcement) {
            throw new Error(`Announcement not found: ${announcementId}`);
        }
        return {
            kind: 'announcement_detail',
            toolName: 'get_announce_detail',
            announcementId: announcement.id,
            sourceMessageId: announcement.sourceMessageId,
            sourceChannelId: announcement.sourceChannelId,
            title: announcement.title,
            content: announcement.content,
            startsAtIso: announcement.startsAt.toISOString(),
            endsAtIso: announcement.endsAt.toISOString(),
            sourceUrl: announcement.sourceUrl,
            tags: announcement.tags,
            message: 'Announcement detail loaded successfully.',
        };
    }

    if (!discordUserId) {
        throw new Error('Missing Discord user id for calendar tools.');
    }

    if (toolCall.toolName === 'save_calendar_feed') {
        const url = validateCalendarUrl(getStringInput(input, 'url'));
        await fetchCalendarEventsFromUrl(url, {
            start: new Date(Date.now() - 24 * 60 * 60 * 1000),
            end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
        await putUserCalendarFeed(discordUserId, url);
        await updateUserCalendarFeedFetchStatus(discordUserId, 'success', { now: new Date() });
        return {
            kind: 'calendar_feed_saved',
            toolName: 'save_calendar_feed',
            url,
            message: 'Calendar feed saved successfully.',
        };
    }

    if (toolCall.toolName === 'get_calendar_events') {
        const start = parseIsoDateInput(input, 'startIso');
        const end = parseIsoDateInput(input, 'endIso');
        if (end.getTime() <= start.getTime()) {
            throw new Error('endIso must be after startIso');
        }
        const startIso = start.toISOString();
        const endIso = end.toISOString();
        const result = await getCalendarEventsForUser(discordUserId, { start, end });
        if (result.missingCalendarFeed) {
            return {
                kind: 'calendar_events',
                toolName: 'get_calendar_events',
                events: [],
                startIso,
                endIso,
                missingCalendarFeed: true,
                message: 'No calendar feed is saved for this user.',
            };
        }
        await updateUserCalendarFeedFetchStatus(discordUserId, 'success', { now: new Date() });
        return {
            kind: 'calendar_events',
            toolName: 'get_calendar_events',
            events: result.events,
            startIso,
            endIso,
            missingCalendarFeed: false,
        };
    }

    if (toolCall.toolName === 'remove_calendar_feed') {
        await deleteUserCalendarFeed(discordUserId);
        return {
            kind: 'calendar_feed_removed',
            toolName: 'remove_calendar_feed',
            message: 'Calendar feed removed successfully.',
        };
    }

    throw new Error(`Unsupported tool call: ${String(toolCall.toolName)}`);
}

export async function executePendingSessionTools(params: {
    raw: unknown;
    user?: User;
    discordUserId?: string;
    author?: SessionAuthorMeta;
}): Promise<{ applied: boolean; message: AlgoliaAgentMessage | null; outputs: ToolExecutionOutput[] }> {
    const toolCalls = extractPendingSessionToolCalls(params.raw);
    if (toolCalls.length === 0) {
        return { applied: false, message: null, outputs: [] };
    }

    const rawMessage = params.raw as { role?: unknown; parts?: ToolPart[] };
    if (rawMessage.role !== 'assistant' || !Array.isArray(rawMessage.parts)) {
        throw new Error('Expected assistant message with tool parts');
    }

    const outputEntries = await Promise.all(
        toolCalls.map(async (toolCall) => ({
            index: toolCall.index,
            part: toolCall.part,
            output: await executeSingleToolCall(toolCall, params.user, params.discordUserId, params.author),
        })),
    );
    const nextParts = outputEntries.map((entry) => ({
        ...entry.part,
        state: 'output-available',
        output: toModelToolOutput(entry.output),
    }));

    return {
        applied: true,
        outputs: outputEntries.map((entry) => entry.output),
        message: {
            role: 'assistant',
            parts: nextParts,
        },
    };
}
