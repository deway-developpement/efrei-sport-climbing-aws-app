import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getSecret } from 'commons/aws.secret';
import { EventType, Event, Payment, PaymentState, FormType, Order } from 'commons/helloasso.types';
import { getAccessToken } from 'commons/helloasso.request';
import { fetchOrderExists, getUnsoldTickets, putOrder, validateOrder } from 'commons/dynamodb.tickets';
import { DiscordGuildMember, DiscordMessagePost } from 'commons/discord.types';
import { getFile } from './src/s3.tickets';
import { sendDiscordAlert } from './src/discord.interaction';
import { putIssue, fetchIssueExists } from 'commons/dynamodb.issues';
import { IssueStatus } from 'commons/dynamodb.types';
import {
    BUTTON_VIEW_ORDER_DETAILS,
    BUTTON_CANCEL_ORDER,
    BUTTON_MARK_ISSUE_PROCESSED,
    BUTTON_VIEW_TICKETS,
    FLAG_BUTTON_VIEW_ORDER_DETAILS,
    FLAG_BUTTON_CANCEL_ORDER,
    FLAG_BUTTON_MARK_ISSUE_PROCESSED,
    FLAG_BUTTON_VIEW_TICKETS,
    FLAG_BUTTON_MARK_ORDER_PROCESSED,
    BUTTON_MARK_ORDER_PROCESSED,
    BUTTON_FETCH_TICKETS,
    FLAG_BUTTON_FETCH_TICKETS,
} from 'commons/discord.components';

const DISCORD_SECRET_PATH = 'Efrei-Sport-Climbing-App/secrets/discord_bot_token';
const HELLOASSO_SECRET_PATH = 'Efrei-Sport-Climbing-App/secrets/helloasso_client_secret';
const DUMMY_RESPONSE: APIGatewayProxyResult = {
    statusCode: 200,
    body: JSON.stringify({
        message: 'ok !',
    }),
};
const ERROR_RESPONSE: APIGatewayProxyResult = {
    statusCode: 400,
    body: JSON.stringify({
        message: 'Bad Request to HelloAsso Event Handler',
    }),
};
const FORMSLUG = 'climb-up';
const FORMTYPE = FormType.Shop;
const FIELD_DISCORD_USER_ID = 'Identifiant (À obtenir sur le server avec la commande /helloasso)'; // This should match the custom field name in HelloAsso

const HELLO_ASSO_API_URL = 'https://api.helloasso.com/v5';
const DISCORD_LOG_CHANNEL_ID = '1408428754191126588'; // Replace with your Discord log channel ID

