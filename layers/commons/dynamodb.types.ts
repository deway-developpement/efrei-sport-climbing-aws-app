import { Order } from "./helloasso.types";

export type User = {
    id: string;
    firstName: string;
    lastName: string;
    promo: string;
    nbOfSeances?: number;
};

export type ActivityStatus = "new" | "active" | "inactive" | "power_user";

export type ConversationRole = 'system' | 'user' | 'assistant';

export type UserStats = {
    userId: string;
    nbOfSeances: number;
    firstSeenAt: Date | null;
    lastActivityAt: Date | null;
    lastSessionDate: Date | null;
    sessionsLast30Days: number;
    sessionsLast90Days: number;
    membershipTenureDays: number | null;
    activityStatus: ActivityStatus;
    favoriteLocation: string | null;
    preferredDayOfWeek: string | null;
    ticketCount: number;
    hasOpenIssue: boolean;
    profileCompletenessScore: number;
    tags: string[];
    attendanceRate: number | null;
    computedAt: Date;
    statsVersion: string;
};

export type AssociationAnnouncement = {
    id: string;
    sourceMessageId: string | null;
    sourceChannelId: string | null;
    title: string;
    content: string;
    startsAt: Date;
    endsAt: Date;
    expiresAt: Date;
    priority: number;
    tags: string[];
    source: string | null;
    sourceUrl: string | null;
    updatedAt: Date;
    category: string | null;
    audience: string[];
    importantFacts: string[];
    callToAction: string | null;
    summaryFresh: string | null;
    summaryRecent: string | null;
    summaryArchive: string | null;
    compactionStatus: 'pending' | 'completed' | 'fallback' | 'failed';
    compactionModel: string | null;
    compactedAt: Date | null;
};

export type Session = {
    id: string;
    date: Date;
    location: string;
    participants?: User[];
};

export type SessionActivityLevel = "small" | "popular" | "very_popular";

export type RecommendationState = 'sent' | 'expanded' | 'remind_requested' | 'dismissed' | 'joined';

export type RecommendationFeedback = 'more' | 'remind_later' | 'show_similar' | 'not_for_me';

export type AlgoliaSessionRecord = {
    objectID: string;
    id: string;
    date: string;
    timestamp: number;
    location: string;
    isExpired: boolean;
    isUpcoming: boolean;
    participantCount: number;
    participantIds: string[];
    participantNames: string[];
    participantPromos: string[];
    weekday: string;
    hour: number;
    month: string;
    activityLevel: SessionActivityLevel;
    favoriteParticipantPromos: string[];
    participantPreview: string[];
    repeatParticipantIds: string[];
    repeatParticipantNames: string[];
    dominantPromo: string | null;
    similarityTags: string[];
    tags: string[];
};

export type SessionRecommendation = {
    userId: string;
    sortId: string;
    campaignId: string;
    sessionId: string;
    sessionDate: Date;
    sessionLocation: string;
    recommendedAt: Date;
    expiresAt: Date;
    score: number;
    reasons: string[];
    recommendationState: RecommendationState;
    deliveryStatus: 'sent' | 'failed';
    deliveryChannelId: string | null;
    deliveryMessageId: string | null;
    expandedAt: Date | null;
    remindAt: Date | null;
    remindCount: number;
    dismissedAt: Date | null;
    feedback: RecommendationFeedback | null;
    similarSessionIds: string[];
    algoliaClickSent: boolean;
    algoliaConversionSent: boolean;
    joinedAt: Date | null;
};

export type TicketFile = {
    id: string;
    orderId?: string;
    url: string;
    sold: boolean;
    date: Date;
};

export type OrderRecord = {
    ticketId: string;
    orderId: string;
    userId: string | null;
    date: Date;
    state: OrderState;
};

export enum OrderState {
    PENDING = "pending",
    PROCESSED = "processed",
    CANCELLED = "cancelled",
}

export type Issue = {
    id: string;
    description: string;
    status: IssueStatus;
    createdAt: Date;
    updatedAt: Date | null;
    order: Order | null;
    flags?: number; // Bitmask for flags
};

export enum IssueStatus {
    OPEN = "open",
    CLOSED = "closed",
}

export type DmConversationMessage = {
    role: ConversationRole;
    content: string;
    createdAt: Date;
};

export type DmConversation = {
    discordUserId: string;
    discordUsername: string | null;
    registeredUserId: string | null;
    registeredFirstName: string | null;
    registeredLastName: string | null;
    registeredPromo: string | null;
    identifiedUserName: string | null;
    algoliaConversationId: string | null;
    lastProcessedMessageId: string | null;
    messages: DmConversationMessage[];
    updatedAt: Date;
    expiresAt: Date;
};
