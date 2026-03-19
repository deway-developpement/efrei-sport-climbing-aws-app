import { AssociationAnnouncement } from '../../../layers/commons/dynamodb.types';

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const MAX_FRESH_SUMMARY_LENGTH = 220;
const MAX_RECENT_SUMMARY_LENGTH = 140;
const MAX_ARCHIVE_SUMMARY_LENGTH = 90;
const BANNED_TAGS = new Set([
    'event',
    'climbing',
    'participation',
    'videos',
    'video',
    'date',
    'formulaire',
    'formulaires',
    'amphi',
    'one drive',
    'story',
    'mp',
    'membres',
]);

type OllamaChatResponse = {
    message?: {
        content?: string;
    };
};

type AnnouncementCompactionPayload = {
    category: string | null;
    audience: string[];
    importantFacts: string[];
    callToAction: string | null;
    summaryFresh: string;
    summaryRecent: string;
    summaryArchive: string;
    tags?: string[];
};

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

function dedupeStrings(values: string[]): string[] {
    return Array.from(
        new Set(
            values
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
        ),
    );
}

function normalizeTagForFilter(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function parseNullableString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function parseStringArray(value: unknown, maxLength = 8): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return dedupeStrings(
        value.flatMap((entry) => (typeof entry === 'string' ? [entry] : [])),
    ).slice(0, maxLength);
}

function sanitizeTags(tags: string[]): string[] {
    return tags.filter((tag) => !BANNED_TAGS.has(normalizeTagForFilter(tag)));
}

function getOllamaModel(): string | null {
    const model = process.env.ANNOUNCEMENT_COMPACTION_OLLAMA_MODEL?.trim() || process.env.OLLAMA_MODEL?.trim();
    return model && model.length > 0 ? model : null;
}