/**
 *
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 *
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // debug log
    console.log('event', event);

    const { DISCORD_BOT_TOKEN } = await getSecret(DISCORD_SECRET_PATH);
    const { HELLO_ASSO_CLIENT_ID, HELLO_ASSO_CLIENT_SECRET } = await getSecret(HELLOASSO_SECRET_PATH);
    console.log(`HelloAsso Client ID: ${HELLO_ASSO_CLIENT_ID.substring(0, 5)}...${HELLO_ASSO_CLIENT_ID.slice(-5)}`);
    console.log(
        `HelloAsso Client Secret: ${HELLO_ASSO_CLIENT_SECRET?.substring(0, 5)}...${HELLO_ASSO_CLIENT_SECRET?.slice(
            -5,
        )}`,
    );
    console.log(`Discord Bot Token: ${DISCORD_BOT_TOKEN?.substring(0, 5)}...${DISCORD_BOT_TOKEN?.slice(-5)}`);

    // get event data of helloasso from event.body
    const { data, eventType } = JSON.parse(event.body || '{}') as Event | { data: null; eventType: null };
    if (data && eventType) {
        // check if event is a payment
        if (eventType == EventType.Payment) {
            // check if payment is valid
            const payment = data as Payment;
            if (payment.state == PaymentState.Authorized) {
                // check if order is from climb up
                const { order } = payment;
                if (order.formSlug == FORMSLUG && order.formType == FORMTYPE) {
                    // Check if the order is an issue
                    if (await fetchIssueExists(order.id.toString())) {
                        console.log(`Order ${order.id} is already an issue, skipping processing.`);
                        return DUMMY_RESPONSE;
                    }

                    // make request to helloasso to check if order is valid
                    const url = `${HELLO_ASSO_API_URL}/orders/${order.id}`;

                    const token = await getAccessToken(HELLO_ASSO_CLIENT_ID, HELLO_ASSO_CLIENT_SECRET);
                    const response = await fetch(url, {
                        method: 'GET',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${token}`,
                        },
                    });

                    console.log(`Fetching order ${order.id} from HelloAsso: ${response.status}`);

                    if (!response.ok) {
                        console.log(`Error fetching order ${order.id} from HelloAsso: ${response.statusText}`);
                        await sendDiscordAlert(
                            `Error fetching order **${order.id}** from HelloAsso: ${
                                response.statusText
                            }\nPlease check the order details.\n\n**Order ID**: ${order.id}\n**Payment Amount**: ${
                                payment.amount / 100
                            } €\n**Payment Date**: ${new Date(payment.date).toLocaleString(
                                'fr-FR',
                            )}\n**Order Form Slug**: ${order.formSlug}\n**Payer Name**: ${
                                payment.payer.firstName + '  ' + payment.payer.lastName
                            }\n**Payer Email**: ${payment.payer.email}`,
                            DISCORD_LOG_CHANNEL_ID,
                            DISCORD_BOT_TOKEN,
                            [BUTTON_VIEW_ORDER_DETAILS(order.id), BUTTON_MARK_ISSUE_PROCESSED(order.id)],
                        );
                        await putIssue({
                            id: order.id.toString(),
                            description: `Error fetching order ${order.id} from HelloAsso`,
                            status: IssueStatus.OPEN,
                            createdAt: new Date(),
                            updatedAt: null,
                            order: null,
                            flags: FLAG_BUTTON_VIEW_ORDER_DETAILS + FLAG_BUTTON_MARK_ISSUE_PROCESSED,
                        });
                        return ERROR_RESPONSE;
                    }

                    const orderData = (await response.json()) as Order;

                    if (orderData.id != order.id) {
                        console.log('Order does not exist in helloasso.');
                        return DUMMY_RESPONSE;
                    }

                    if (orderData.formSlug != FORMSLUG || orderData.formType != FORMTYPE) {
                        console.log(`Order ${orderData.id} is not from the expected form slug or type.`);
                        return DUMMY_RESPONSE;
                    }

                    // Check if the paiement is authorized
                    if (orderData.payments?.[0].state !== PaymentState.Authorized) {
                        console.log(`Order ${orderData.id} payment doesn't correspond to the expected state.`);
                        return DUMMY_RESPONSE;
                    }

                    console.log(`Order ${orderData.id} fetched successfully from HelloAsso.`);

                    // check that order as not already been processed
                    if (await fetchOrderExists(order.id.toString())) {
                        console.log('order already processed.');
                        return DUMMY_RESPONSE;
                    }

                    // Check that the order is less than 10 items
                    if (orderData.items.length > 10) {
                        console.log('Order has more than 10 items, not processing.');
                        await sendDiscordAlert(
                            `Order ${orderData.id} has more than 10 items, not processing.`,
                            DISCORD_LOG_CHANNEL_ID,
                            DISCORD_BOT_TOKEN,
                            [BUTTON_VIEW_ORDER_DETAILS(orderData.id), BUTTON_CANCEL_ORDER(orderData.id)],
                        );
                        await putIssue({
                            id: order.id.toString(),
                            description: `Order ${orderData.id} has more than 10 items, not processing.`,
                            status: IssueStatus.OPEN,
                            createdAt: new Date(),
                            updatedAt: null,
                            order: orderData,
                            flags: FLAG_BUTTON_VIEW_ORDER_DETAILS + FLAG_BUTTON_CANCEL_ORDER,
                        });
                        return ERROR_RESPONSE;
                    }

                    // Check if the order has a correct discord user id in custom field
                    const fields = orderData.items
                        .map((item) =>
                            item.customFields
                                .filter((field) => field.name === FIELD_DISCORD_USER_ID)
                                .map((field) => field.answer),
                        )
                        .flat();
                    if (fields.length === 0 || !fields[0]) {
                        console.log('No or invalid discord user id found in order custom fields.');
                        await sendDiscordAlert(
                            `No or invalid discord user id found in order ${order.id}.`,
                            DISCORD_LOG_CHANNEL_ID,
                            DISCORD_BOT_TOKEN,
                            [
                                BUTTON_VIEW_ORDER_DETAILS(order.id),
                                BUTTON_CANCEL_ORDER(order.id),
                                BUTTON_FETCH_TICKETS(order.id),
                            ],
                        );
                        await putIssue({
                            id: order.id.toString(),
                            description: `No or invalid discord user id found in order ${order.id}.`,
                            status: IssueStatus.OPEN,
                            createdAt: new Date(),
                            updatedAt: null,
                            order: orderData,
                            flags:
                                FLAG_BUTTON_VIEW_ORDER_DETAILS + FLAG_BUTTON_CANCEL_ORDER + FLAG_BUTTON_FETCH_TICKETS,
                        });
                        return ERROR_RESPONSE;
                    }

                    // make a object with the discord user id and the number of tickets for each id
                    const discordUserIds = fields.reduce((acc: Record<string, number>, id: string) => {
                        if (acc[id]) {
                            acc[id]++;
                        } else {
                            acc[id] = 1;
                        }
                        return acc;
                    }, {});

                    // check if all id are valid
                    for (const id in discordUserIds) {
                        if (!/^\d{17,19}$/.test(id)) {
                            console.log(`Invalid Discord user ID: ${id}`);
                            await sendDiscordAlert(
                                `Invalid Discord user ID found in order ${order.id}: ${id}`,
                                DISCORD_LOG_CHANNEL_ID,
                                DISCORD_BOT_TOKEN,
                                [
                                    BUTTON_VIEW_ORDER_DETAILS(order.id),
                                    BUTTON_CANCEL_ORDER(order.id),
                                    BUTTON_FETCH_TICKETS(order.id),
                                ],
                            );
                            await putIssue({
                                id: order.id.toString(),
                                description: `Invalid Discord user ID found in order ${order.id}: ${id}`,
                                status: IssueStatus.OPEN,
                                createdAt: new Date(),
                                updatedAt: null,
                                order: orderData,
                                flags:
                                    FLAG_BUTTON_VIEW_ORDER_DETAILS +
                                    FLAG_BUTTON_FETCH_TICKETS +
                                    FLAG_BUTTON_CANCEL_ORDER,
                            });
                            return ERROR_RESPONSE;
                        }
                    }

                    // Compute the total number of tickets needed
                    const totalTicketsNeeded = Object.values(discordUserIds).reduce((sum, count) => sum + count, 0);

                    // Fetch all required tickets before loop
                    const allTickets = await getUnsoldTickets(totalTicketsNeeded).catch((err) => {
                        console.error('Error fetching unsold tickets:', err);
                        return [];
                    });

                    if (!allTickets || allTickets.length < totalTicketsNeeded) {
                        console.log('Not enough unsold tickets available.');
                        await sendDiscordAlert(
                            `Not enough unsold tickets available for order ${
                                order.id
                            }. Needed: ${totalTicketsNeeded}, available: ${allTickets?.length || 0}`,
                            DISCORD_LOG_CHANNEL_ID,
                            DISCORD_BOT_TOKEN,
                            [
                                BUTTON_VIEW_ORDER_DETAILS(order.id),
                                BUTTON_CANCEL_ORDER(order.id),
                                BUTTON_FETCH_TICKETS(order.id),
                            ],
                        );
                        await putIssue({
                            id: order.id.toString(),
                            description: `Not enough unsold tickets available. Needed: ${totalTicketsNeeded}, available: ${
                                allTickets?.length || 0
                            }`,
                            status: IssueStatus.OPEN,
                            createdAt: new Date(),
                            updatedAt: null,
                            order: orderData,
                            flags:
                                FLAG_BUTTON_VIEW_ORDER_DETAILS + FLAG_BUTTON_CANCEL_ORDER + FLAG_BUTTON_FETCH_TICKETS,
                        });
                        return ERROR_RESPONSE;
                    }

                    // Send tickets to Discord users
                    let ticketIndex = 0;
                    for (const [discordUserId, ticketCount] of Object.entries(discordUserIds)) {
                        console.log('Sending tickets to Discord user:', discordUserId, 'Count:', ticketCount);

                        // Get tickets for this user
                        const tickets = allTickets.slice(ticketIndex, ticketIndex + ticketCount);
                        ticketIndex += ticketCount;

                        // Get file from s3
                        const ticketFiles = await Promise.all(
                            tickets.map(
                                async (ticket) =>
                                    await getFile(ticket.url).catch((err) => {
                                        console.error(`Error fetching ticket file for ${ticket.url}:`, err);
                                        return null;
                                    }),
                            ),
                        );

                        // If any ticket file is null, log an error and skip this user
                        if (ticketFiles.some((file) => file === null)) {
                            console.error(
                                `Error fetching ticket files for order ${order.id} for user ${discordUserId}`,
                            );
                            await sendDiscordAlert(
                                `Error fetching ticket files for order **${order.id}** for user **${discordUserId}**`,
                                DISCORD_LOG_CHANNEL_ID,
                                DISCORD_BOT_TOKEN,
                                [
                                    BUTTON_VIEW_ORDER_DETAILS(order.id),
                                    BUTTON_CANCEL_ORDER(order.id),
                                    BUTTON_FETCH_TICKETS(order.id),
                                ],
                            );
                            await putIssue({
                                id: order.id.toString(),
                                description: `Error fetching ticket files for order ${order.id} for user ${discordUserId}`,
                                status: IssueStatus.OPEN,
                                createdAt: new Date(),
                                updatedAt: null,
                                order: orderData,
                                flags:
                                    FLAG_BUTTON_VIEW_ORDER_DETAILS +
                                    FLAG_BUTTON_FETCH_TICKETS +
                                    FLAG_BUTTON_CANCEL_ORDER,
                            });
                            continue; // Skip to the next user if there's an error fetching ticket files
                        }

                        // ! log ticket files as pending
                        for (const ticket of tickets) {
                            // update ticket in db
                            await putOrder(order.id.toString(), ticket.id, discordUserId);
                        }

                        // Check if the user has the according role in Discord
                        // Need to get user in context of specific guild
                        const guildId = process.env.GUILD_ID!;
                        const url = `https://discord.com/api/v8/guilds/${guildId}/members/${discordUserId}`;
                        const response = await fetch(url, {
                            method: 'GET',
                            headers: {
                                Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
                            },
                        });

                        if (!response.ok) {
                            console.error(
                                `Error fetching Discord user data for user **${discordUserId} **: ${response.statusText}`,
                            );
                            await sendDiscordAlert(
                                `Error fetching Discord user data for user **${discordUserId}**: ${response.statusText}`,
                                DISCORD_LOG_CHANNEL_ID,
                                DISCORD_BOT_TOKEN,
                                [
                                    BUTTON_VIEW_ORDER_DETAILS(order.id),
                                    BUTTON_VIEW_TICKETS(order.id),
                                    BUTTON_MARK_ORDER_PROCESSED(order.id),
                                ],
                            );
                            await putIssue({
                                id: order.id.toString(),
                                description: `Error fetching Discord user data for user ${discordUserId}: ${response.statusText}`,
                                status: IssueStatus.OPEN,
                                createdAt: new Date(),
                                updatedAt: null,
                                order: orderData,
                                flags:
                                    FLAG_BUTTON_VIEW_ORDER_DETAILS +
                                    FLAG_BUTTON_VIEW_TICKETS +
                                    FLAG_BUTTON_MARK_ORDER_PROCESSED,
                            });
                            continue; // Skip to the next user if there's an error fetching user data
                        }

                        const userData: DiscordGuildMember = await response.json();

                        if (!userData.roles || !userData.roles.includes(process.env.DISCORD_ROLE_ID!)) {
                            console.error(`User **${discordUserId}** is not a member of the association.`);
                            await sendDiscordAlert(
                                `User **${discordUserId}** is not a member of the association.`,
                                DISCORD_LOG_CHANNEL_ID,
                                DISCORD_BOT_TOKEN,
                                [
                                    BUTTON_VIEW_ORDER_DETAILS(order.id),
                                    BUTTON_VIEW_TICKETS(order.id),
                                    BUTTON_MARK_ORDER_PROCESSED(order.id),
                                ],
                            );
                            await putIssue({
                                id: order.id.toString(),
                                description: `User ${discordUserId} is not a member of the association.`,
                                status: IssueStatus.OPEN,
                                createdAt: new Date(),
                                updatedAt: null,
                                order: orderData,
                                flags:
                                    FLAG_BUTTON_VIEW_ORDER_DETAILS +
                                    FLAG_BUTTON_VIEW_TICKETS +
                                    FLAG_BUTTON_MARK_ORDER_PROCESSED,
                            });
                            continue; // Skip to the next user if they don't have the required role
                        }

                        // send ticket to discord
                        const url_discord = `https://discord.com/api/v8/users/@me/channels`;
                        const body = {
                            recipient_id: discordUserId,
                        };
                        const responseCreate = await fetch(url_discord, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
                            },
                            body: JSON.stringify(body),
                        });

                        const dataCreate = await responseCreate.json();

                        // Fail if bad id was provided
                        if (!responseCreate.ok) {
                            console.error(`Error creating Discord channel: ${dataCreate.message}`);
                            await sendDiscordAlert(
                                `Error creating Discord channel for user **${discordUserId}**: ${dataCreate.message}`,
                                DISCORD_LOG_CHANNEL_ID,
                                DISCORD_BOT_TOKEN,
                                [
                                    BUTTON_VIEW_ORDER_DETAILS(order.id),
                                    BUTTON_VIEW_TICKETS(order.id),
                                    BUTTON_MARK_ORDER_PROCESSED(order.id),
                                ],
                            );
                            await putIssue({
                                id: order.id.toString(),
                                description: `Error creating Discord channel for user ${discordUserId}: ${dataCreate.message}`,
                                status: IssueStatus.OPEN,
                                createdAt: new Date(),
                                updatedAt: null,
                                order: orderData,
                                flags:
                                    FLAG_BUTTON_VIEW_ORDER_DETAILS +
                                    FLAG_BUTTON_VIEW_TICKETS +
                                    FLAG_BUTTON_MARK_ORDER_PROCESSED,
                            });
                            continue; // Skip to the next user if channel creation fails
                        }

                        const message: DiscordMessagePost = {
                            content: `Salut, \nVoici ${
                                ticketCount > 1 ? 'tes places' : 'ta place'
                            } Climb-Up du ${new Date().toLocaleDateString('fr-FR', {
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric',
                            })} :\n-# ${ticketCount > 1 ? 'Places achetées' : 'Place achetée'} par ${
                                orderData.payer.firstName
                            } ${orderData.payer.lastName}`,
                            attachments: ticketFiles.map((file, index) => ({
                                id: index.toString(),
                                filename: `ticket_${index + 1}.pdf`, // Assuming the file is a PDF
                                description: 'application/pdf',
                            })),
                        };

                        const headers = new Headers();
                        headers.append('Authorization', `Bot ${DISCORD_BOT_TOKEN}`);
                        const formData = new FormData();
                        formData.append('payload_json', JSON.stringify(message));
                        // Append each file to the form data
                        for (const [index, file] of ticketFiles.entries()) {
                            const filename = `ticket_${index + 1}.pdf`; // Assuming the file is a PDF
                            formData.append(`files[${index}]`, file!, filename);
                        }

                        const response_discord = await fetch(
                            `https://discord.com/api/v8/channels/${dataCreate.id}/messages`,
                            {
                                method: 'POST',
                                headers: headers,
                                body: formData,
                            },
                        );
                        const data_discord = await response_discord.json();

                        if (!response_discord.ok) {
                            console.error(`Error sending message to Discord: ${data_discord.message}`);
                            await sendDiscordAlert(
                                `Error sending message to Discord for user **${discordUserId}**: ${data_discord.message}`,
                                DISCORD_LOG_CHANNEL_ID,
                                DISCORD_BOT_TOKEN,
                                [
                                    BUTTON_VIEW_ORDER_DETAILS(order.id),
                                    BUTTON_VIEW_TICKETS(order.id),
                                    BUTTON_MARK_ORDER_PROCESSED(order.id),
                                ],
                            );
                            await putIssue({
                                id: order.id.toString(),
                                description: `Error sending message to Discord for user ${discordUserId}: ${data_discord.message}`,
                                status: IssueStatus.OPEN,
                                createdAt: new Date(),
                                updatedAt: null,
                                order: orderData,
                                flags:
                                    FLAG_BUTTON_VIEW_ORDER_DETAILS +
                                    FLAG_BUTTON_VIEW_TICKETS +
                                    FLAG_BUTTON_MARK_ORDER_PROCESSED,
                            });
                            continue; // Skip to the next user if channel creation fails
                        }

                        for (const ticket of tickets) {
                            // update ticket in db
                            await validateOrder(order.id.toString(), ticket.id);
                        }
                    }

                    // return ok
                    return DUMMY_RESPONSE;
                } else {
                    console.log(`Order ${order.id} not processed because form slug or type did not match.`);
                    return DUMMY_RESPONSE;
                }
            }
        } else {
            console.log(`Event type ${eventType} not handled.`);
            return DUMMY_RESPONSE;
        }
    }

    // dummy response
    return DUMMY_RESPONSE;
};
