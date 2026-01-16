import { S3Client, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

// S3 client configuration - try common AWS regions
const s3Client = new S3Client({
    region: process.env.AWS_REGION || "ap-northeast-1",
    forcePathStyle: false, // Use virtual hosted-style URLs
    credentials: {
        accessKeyId: process.env.EULER_AWS_ACCESS_KEY || "",
        secretAccessKey: process.env.EULER_AWS_SECRET_ACCESS_KEY || "",
    },
});

const BUCKET_NAME = "hypurrfi-token-imgs";

// Function to get MIME type based on file extension
export function getMimeType(extension: string): string {
    // Remove leading dot if present
    const cleanExtension = extension.startsWith('.') ? extension.slice(1) : extension;

    const mimeTypes: Record<string, string> = {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "svg": "image/svg+xml",
        "gif": "image/gif",
        "bmp": "image/bmp",
        "ico": "image/x-icon",
        "tiff": "image/tiff",
        "tif": "image/tiff",
    };

    return mimeTypes[cleanExtension.toLowerCase()] || "application/octet-stream";
}

// Function to check if image exists in S3 and get it
export async function getImageFromS3(
    chainId: number,
    address: string,
): Promise<{ buffer: Uint8Array; contentType: string; extension?: string } | null> {
    try {
        // Get the object directly using the known key structure
        const key = `${chainId}/${address.toLowerCase()}/image`;
        const getCommand = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
        });

        const response = await s3Client.send(getCommand);

        if (!response.Body) {
            return null;
        }

        // Convert stream to buffer
        const chunks: Uint8Array[] = [];
        const reader = response.Body.transformToWebStream().getReader();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }

        const buffer = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
            buffer.set(chunk, offset);
            offset += chunk.length;
        }

        // Determine content type from S3 metadata or ContentType
        let contentType = response.ContentType || "application/octet-stream";
        let extension: string | undefined = undefined;

        // If we have extension metadata, use it to determine the correct MIME type
        if (response.Metadata?.extension) {
            extension = response.Metadata.extension;
            contentType = getMimeType(response.Metadata.extension);
        }

        return {
            buffer,
            contentType,
            extension,
        };
    } catch (error) {
        console.error(`Error fetching image from S3 for ${chainId}/${address}:`);
        return null;
    }
}

// Function to check if image exists in S3 (without downloading)
export async function checkImageExistsInS3(
    chainId: number,
    address: string,
): Promise<boolean> {
    try {
        // Check for the exact key since we no longer use extensions in filenames
        const key = `${chainId}/${address.toLowerCase()}/image`;
        const headCommand = new HeadObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
        });

        await s3Client.send(headCommand);
        return true; // If no error, the object exists
    } catch (error) {
        // HeadObject throws an error if the object doesn't exist
        return false;
    }
}

// Function to upload image to S3 with metadata
export async function uploadImageToS3(
    chainId: number,
    address: string,
    imageBuffer: Uint8Array,
    extension: string,
    metadata: {
        provider: string;
        downloadDate: string;
        originalUrl?: string;
    }
): Promise<boolean> {
    try {
        const key = `${chainId}/${address.toLowerCase()}/image`;
        const contentType = getMimeType(extension);

        const putCommand = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Body: imageBuffer,
            ContentType: contentType,
            Metadata: {
                extension: extension,
                provider: metadata.provider,
                downloadDate: metadata.downloadDate,
                ...(metadata.originalUrl && { originalUrl: metadata.originalUrl }),
            },
        });

        await s3Client.send(putCommand);
        console.log(`Successfully uploaded image to S3: ${key}`);
        return true;
    } catch (error) {
        console.error(`Error uploading to S3 for ${chainId}/${address}:`, error);
        return false;
    }
}

// Function to bulk check which images exist in S3
export async function bulkCheckImagesInS3(
    tokens: Array<{ chainId: number; address: string }>
): Promise<Array<{ chainId: number; address: string; exists: boolean }>> {
    const results = await Promise.allSettled(
        tokens.map(async (token) => ({
            chainId: token.chainId,
            address: token.address,
            exists: await checkImageExistsInS3(token.chainId, token.address),
        }))
    );

    return results.map((result, index) => ({
        chainId: tokens[index].chainId,
        address: tokens[index].address,
        exists: result.status === 'fulfilled' ? result.value.exists : false,
    }));
}
