import {
    DiscordInteraction,
    DiscordInteractionResponseType,
    DiscordInteractionFlags,
    DiscordMessagePost,
    DiscordMessage,
    DiscordActionRow,
    DiscordComponentType,
} from 'commons/discord.types';
import {
    BUTTON_CANCEL_ORDER,
    BUTTON_FETCH_TICKETS,
    BUTTON_MARK_ISSUE_PROCESSED,
    BUTTON_MARK_ORDER_PROCESSED,
    BUTTON_VIEW_ORDER_DETAILS,
    BUTTON_VIEW_TICKETS,
    FLAG_BUTTON_CANCEL_ORDER,
    FLAG_BUTTON_FETCH_TICKETS,
    FLAG_BUTTON_MARK_ISSUE_PROCESSED,
    FLAG_BUTTON_MARK_ORDER_PROCESSED,
    FLAG_BUTTON_VIEW_ORDER_DETAILS,
    FLAG_BUTTON_VIEW_TICKETS,
} from 'commons/discord.components';
import { IssueStatus } from 'commons/dynamodb.types';
import { getIssue } from 'commons/dynamodb.issues';

export async function deferResponse(body: DiscordInteraction, ephemeral = false) {
    fetch('https://discord.com/api/v8/interactions/' + body.id + '/' + body.token + '/callback', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            type: DiscordInteractionResponseType.DeferredChannelMessageWithSource,
            data: {
                flags: ephemeral ? DiscordInteractionFlags.Ephemeral : 0,
            },
        }),
    });
}

export async function deferUpdate(body: DiscordInteraction) {
    fetch('https://discord.com/api/v8/interactions/' + body.id + '/' + body.token + '/callback', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            type: DiscordInteractionResponseType.DeferredUpdateMessage,
        }),
    });
}

export async function editResponse(body: DiscordInteraction, message: DiscordMessagePost) {
    await fetch(
        'https://discord.com/api/v8/webhooks/' + process.env.DISCORD_APP_ID + '/' + body.token + '/messages/@original',
        {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(message),
        },
    ).then((response) => {
        console.log('Response status:', response.status);
    });
}

export async function editResponseWithFile(
    body: DiscordInteraction,
    message: DiscordMessagePost,
    file: Blob,
    filename: string,
) {
    const formData = new FormData();
    message.attachments = [];
    formData.append('payload_json', JSON.stringify(message));
    formData.append('file[0]', file, filename);
    await fetch(
        'https://discord.com/api/v8/webhooks/' + process.env.DISCORD_APP_ID + '/' + body.token + '/messages/@original',
        {
            method: 'PATCH',
            body: formData,
        },
    );
}

export async function editResponseWithFiles(
    body: DiscordInteraction,
    message: DiscordMessagePost,
    files: { filename?: string; file: Blob }[],
) {
    const formData = new FormData();
    message.attachments = [];
    formData.append('payload_json', JSON.stringify(message));
    files.forEach((file, index) => {
        const filename = file.filename || `file_${index + 1}`;
        formData.append(`files[${index}]`, file.file, filename);
    });
    await fetch(
        'https://discord.com/api/v8/webhooks/' + process.env.DISCORD_APP_ID + '/' + body.token + '/messages/@original',
        {
            method: 'PATCH',
            body: formData,
        },
    );
}

export async function updateButtonOfMessage(channelId: string, messageId: string, issueId: string, token: string) {
    // Get original message
    const response = await fetch(`https://discord.com/api/v8/channels/${channelId}/messages/${messageId}`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bot ${token}`,
        },
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch message: ${response.statusText}`);
    }
    const originalMessage = (await response.json()) as DiscordMessage;

    const actionRow: DiscordActionRow = {
        type: DiscordComponentType.ActionRow,
        components: [],
    };
    const issue = await getIssue(issueId);
    if (!issue) {
        throw new Error(`Issue with ID ${issueId} not found`);
    }
    if (issue.flags === undefined) {
        issue.flags = 0; // Ensure flags is defined
    }
    if (issue.flags & FLAG_BUTTON_VIEW_ORDER_DETAILS) {
        actionRow.components.push(BUTTON_VIEW_ORDER_DETAILS(issue.id));
    }
    if (issue.flags & FLAG_BUTTON_CANCEL_ORDER && issue.status !== IssueStatus.CLOSED) {
        actionRow.components.push(BUTTON_CANCEL_ORDER(issue.id));
    }
    if (issue.flags & FLAG_BUTTON_VIEW_TICKETS && issue.status !== IssueStatus.CLOSED) {
        actionRow.components.push(BUTTON_VIEW_TICKETS(issue.id));
    }
    if (issue.flags & FLAG_BUTTON_MARK_ISSUE_PROCESSED && issue.status !== IssueStatus.CLOSED) {
        actionRow.components.push(BUTTON_MARK_ISSUE_PROCESSED(issue.id));
    }
    if (issue.flags & FLAG_BUTTON_MARK_ORDER_PROCESSED && issue.status !== IssueStatus.CLOSED) {
        actionRow.components.push(BUTTON_MARK_ORDER_PROCESSED(issue.id));
    }
    if (issue.flags & FLAG_BUTTON_FETCH_TICKETS && issue.status !== IssueStatus.CLOSED) {
        actionRow.components.push(BUTTON_FETCH_TICKETS(issue.id));
    }

    // Update the flags of the message
    const updatedMessage: DiscordMessagePost = {
        content: originalMessage.content,
        embeds: originalMessage.embeds,
        components: [actionRow],
    };

    await fetch(`https://discord.com/api/v8/channels/${channelId}/messages/${messageId}`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bot ${token}`,
        },
        body: JSON.stringify(updatedMessage),
    }).then((response) => {
        if (!response.ok) {
            throw new Error(`Failed to update message: ${response.statusText}`);
        }
    });
}
