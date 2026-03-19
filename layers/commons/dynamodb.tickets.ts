import {
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    ScanCommand,
    TransactWriteItemsCommand,
    UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { TicketFile, OrderRecord, OrderState } from "./dynamodb.types";

const client = new DynamoDBClient({ region: "eu-west-3" });

export async function getTicket(id: string): Promise<TicketFile> {
    const { Item } = await client.send(new GetItemCommand({ TableName: "Efrei-Sport-Climbing-App.tickets", Key: { id: { S: id }, orderId: { S: id } } }));
    if (!Item) {
        throw new Error("Ticket not found");
    }
    const ticket = {
        id: Item.id.S as string,
        url: Item.url.S as string,
        sold: Item.sold.BOOL as boolean,
        date: new Date(parseInt(Item.date.N as string)),
    };
    return ticket;
}

export async function putTicket(ticketInput: TicketFile): Promise<void> {
    await client.send(
        new PutItemCommand({
            TableName: "Efrei-Sport-Climbing-App.tickets",
            Item: {
                id: { S: ticketInput.id },
                orderId: { S: ticketInput.id },
                url: { S: ticketInput.url },
                sold: { BOOL: ticketInput.sold },
                date: { N: ticketInput.date.getTime().toString() },
            },
        })
    );
}

export async function deleteTicketByUrl(url: string): Promise<void> {
    const { Items } = await client.send(
        new ScanCommand({
            TableName: "Efrei-Sport-Climbing-App.tickets",
            FilterExpression: "#url = :url AND sold = :sold",
            ExpressionAttributeNames: {
                "#url": "url",
            },
            ExpressionAttributeValues: {
                ":url": { S: url },
                ":sold": { BOOL: false },
            },
        })
    );
    if (!Items || Items.length === 0) {
        throw new Error("Ticket not found");
    }
    const ticketId = Items[0].id.S as string;
    await client.send(
        new TransactWriteItemsCommand({
            TransactItems: [
                {
                    Delete: {
                        TableName: "Efrei-Sport-Climbing-App.tickets",
                        Key: {
                            id: { S: ticketId },
                            orderId: { S: ticketId },
                        },
                    },
                },
            ],
        })
    );
}

export async function listTickets(): Promise<TicketFile[]> {
    const { Items } = await client.send(new ScanCommand({ TableName: "Efrei-Sport-Climbing-App.tickets", FilterExpression: "id = orderId" }));
    if (!Items) {
        throw new Error("No tickets found");
    }
    const tickets = Items.map((item: any) => ({
        id: item.id.S as string,
        url: item.url.S as string,
        sold: item.sold.BOOL as boolean,
        date: new Date(parseInt(item.date.N as string)),
    }));
    return tickets as TicketFile[];
}

export async function getUnsoldTicket(): Promise<TicketFile> {
    let ExclusiveStartKey: any = undefined;

    do {
        const { Items, LastEvaluatedKey } = await client.send(
            new ScanCommand({
                TableName: "Efrei-Sport-Climbing-App.tickets",
                FilterExpression: "sold = :false",
                ExpressionAttributeValues: {
                    ":false": { BOOL: false },
                },
                Limit: 10,
                ExclusiveStartKey,
            })
        );

        if (Items && Items.length > 0) {
            const item = Items[0];
            return {
                id: item.id.S as string,
                url: item.url.S as string,
                sold: item.sold.BOOL as boolean,
                date: new Date(parseInt(item.date.N as string)),
            };
        }

        ExclusiveStartKey = LastEvaluatedKey;
    } while (ExclusiveStartKey);

    throw new Error("No unsold ticket found");
}

export async function getUnsoldTickets(number: number): Promise<TicketFile[]> {
    let tickets: TicketFile[] = [];
    let ExclusiveStartKey: any = undefined;

    do {
        const { Items, LastEvaluatedKey } = await client.send(
            new ScanCommand({
                TableName: "Efrei-Sport-Climbing-App.tickets",
                FilterExpression: "sold = :false",
                ExpressionAttributeValues: {
                    ":false": { BOOL: false },
                },
                ExclusiveStartKey,
            })
        );

        if (Items) {
            const newTickets = Items.map((item: any) => ({
                id: item.id.S as string,
                url: item.url.S as string,
                sold: item.sold.BOOL as boolean,
                date: new Date(parseInt(item.date.N as string)),
            }));
            tickets.push(...newTickets);
        }

        if (tickets.length >= number) {
            break;
        }

        ExclusiveStartKey = LastEvaluatedKey;
    } while (ExclusiveStartKey);

    if (tickets.length < number) {
        throw new Error("Not enough unsold tickets available");
    }

    return tickets.slice(0, number);
}

export async function getTicketsByOrderId(orderId: string): Promise<TicketFile[]> {
    const orders = await getOrders(orderId);
    if (!orders || orders.length === 0) {
        throw new Error("No tickets found for the given order ID");
    }

    let tickets: TicketFile[] = [];

    for (const order of orders) {
        const ticketData = await getTicket(order.ticketId);
        tickets.push(ticketData);
    }

    if (tickets.length === 0) {
        throw new Error("No tickets found for the given order ID");
    }
    return tickets;
}

export async function getOrders(orderId: string): Promise<OrderRecord[] | null> {
    const { Items } = await client.send(
        new ScanCommand({
            TableName: "Efrei-Sport-Climbing-App.tickets",
            FilterExpression: "orderId = :orderId",
            ExpressionAttributeValues: {
                ":orderId": { S: orderId },
            },
        })
    );
    if (!Items) {
        throw new Error("No tickets found");
    }
    if (Items.length === 0) {
        return null;
    }
    const tickets = Items.map((item: any) => ({
        ticketId: item.id.S as string,
        orderId: item.orderId.S as string,
        userId: item.userId?.NULL ? null : ((item.userId?.S as string | undefined) || null),
        state: item.state.S as OrderState,
        date: new Date(parseInt(item.date.N as string)),
    }));
    return tickets as OrderRecord[];
}

export async function listOrders(start_date: Date, end_date: Date): Promise<OrderRecord[]> {
    const { Items } = await client.send(
        new ScanCommand({
            TableName: "Efrei-Sport-Climbing-App.tickets",
            FilterExpression: "#date BETWEEN :start_date AND :end_date and orderId <> id",
            ExpressionAttributeValues: {
                ":start_date": { N: start_date.getTime().toString() },
                ":end_date": { N: end_date.getTime().toString() },
            },
            ExpressionAttributeNames: {
                "#date": "date",
            },
        })
    );
    if (!Items) {
        throw new Error("No orders found");
    }
    const orders = Items.map((item: any) => ({
        ticketId: item.id.S as string,
        orderId: item.orderId.S as string,
        userId: item.userId?.NULL ? null : ((item.userId?.S as string | undefined) || null),
        state: item.state.S as OrderState,
        date: new Date(parseInt(item.date.N as string)),
    }));
    return orders as OrderRecord[];
}

export async function fetchOrderExists(orderId: string): Promise<boolean> {
    const { Items } = await client.send(
        new ScanCommand({
            TableName: "Efrei-Sport-Climbing-App.tickets",
            FilterExpression: "orderId = :orderId",
            ExpressionAttributeValues: {
                ":orderId": { S: orderId },
            },
        })
    );
    if (!Items) {
        throw new Error("Error fetching tickets");
    }
    return Items.length > 0;
}

export async function putOrder(orderId: string, ticketId: string, userId: string | null): Promise<void> {
    const ticket = await getTicket(ticketId);
    if (ticket.sold) {
        throw new Error("Ticket already sold");
    }
    await client.send(
        new TransactWriteItemsCommand({
            TransactItems: [
                {
                    Put: {
                        TableName: "Efrei-Sport-Climbing-App.tickets",
                        Item: {
                            id: { S: ticketId },
                            orderId: { S: orderId },
                            userId: userId ? { S: userId } : { NULL: true },
                            date: { N: new Date().getTime().toString() },
                            state: { S: OrderState.PENDING },
                        },
                    },
                },
                {
                    Update: {
                        TableName: "Efrei-Sport-Climbing-App.tickets",
                        Key: {
                            id: { S: ticketId },
                            orderId: { S: ticketId },
                        },
                        UpdateExpression: "set sold = :sold",
                        ExpressionAttributeValues: {
                            ":sold": { BOOL: true },
                        },
                    },
                },
            ],
        })
    );
}

export async function updateOrderUserId(orderId: string, ticketId: string, userId: string | null): Promise<void> {
    await client.send(
        new UpdateItemCommand({
            TableName: "Efrei-Sport-Climbing-App.tickets",
            Key: {
                id: { S: ticketId },
                orderId: { S: orderId },
            },
            UpdateExpression: "SET userId = :userId",
            ExpressionAttributeValues: {
                ":userId": userId ? { S: userId } : { NULL: true },
            },
        })
    );
}

export async function validateOrders(orderId: string): Promise<void> {
    const orders = await getOrders(orderId);
    if (!orders || orders.length === 0) {
        throw new Error("No linked ticket found for the given order ID");
    }
    await client.send(
        new TransactWriteItemsCommand({
            TransactItems: orders.map((ticket) => ({
                Update: {
                    TableName: "Efrei-Sport-Climbing-App.tickets",
                    Key: {
                        id: { S: ticket.ticketId },
                        orderId: { S: orderId },
                    },
                    UpdateExpression: "SET #s = :state",
                    ExpressionAttributeNames: {
                        "#s": "state",
                    },
                    ExpressionAttributeValues: {
                        ":state": { S: OrderState.PROCESSED },
                    },
                },
            })),
        })
    );
}

export async function validateOrder(orderId: string, ticketId: string): Promise<void> {
    const orders = await getOrders(orderId);
    if (!orders || orders.length === 0) {
        throw new Error("No linked ticket found for the given order ID");
    }
    const ticket = orders.find((t) => t.ticketId === ticketId);
    if (!ticket) {
        throw new Error("Ticket not found in the order");
    }
    await client.send(
        new TransactWriteItemsCommand({
            TransactItems: [
                {
                    Update: {
                        TableName: "Efrei-Sport-Climbing-App.tickets",
                        Key: {
                            id: { S: ticket.ticketId },
                            orderId: { S: orderId },
                        },
                        UpdateExpression: "SET #s = :state",
                        ExpressionAttributeNames: {
                            "#s": "state",
                        },
                        ExpressionAttributeValues: {
                            ":state": { S: OrderState.PROCESSED },
                        },
                    },
                },
            ],
        })
    );
}
