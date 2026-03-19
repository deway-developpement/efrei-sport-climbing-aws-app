import { DiscordEmbed } from './discord.types';
import { getSessionUrl } from './session.recommendations';
import { getSession, listSessionParticipantIds } from './dynamodb.sessions';
import { getUser } from './dynamodb.users';
import { User } from './dynamodb.types';

const DEFAULT_TIME_ZONE = 'Europe/Paris';
const SESSION_EMBED_COLOR = 0x4a7c59;
const MAX_PARTICIPANT_LINES = 8;

function capitalize(value: string): string {
    if (value.length === 0) {
        return value;
    }
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatLocation(location: string): string {
    return location
        .split('-')
        .map((part) => capitalize(part))
        .join(' ');
}

function formatDate(date: Date): string {
    return capitalize(
        date.toLocaleString('fr-FR', {
            weekday: 'long',
            day: '2-digit',
            month: 'long',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: DEFAULT_TIME_ZONE,
        }),
    );
}

function formatParticipantLines(participants: User[]): string {
    if (participants.length === 0) {
        return "Personne n'est encore inscrit.";
    }

    const visibleParticipants = participants.slice(0, MAX_PARTICIPANT_LINES).map((participant) => {
        return `- ${participant.firstName} ${participant.lastName}`;
    });
    const remaining = participants.length - visibleParticipants.length;
    if (remaining > 0) {
        visibleParticipants.push(`- … et ${remaining} autre${remaining > 1 ? 's' : ''}`);
    }
    return visibleParticipants.join('\n');
}

async function loadSessionParticipants(sessionId: string): Promise<User[]> {
    const participantIds = await listSessionParticipantIds(sessionId);
    const participants = await Promise.all(
        participantIds.map(async (participantId) => {
            try {
                return await getUser(participantId);
            } catch (error) {
                console.warn(`Failed to load participant ${participantId} for session embed ${sessionId}`, error);
                return undefined;
            }
        }),
    );
    return participants.filter((participant): participant is User => participant !== undefined);
}

export async function buildDiscordSessionEmbed(sessionId: string, personalizedMessage: string): Promise<DiscordEmbed> {
    const [session, participants] = await Promise.all([getSession(sessionId), loadSessionParticipants(sessionId)]);
    const sessionUrl = getSessionUrl(session);

    return {
        title: formatDate(session.date),
        description: `Séance à **${formatLocation(session.location)}**`,
        url: sessionUrl || undefined,
        timestamp: session.date.toISOString(),
        color: SESSION_EMBED_COLOR,
        fields: [
            {
                name: 'Pourquoi je te la recommande',
                value: personalizedMessage.trim(),
                inline: false,
            },
            {
                name: 'Participants',
                value: formatParticipantLines(participants),
                inline: false,
            },
            {
                name: 'Accès rapide',
                value: sessionUrl ? `[Ouvrir la séance](${sessionUrl})` : 'Lien indisponible',
                inline: false,
            },
        ],
        footer: {
            text: `Session ${session.id}`,
        },
    };
}
