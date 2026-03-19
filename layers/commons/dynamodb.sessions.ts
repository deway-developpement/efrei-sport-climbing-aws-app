import {
    BatchGetItemCommand,
    BatchWriteItemCommand,
    DeleteItemCommand,
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    QueryCommand,
    ScanCommand,
    ScanCommandInput,
    UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { Session, User } from "./dynamodb.types";
import { listUsers } from "./dynamodb.users";
import { dateToDiscordSnowflake } from "./discord.utils";

const client = new DynamoDBClient({ region: "eu-west-3" });

export async function listSessionParticipantIds(id: string): Promise<string[]> {
    const { Items } = await client.send(
        new QueryCommand({
            ExpressionAttributeValues: {
                ":id": { S: id },
            },
            ExpressionAttributeNames: {
                "#id": "id",
                "#sortId": "sortId",
            },
            KeyConditionExpression: "#id = :id",
            ProjectionExpression: "#sortId",
            TableName: "Efrei-Sport-Climbing-App.sessions",
        })
    );

    return (
        Items?.flatMap((item) => {
            const sortId = item.sortId.S as string;
            return sortId !== id ? [sortId] : [];
        }) || []
    );
}

export async function getSession(id: string): Promise<Session> {
    const { Item } = await client.send(new GetItemCommand({ TableName: "Efrei-Sport-Climbing-App.sessions", Key: { id: { S: id }, sortId: { S: id } } }));
    if (!Item) {
        throw new Error("Session not found");
    }
    const session = {
        id: Item.id.S as string,
        date: new Date(parseInt(Item.date.N as string)),
        location: Item.location.S as string,
    };
    return session;
}

export async function findSession(date: Date, location: string): Promise<Session> {
    const params = {
        TableName: "Efrei-Sport-Climbing-App.sessions",
        ScanFilter: {
            location: {
                ComparisonOperator: "EQ",
                AttributeValueList: [
                    {
                        S: location,
                    },
                ],
            },
            date: {
                ComparisonOperator: "EQ",
                AttributeValueList: [
                    {
                        N: date.getTime().toString(),
                    },
                ],
            },
            isExpired: {
                ComparisonOperator: "EQ",
                AttributeValueList: [
                    {
                        BOOL: false,
                    },
                ],
            },
        },
    } as ScanCommandInput;
    const { Items, Count } = await client.send(new ScanCommand(params));
    if (Count === 0) {
        throw new Error("Session not found");
    }
    const Item = Items?.[0];
    const session = {
        id: Item?.id.S as string,
        date: new Date(Item?.date.S as string),
        location: Item?.location.S as string,
    };
    return session;
}

export async function putSession(sessionInput: Session, participants: string[]): Promise<void> {
    const expirationDate = new Date(sessionInput.date.getTime() + 24 * 60 * 60 * 1000);
    expirationDate.setHours(0, 0, 0, 0);
    const sessionItem = {
        id: { S: sessionInput.id },
        sortId: { S: sessionInput.id },
        date: { N: sessionInput.date.getTime().toString() },
        location: { S: sessionInput.location },
        expiresAt: { N: expirationDate.getTime().toString() },
        isExpired: { BOOL: false },
    };
    const userItems = participants.map((participant) => {
        return {
            id: { S: sessionInput.id },
            sortId: { S: participant },
        };
    });
    await client.send(
        new BatchWriteItemCommand({
            RequestItems: {
                "Efrei-Sport-Climbing-App.sessions": [
                    {
                        PutRequest: {
                            Item: sessionItem,
                        },
                    },
                    ...userItems.map((item) => {
                        return {
                            PutRequest: {
                                Item: item,
                            },
                        };
                    }),
                ],
            },
        })
    );
}

export async function deleteSession(id: string): Promise<void> {
    const params = {
        ExpressionAttributeValues: {
            ":id": { S: id },
        },
        ExpressionAttributeNames: {
            "#id": "id",
            "#sortId": "sortId",
        },
        FilterExpression: "#id = :id",
        ProjectionExpression: "#id, #sortId",
        TableName: "Efrei-Sport-Climbing-App.sessions",
    };
    const { Items, Count } = await client.send(new ScanCommand(params));
    if (Count === 0) {
        throw new Error("Session not found");
    }
    await client.send(
        new BatchWriteItemCommand({
            RequestItems: {
                "Efrei-Sport-Climbing-App.sessions":
                    Items?.map((item) => {
                        return {
                            DeleteRequest: {
                                Key: {
                                    id: item.id,
                                    sortId: item.sortId,
                                },
                            },
                        };
                    }) || [],
            },
        })
    );
}

export async function expireSession(id: string): Promise<void> {
    const res = await client.send(
        new UpdateItemCommand({
            TableName: "Efrei-Sport-Climbing-App.sessions",
            Key: { id: { S: id }, sortId: { S: id } },
            AttributeUpdates: {
                isExpired: {
                    Action: "PUT",
                    Value: { BOOL: true },
                },
            },
        })
    );
    console.log("expireSessionRequest", JSON.stringify(res));
}

export async function addUserToSession(id: string, idUser: string): Promise<void> {
    const { Item } = await client.send(
        new GetItemCommand({
            TableName: "Efrei-Sport-Climbing-App.sessions",
            Key: { id: { S: id }, sortId: { S: idUser } },
        })
    );
    if (Item) {
        throw new Error("UserAlreadyRegisteredError");
    }
    await client.send(
        new PutItemCommand({
            TableName: "Efrei-Sport-Climbing-App.sessions",
            Item: {
                id: { S: id },
                sortId: { S: idUser },
            },
        })
    );
}

export async function removeUserFromSession(id: string, idUser: string): Promise<void> {
    const { Item } = await client.send(
        new GetItemCommand({
            TableName: "Efrei-Sport-Climbing-App.sessions",
            Key: { id: { S: id }, sortId: { S: idUser } },
        })
    );
    if (!Item) {
        throw new Error("UserNotRegisteredError");
    }
    await client.send(
        new DeleteItemCommand({
            TableName: "Efrei-Sport-Climbing-App.sessions",
            Key: {
                id: { S: id },
                sortId: { S: idUser },
            },
        })
    );
}

export async function listSessionsExpired(): Promise<Session[]> {
    const params = {
        ExpressionAttributeValues: {
            ":now": { N: new Date().getTime().toString() },
            ":isExpired": { BOOL: false },
        },
        ExpressionAttributeNames: {
            "#id": "id",
            "#date": "date",
            "#location": "location",
            "#isExpired": "isExpired",
            "#expiresAt": "expiresAt",
        },
        FilterExpression: "#expiresAt < :now AND #isExpired = :isExpired",
        ProjectionExpression: "#id, #date, #location",
        TableName: "Efrei-Sport-Climbing-App.sessions",
    };
    const { Items } = await client.send(new ScanCommand(params));
    const sessions = Items?.map((Item) => ({
        id: Item?.id.S as string,
        date: new Date(Item?.date.S as string),
        location: Item?.location.S as string,
    }));
    return sessions || [];
}

export async function listSessionUnexpired(): Promise<Session[]> {
    const params = {
        ExpressionAttributeValues: {
            ":isExpired": { BOOL: false },
        },
        ExpressionAttributeNames: {
            "#isExpired": "isExpired",
        },
        FilterExpression: "#isExpired = :isExpired",
        TableName: "Efrei-Sport-Climbing-App.sessions",
    };
    const { Items } = await client.send(new ScanCommand(params));
    const users = await listUsers();
    const sessions = [];
    for (const Item of Items as any) {
        const participantsId = await client.send(
            new QueryCommand({
                ExpressionAttributeValues: {
                    ":id": { S: Item?.id.S as string },
                },
                ExpressionAttributeNames: {
                    "#id": "id",
                    "#sortId": "sortId",
                },
                KeyConditionExpression: "#id = :id",
                ProjectionExpression: "#sortId",
                TableName: "Efrei-Sport-Climbing-App.sessions",
            })
        );
        const participants = participantsId?.Items?.map((item) => users.find((user) => user.id === item?.sortId.S));
        sessions.push({
            id: Item?.id.S as string,
            date: new Date(parseInt(Item.date.N as string)),
            location: Item?.location.S as string,
            participants: participants?.filter((participant) => participant !== undefined) as User[],
        });
    }
    return sessions || [];
}

export async function countSessionsWithUser(idUser: string, from: Date | null = null, to: Date | null = null): Promise<number> {
    const fromId = dateToDiscordSnowflake(from || new Date(0));
    const toId = dateToDiscordSnowflake(to || new Date());
    const params = {
        ExpressionAttributeValues: {
            ":idUser": { S: idUser },
            ":fromId": { S: fromId },
            ":toId": { S: toId },
        },
        ExpressionAttributeNames: {
            "#id": "id",
            "#sortId": "sortId",
        },
        FilterExpression: "#sortId = :idUser AND #id BETWEEN :fromId AND :toId",
        ProjectionExpression: "#id, #sortId",
        TableName: "Efrei-Sport-Climbing-App.sessions",
    };
    const { Count } = await client.send(new ScanCommand(params));
    return Count || 0;
}

export async function countSessionBetweenDatesByUsers(from: Date, to: Date): Promise<{ [key: string]: number }> {
    const fromId = dateToDiscordSnowflake(from);
    const toId = dateToDiscordSnowflake(to);
    const params = {
        ExpressionAttributeValues: {
            ":fromId": { S: fromId },
            ":toId": { S: toId },
        },
        ExpressionAttributeNames: {
            "#id": "id",
            "#sortId": "sortId",
        },
        FilterExpression: "#id BETWEEN :fromId AND :toId",
        ProjectionExpression: "#sortId",
        TableName: "Efrei-Sport-Climbing-App.sessions",
    };
    const { Items } = await client.send(new ScanCommand(params));
    const userCountMap: { [key: string]: number } = {};
    Items?.forEach((item) => {
        const userId = item.sortId.S as string;
        if (userCountMap[userId]) {
            userCountMap[userId]++;
        } else {
            userCountMap[userId] = 1;
        }
    });
    return userCountMap;
}

export async function countParticipants(id: string): Promise<Number> {
    const params = {
        ExpressionAttributeValues: {
            ":id": { S: id },
        },
        ExpressionAttributeNames: {
            "#id": "id",
            "#sortId": "sortId",
        },
        FilterExpression: "#id = :id AND #sortId <> :id",
        ProjectionExpression: "#id, #sortId",
        TableName: "Efrei-Sport-Climbing-App.sessions",
    };
    const { Count } = await client.send(new ScanCommand(params));
    return Count || 0;
}