function getOllamaUrl(): string {
    const raw = process.env.ANNOUNCEMENT_COMPACTION_OLLAMA_URL?.trim() || process.env.OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL;
    return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function buildCompactionPrompt(announcement: AssociationAnnouncement): string {
    return [
        'You compact Discord announcements for EFREI Sport Climbing.',
        'Return only valid JSON.',
        'The JSON schema is:',
        '{"category":string|null,"audience":string[],"importantFacts":string[],"callToAction":string|null,"summaryFresh":string,"summaryRecent":string,"summaryArchive":string,"tags":string[]}',
        'Rules:',
        '- Keep the same language as the announcement. If the announcement is in French, all fields must be in French.',
        '- summaryFresh: concise but actionable, good for current-week prompting.',
        '- summaryFresh must keep the main actionable detail for members when one exists: how to participate, register, submit, attend, or prepare.',
        '- summaryFresh must not become a vague promotional sentence if the announcement contains concrete steps or constraints.',
        '- summaryRecent: shorter than summaryFresh.',
        '- summaryRecent should still preserve the main event type plus the most important qualifier such as date, deadline, location or participation mode.',
        '- summaryArchive: very compressed thematic memory.',
        '- importantFacts: up to 5 factual bullet fragments, not full sentences if avoidable.',
        '- tags: up to 6 short tags, lowercase, in the same language as the announcement.',
        '- Avoid generic or English tags such as "event", "climbing", "participation", "videos", "date".',
        '- Tags must come from concrete themes present in the raw announcement or obvious proper nouns from it.',
        '- Tags should describe the theme of the announcement, not logistics or support details.',
        '- Good French tags: "kilter", "tombola", "recrutement", "ago", "sécurité", "photos", "antrebloc".',
        '- Bad tags: "event", "climbing", "date", "formulaire", "formulaires", "participation", "amphi", "one drive", "story".',
        '- category should be one of: session, event, competition, governance, recruitment, safety, photos, admin, mixed.',
        '- audience should contain short lowercase audience labels when explicit, otherwise [].',
        '- callToAction must be an explicit action clearly requested in the raw announcement. Reuse the original wording as much as possible. If there is no explicit request, return null.',
        '- If the announcement only informs members but does not ask them to do something specific, callToAction must be null.',
        '- Preserve exact dates, times and locations when they are present and important.',
        '- For recurring session announcements, prioritize day, time, location, and one practical note if present.',
        '- For competition, recruitment or challenge announcements, mention the participation mechanic or deadline when it is explicit.',
        '- If the announcement contains a main topic and a secondary reminder, prioritize the main topic. Mention the secondary reminder only briefly if it materially changes the action for members.',
        '- summaryArchive should be very short and thematic, ideally under 12 words.',
        '- Do not invent facts that are not present.',
        '- If details are unclear, prefer null or a shorter summary.',
        `Title: ${announcement.title}`,
        `StartsAt: ${announcement.startsAt.toISOString()}`,
        `EndsAt: ${announcement.endsAt.toISOString()}`,
        `SourceUrl: ${announcement.sourceUrl || ''}`,
        'Raw announcement content:',
        announcement.content,
    ].join('\n');
}

function parseOllamaPayload(raw: string): AnnouncementCompactionPayload {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const summaryFresh = parseNullableString(parsed.summaryFresh);
    const summaryRecent = parseNullableString(parsed.summaryRecent);
    const summaryArchive = parseNullableString(parsed.summaryArchive);

    if (!summaryFresh || !summaryRecent || !summaryArchive) {
        throw new Error('Ollama compaction JSON is missing one of the required summaries');
    }

    return {
        category: parseNullableString(parsed.category),
        audience: parseStringArray(parsed.audience, 8),
        importantFacts: parseStringArray(parsed.importantFacts, 5),
        callToAction: parseNullableString(parsed.callToAction),
        summaryFresh,
        summaryRecent,
        summaryArchive,
        tags: sanitizeTags(parseStringArray(parsed.tags, 6)),
    };
}

export function buildFallbackAnnouncementCompaction(
    announcement: AssociationAnnouncement,
): Pick<
    AssociationAnnouncement,
    | 'category'
    | 'audience'
    | 'importantFacts'
    | 'callToAction'
    | 'summaryFresh'
    | 'summaryRecent'
    | 'summaryArchive'
    | 'compactionStatus'
    | 'compactionModel'
    | 'compactedAt'
> {
    const normalizedContent = normalizeWhitespace(announcement.content);
    const firstSentence = normalizedContent.split(/(?<=[.!?])\s+/).find((sentence) => sentence.trim().length > 0) || normalizedContent;

    return {
        category: null,
        audience: [],
        importantFacts: firstSentence.length > 0 ? [clipText(firstSentence, 100)] : [],
        callToAction: null,
        summaryFresh: clipText(normalizedContent, MAX_FRESH_SUMMARY_LENGTH),
        summaryRecent: clipText(normalizedContent, MAX_RECENT_SUMMARY_LENGTH),
        summaryArchive: clipText(announcement.title || normalizedContent, MAX_ARCHIVE_SUMMARY_LENGTH),
        compactionStatus: 'fallback',
        compactionModel: 'deterministic-fallback',
        compactedAt: new Date(),
    };
}

export async function compactAnnouncementWithOllama(
    announcement: AssociationAnnouncement,
): Promise<Pick<
    AssociationAnnouncement,
    | 'category'
    | 'audience'
    | 'importantFacts'
    | 'callToAction'
    | 'summaryFresh'
    | 'summaryRecent'
    | 'summaryArchive'
    | 'tags'
    | 'compactionStatus'
    | 'compactionModel'
    | 'compactedAt'
>> {
    const model = getOllamaModel();
    if (!model) {
        const fallback = buildFallbackAnnouncementCompaction(announcement);
        return {
            ...fallback,
            tags: announcement.tags,
        };
    }

    const response = await fetch(`${getOllamaUrl()}/api/chat`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            think: false,
            stream: false,
            format: 'json',
            messages: [
                {
                    role: 'user',
                    content: buildCompactionPrompt(announcement),
                },
            ],
        }),
    });

    if (!response.ok) {
        throw new Error(`Ollama compaction failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as OllamaChatResponse;
    const content = payload.message?.content;
    if (!content || content.trim().length === 0) {
        throw new Error('Ollama compaction returned empty content');
    }

    const parsed = parseOllamaPayload(content);
    return {
        category: parsed.category,
        audience: parsed.audience,
        importantFacts: parsed.importantFacts,
        callToAction: parsed.callToAction,
        summaryFresh: clipText(parsed.summaryFresh, MAX_FRESH_SUMMARY_LENGTH),
        summaryRecent: clipText(parsed.summaryRecent, MAX_RECENT_SUMMARY_LENGTH),
        summaryArchive: clipText(parsed.summaryArchive, MAX_ARCHIVE_SUMMARY_LENGTH),
        tags: parsed.tags && parsed.tags.length > 0 ? parsed.tags : announcement.tags,
        compactionStatus: 'completed',
        compactionModel: model,
        compactedAt: new Date(),
    };
}

export async function compactAnnouncementWithFallback(
    announcement: AssociationAnnouncement,
): Promise<AssociationAnnouncement> {
    try {
        const compaction = await compactAnnouncementWithOllama(announcement);
        return {
            ...announcement,
            ...compaction,
        };
    } catch (error) {
        console.warn(`[discord-dm-worker] announcement_compaction_failed announcementId=${announcement.id}`, error);
        return {
            ...announcement,
            ...buildFallbackAnnouncementCompaction(announcement),
        };
    }
}
