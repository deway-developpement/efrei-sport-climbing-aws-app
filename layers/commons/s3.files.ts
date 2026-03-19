import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

const client = new S3Client({ region: 'eu-west-3' });
const bucketName = process.env.S3_BUCKET_NAME as string;

export async function getS3Blob(path: string): Promise<Blob> {
    const response = await client.send(
        new GetObjectCommand({
            Bucket: bucketName,
            Key: path,
        }),
    );
    if (!response.Body) {
        throw new Error(`S3 object not found: ${path}`);
    }
    const bytes = await response.Body.transformToByteArray();
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Blob([arrayBuffer]);
}
