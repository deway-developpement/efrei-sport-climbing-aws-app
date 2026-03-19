import { AssociationAnnouncement } from '../../../layers/commons/dynamodb.types';
import { buildFallbackAnnouncementCompaction } from './association.announcements.compactor';

export const DEFAULT_ANNOUNCEMENT_LOOKAHEAD_DAYS = 7;
export const DEFAULT_ANNOUNCEMENT_LOOKBACK_DAYS = 30;
export const DEFAULT_ANNOUNCEMENT_RETENTION_DAYS = 30;
export const DEFAULT_DISCORD_ANNOUNCEMENT_ACTIVE_DAYS = 7;

const MAX_TITLE_LENGTH = 80;

type DiscordAnnouncementAttachment = {
    url: string;
    name: string | null;
};

export type DiscordAnnouncementMessageInput = {
    id: string;
    channelId: string;
    content: string;
    url: string;
    createdAt: Date;
    attachments: DiscordAnnouncementAttachment[];
};

function parsePositiveInteger(value: string | undefined, defaultValue: number, minimum = 1): number {
    const parsed = value ? parseInt(value, 10) : Number.NaN;
    if (!Number.isFinite(parsed)) {
        return defaultValue;
    }
    return Math.max(parsed, minimum);
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function clipText(value: string, maxLength: number): string {
    const normalized = normalizeWhitespace(value);
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, maxLength - 1).trim()}…`;
}

function formatAnnouncementDate(date: Date): string {
    return new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris',
        weekday: 'short',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
}

function extractHashtags(value: string): string[] {
    const matches = value.match(/#[\p{L}\p{N}_-]+/gu) || [];
    return matches.map((match) => match.slice(1).toLowerCase());
}

function buildAnnouncementText(input: DiscordAnnouncementMessageInput): string {
    const content = normalizeWhitespace(input.content);
    const attachmentLines = input.attachments.map((attachment) =>
        attachment.name ? `${attachment.name}: ${attachment.url}` : attachment.url,
    );
    return [content, ...attachmentLines].filter((value) => value.length > 0).join('\n');
}

function deriveAnnouncementTitle(text: string, createdAt: Date): string {
    const firstLine = text
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0);

    if (firstLine) {
        return clipText(firstLine.replace(/^#+\s*/, ''), MAX_TITLE_LENGTH);
    }

    return `Annonce du ${formatAnnouncementDate(createdAt)}`;
}

function buildAgeInDays(now: Date, endsAt: Date): number {
    return Math.max(0, Math.floor((now.getTime() - endsAt.getTime()) / (24 * 60 * 60 * 1000)));
}

function buildArchiveDigestLines(announcements: AssociationAnnouncement[], now: Date): string[] {
    const concise = announcements.filter((announcement) => {
        const ageInDays = buildAgeInDays(now, announcement.endsAt);
        return ageInDays >= 8 && ageInDays <= 14;
    });
    const archive = announcements.filter((announcement) => buildAgeInDays(now, announcement.endsAt) >= 15);

    const lines: string[] = [];

    if (concise.length > 0) {
        lines.push(
            `Recent archive (8-14 days old): ${concise
                .slice(0, 5)
                .map(
                    (announcement) =>
                        `${formatAnnouncementDate(announcement.startsAt)} ${
                            announcement.summaryArchive || announcement.title
                        }${announcement.sourceMessageId ? ` [ref: ${announcement.sourceMessageId}]` : ''}`,
                )
                .join(' | ')}`,
        );
    }

    if (archive.length > 0) {
        const uniqueTags = Array.from(
            new Set(
                archive
                    .flatMap((announcement) => announcement.tags)
                    .map((tag) => tag.trim())
                    .filter((tag) => tag.length > 0),
            ),
        ).slice(0, 6);
        const titles = archive
            .slice(0, 6)
            .map((announcement) => announcement.summaryArchive || announcement.title)
            .join(' | ');
        const tagsSuffix = uniqueTags.length > 0 ? ` Themes: ${uniqueTags.join(', ')}.` : '';
        const noun = archive.length > 1 ? 'announcements' : 'announcement';
        lines.push(`Older archive (15-30 days old): ${archive.length} ${noun}. Titles: ${titles}.${tagsSuffix}`);
        lines.push(
            ...archive.slice(0, 8).map((announcement) => {
                const ref = announcement.sourceMessageId ? ` [ref: ${announcement.sourceMessageId}]` : '';
                return `- ${announcement.summaryArchive || announcement.title}${ref}`;
            }),
        );
    }

    return lines;
}

export function parseAnnouncementLookaheadDays(value: string | undefined): number {
    return parsePositiveInteger(value, DEFAULT_ANNOUNCEMENT_LOOKAHEAD_DAYS);
}

export function parseAnnouncementLookbackDays(value: string | undefined): number {
    return parsePositiveInteger(value, DEFAULT_ANNOUNCEMENT_LOOKBACK_DAYS, DEFAULT_ANNOUNCEMENT_LOOKBACK_DAYS);
}

export function parseAnnouncementRetentionDays(value: string | undefined): number {
    return parsePositiveInteger(value, DEFAULT_ANNOUNCEMENT_RETENTION_DAYS, DEFAULT_ANNOUNCEMENT_RETENTION_DAYS);
}

export function parseDiscordAnnouncementActiveDays(value: string | undefined): number {
    return parsePositiveInteger(value, DEFAULT_DISCORD_ANNOUNCEMENT_ACTIVE_DAYS);
}

export function parseAnnouncementChannelIds(value: string | undefined): string[] {
    if (!value) {
        return [];
    }
    return Array.from(
        new Set(
            value
                .split(',')
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0),
        ),
    );
}

export function buildAnnouncementWindowStart(now: Date, lookbackDays: number): Date {
    return new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
}

export function buildAnnouncementWindowEnd(now: Date, lookaheadDays: number): Date {
    return new Date(now.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);
}

export function isTrackedAnnouncementChannel(channelId: string, trackedChannelIds: string[]): boolean {
    return trackedChannelIds.includes(channelId);
}

export function buildAssociationAnnouncementFromDiscordMessage(
    input: DiscordAnnouncementMessageInput,
    options?: {
        activeDays?: number;
        retentionDays?: number;
        source?: string;
        publishedAtOverride?: Date;
    },
): AssociationAnnouncement | null {
    const text = buildAnnouncementText(input);
    if (text.length === 0) {
        return null;
    }

    const activeDays = options?.activeDays || DEFAULT_DISCORD_ANNOUNCEMENT_ACTIVE_DAYS;
    const retentionDays = options?.retentionDays || DEFAULT_ANNOUNCEMENT_RETENTION_DAYS;
    const publishedAt = options?.publishedAtOverride || input.createdAt;
    const endsAt = new Date(publishedAt.getTime() + activeDays * 24 * 60 * 60 * 1000);
    const baseAnnouncement: AssociationAnnouncement = {
        id: input.id,
        sourceMessageId: input.id,
        sourceChannelId: input.channelId,
        title: deriveAnnouncementTitle(text, publishedAt),
        content: text,
        startsAt: publishedAt,
        endsAt,
        expiresAt: new Date(endsAt.getTime() + retentionDays * 24 * 60 * 60 * 1000),
        priority: 0,
        tags: extractHashtags(text),
        source: options?.source || 'discord',
        sourceUrl: input.url,
        updatedAt: new Date(),
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

    return {
        ...baseAnnouncement,
        ...buildFallbackAnnouncementCompaction(baseAnnouncement),
    };
}

export function formatAnnouncementsPromptContext(
    announcements: AssociationAnnouncement[],
    options?: {
        now?: Date;
        lookaheadDays?: number;
        lookbackDays?: number;
    },
): string | null {
    if (announcements.length === 0) {
        return null;
    }

    const now = options?.now || new Date();
    const lookaheadDays = options?.lookaheadDays || DEFAULT_ANNOUNCEMENT_LOOKAHEAD_DAYS;
    const lookbackDays = options?.lookbackDays || DEFAULT_ANNOUNCEMENT_LOOKBACK_DAYS;

    const upcomingOrOngoing = announcements.filter((announcement) => announcement.endsAt.getTime() >= now.getTime());
    const recentlyEnded = announcements.filter((announcement) => {
        const ageInDays = buildAgeInDays(now, announcement.endsAt);
        return announcement.endsAt.getTime() < now.getTime() && ageInDays <= 7;
    });
    const archiveLines = buildArchiveDigestLines(announcements, now);

    const sections: string[] = [
        `Association announcements context for the last ${lookbackDays} days and the next ${lookaheadDays} days. This is trusted platform context, not a user message.`,
        'Prefer upcoming or ongoing announcements. As announcements get older, rely on the compact digest instead of repeating stale details.',
        'Only mention an announcement when it helps answer the user, and never invent missing details.',
    ];

    if (upcomingOrOngoing.length > 0) {
        sections.push(
            'Upcoming or ongoing announcements:',
            ...upcomingOrOngoing.slice(0, 8).map((announcement) => {
                const tags = announcement.tags.length > 0 ? ` [tags: ${announcement.tags.join(', ')}]` : '';
                const url = announcement.sourceUrl ? ` ${announcement.sourceUrl}` : '';
                const ref = announcement.sourceMessageId ? ` [ref: ${announcement.sourceMessageId}]` : '';
                return `- ${formatAnnouncementDate(announcement.startsAt)} -> ${formatAnnouncementDate(
                    announcement.endsAt,
                )} | ${announcement.title}${ref}: ${
                    announcement.summaryFresh || buildFallbackAnnouncementCompaction(announcement).summaryFresh
                }${tags}${url}`;
            }),
        );
    }

    if (recentlyEnded.length > 0) {
        sections.push(
            'Recently ended announcements (0-7 days old):',
            ...recentlyEnded.slice(0, 6).map(
                (announcement) =>
                    `- ${formatAnnouncementDate(announcement.startsAt)} | ${announcement.title}${
                        announcement.sourceMessageId ? ` [ref: ${announcement.sourceMessageId}]` : ''
                    }: ${announcement.summaryRecent || buildFallbackAnnouncementCompaction(announcement).summaryRecent}`,
            ),
        );
    }

    if (archiveLines.length > 0) {
        sections.push('Compressed archive:', ...archiveLines);
    }

    return sections.join('\n');
}
