import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { getDmConversation, putDmConversation } from '../../../layers/commons/dynamodb.dm_conversations';
import { DmConversation, DmConversationMessage } from '../../../layers/commons/dynamodb.types';

export type ConversationStore = {
    get(discordUserId: string): Promise<DmConversation | undefined>;
    put(conversation: DmConversation): Promise<void>;
};

type FileConversationRecord = Omit<DmConversation, 'messages' | 'updatedAt' | 'expiresAt'> & {
    messages: Array<Omit<DmConversationMessage, 'createdAt'> & { createdAt: string }>;
    updatedAt: string;
    expiresAt: string;
};

const DEFAULT_FILE_PATH = path.resolve(process.cwd(), '.data/discord-dm-conversations.json');

function getStoreMode(): 'file' | 'dynamodb' {
    const explicitMode = process.env.DM_CONVERSATION_STORE;
    if (explicitMode === 'dynamodb') {
        return 'dynamodb';
    }
    if (explicitMode === 'file') {
        return 'file';
    }
    return process.env.DM_CONVERSATIONS_TABLE_NAME ? 'dynamodb' : 'file';
}

function getFilePath(): string {
    return process.env.DM_CONVERSATION_FILE_PATH
        ? path.resolve(process.env.DM_CONVERSATION_FILE_PATH)
        : DEFAULT_FILE_PATH;
}

function serializeConversation(conversation: DmConversation): FileConversationRecord {
    return {
        ...conversation,
        messages: conversation.messages.map((message) => ({
            ...message,
            createdAt: message.createdAt.toISOString(),
        })),
        updatedAt: conversation.updatedAt.toISOString(),
        expiresAt: conversation.expiresAt.toISOString(),
    };
}

function deserializeConversation(record: FileConversationRecord): DmConversation {
    return {
        ...record,
        messages: record.messages.map((message) => ({
            ...message,
            createdAt: new Date(message.createdAt),
        })),
        updatedAt: new Date(record.updatedAt),
        expiresAt: new Date(record.expiresAt),
    };
}

async function readFileStore(filePath: string): Promise<Record<string, FileConversationRecord>> {
    try {
        const content = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(content) as Record<string, FileConversationRecord>;
        return parsed;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return {};
        }
        throw error;
    }
}

async function writeFileStore(filePath: string, payload: Record<string, FileConversationRecord>): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function createFileConversationStore(filePath: string): ConversationStore {
    return {
        async get(discordUserId: string) {
            const store = await readFileStore(filePath);
            const record = store[discordUserId];
            return record ? deserializeConversation(record) : undefined;
        },
        async put(conversation: DmConversation) {
            const store = await readFileStore(filePath);
            store[conversation.discordUserId] = serializeConversation(conversation);
            await writeFileStore(filePath, store);
        },
    };
}

function createDynamoDbConversationStore(): ConversationStore {
    return {
        async get(discordUserId: string) {
            return getDmConversation(discordUserId);
        },
        async put(conversation: DmConversation) {
            await putDmConversation(conversation);
        },
    };
}

export function createConversationStore(): ConversationStore {
    return getStoreMode() === 'dynamodb'
        ? createDynamoDbConversationStore()
        : createFileConversationStore(getFilePath());
}
