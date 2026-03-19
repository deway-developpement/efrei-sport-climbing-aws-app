import { AttributeValue, DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { DmConversation, DmConversationMessage } from './dynamodb.types';

const client = new DynamoDBClient({ region: 'eu-west-3' });
const DM_CONVERSATIONS_TABLE_NAME = process.env.DM_CONVERSATIONS_TABLE_NAME || 'Efrei-Sport-Climbing-App.dm-conversations';

type MarshalledDmConversation = Record<string, AttributeValue>;

function marshallDate(value: Date): { N: string } {
    return { N: value.getTime().toString() };
}

function unmarshallDate(value?: AttributeValue): Date | null {
    if (!value || !('N' in value) || !value.N) {
        return null;
    }
    return new Date(parseInt(value.N));
}

function marshallNullableString(value: string | null): { S: string } | { NULL: boolean } {
    return value ? { S: value } : { NULL: true };
}

function unmarshallNullableString(value?: AttributeValue): string | null {
    if (!value || ('NULL' in value && value.NULL)) {
        return null;
    }
    return 'S' in value && value.S ? value.S : null;
}

function marshallMessages(messages: DmConversationMessage[]): { L: AttributeValue[] } {
    return {
        L: messages.map((message) => ({
            M: {
                role: { S: message.role },
                content: { S: message.content },
                createdAt: { N: message.createdAt.getTime().toString() },
            },
        })),
    };
}

function unmarshallMessages(value?: AttributeValue): DmConversationMessage[] {
    if (!value || !('L' in value) || !value.L) {
        return [];
    }
    return value.L.flatMap((entry) => {
        if (!('M' in entry) || !entry.M?.role?.S || !entry.M?.content?.S || !entry.M?.createdAt?.N) {
            return [];
        }
        return [
            {
                role: entry.M.role.S as DmConversationMessage['role'],
                content: entry.M.content.S,
                createdAt: new Date(parseInt(entry.M.createdAt.N)),
            },
        ];
    });
}

function marshallConversation(conversation: DmConversation): MarshalledDmConversation {
    return {
        discordUserId: { S: conversation.discordUserId },
        discordUsername: marshallNullableString(conversation.discordUsername),
        registeredUserId: marshallNullableString(conversation.registeredUserId),
        registeredFirstName: marshallNullableString(conversation.registeredFirstName),
        registeredLastName: marshallNullableString(conversation.registeredLastName),
        registeredPromo: marshallNullableString(conversation.registeredPromo),
        identifiedUserName: marshallNullableString(conversation.identifiedUserName),
        algoliaConversationId: marshallNullableString(conversation.algoliaConversationId),
        lastProcessedMessageId: marshallNullableString(conversation.lastProcessedMessageId),
        messages: marshallMessages(conversation.messages),
        updatedAt: marshallDate(conversation.updatedAt),
        expiresAt: { N: Math.floor(conversation.expiresAt.getTime() / 1000).toString() },
    };
}

function unmarshallConversation(item?: MarshalledDmConversation): DmConversation | undefined {
    if (!item?.discordUserId?.S || !item.updatedAt?.N || !item.expiresAt?.N) {
        return;
    }
    return {
        discordUserId: item.discordUserId.S,
        discordUsername: unmarshallNullableString(item.discordUsername),
        registeredUserId: unmarshallNullableString(item.registeredUserId),
        registeredFirstName: unmarshallNullableString(item.registeredFirstName),
        registeredLastName: unmarshallNullableString(item.registeredLastName),
        registeredPromo: unmarshallNullableString(item.registeredPromo),
        identifiedUserName: unmarshallNullableString(item.identifiedUserName),
        algoliaConversationId: unmarshallNullableString(item.algoliaConversationId),
        lastProcessedMessageId: unmarshallNullableString(item.lastProcessedMessageId),
        messages: unmarshallMessages(item.messages),
        updatedAt: new Date(parseInt(item.updatedAt.N)),
        expiresAt: new Date(parseInt(item.expiresAt.N) * 1000),
    };
}

export function trimConversationMessages(messages: DmConversationMessage[], limit: number): DmConversationMessage[] {
    if (limit <= 0) {
        return [];
    }
    return messages.slice(-limit);
}

export async function getDmConversation(discordUserId: string): Promise<DmConversation | undefined> {
    const { Item } = await client.send(
        new GetItemCommand({
            TableName: DM_CONVERSATIONS_TABLE_NAME,
            Key: { discordUserId: { S: discordUserId } },
        }),
    );
    return unmarshallConversation(Item as MarshalledDmConversation | undefined);
}

export async function putDmConversation(conversation: DmConversation): Promise<void> {
    await client.send(
        new PutItemCommand({
            TableName: DM_CONVERSATIONS_TABLE_NAME,
            Item: marshallConversation(conversation),
        }),
    );
}
