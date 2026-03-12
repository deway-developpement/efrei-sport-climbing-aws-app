import { GetObjectCommand, GetObjectOutput, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { IncomingMessage } from 'http';
import { Response } from 'node-fetch';

const client = new S3Client({ region: 'eu-west-3' });
const bucket_name = process.env.S3_BUCKET_NAME as string;

export async function getFile(path: string): Promise<Blob> {
    // get file from s3
    const data = (await client.send(new GetObjectCommand({ Bucket: bucket_name, Key: path }))) as GetObjectOutput;
    if (!data.Body) {
        throw new Error('Image not found');
    }
    // get the file from the Body
    const res = new Response(data.Body as IncomingMessage);
    return await res.blob();
}

export async function updateFile(path: string, file: Blob): Promise<void> {
    await client.send(
        new PutObjectCommand({
            Bucket: bucket_name,
            Key: path,
            Body: file,
        }),
    );
}
