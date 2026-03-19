import { APIGatewayProxyResult } from 'aws-lambda';
import {
    DiscordGuildMember,
    DiscordInteraction,
    DiscordInteractionFlags,
    DiscordInteractionResponse,
    DiscordInteractionResponseType,
    DiscordMessagePost,
} from 'commons/discord.types';

export function checkRole(body: DiscordInteraction): APIGatewayProxyResult | undefined {
    const member: DiscordGuildMember | undefined = body.member as DiscordGuildMember | undefined;
    if (!member) {
        return;
    }
    if (!member.roles.includes(process.env.DISCORD_ROLE_ID as string)) {
        const response: DiscordInteractionResponse = {
            type: DiscordInteractionResponseType.ChannelMessageWithSource,
            data: {
                content: "Vous n'avez pas les droits pour utiliser ce bot",
                flags: DiscordInteractionFlags.Ephemeral,
            },
        };
        return {
            statusCode: 200,
            body: JSON.stringify(response),
        };
    }
}

export const USER_NOT_FOUND_RESPONSE: DiscordMessagePost = {
    content: 'Vous devez vous inscrire avec la commande ``/inscription`` avant de pouvoir utiliser le bot',
};
