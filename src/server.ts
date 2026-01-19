import { Hono } from "hono";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isAddress } from "viem";
import { getImageFromS3, getMimeType } from "./services/image-s3-service";
import { SyncService, type RateLimitError } from "./services/sync-service";
import type { TokenListProvider } from "./providers/token-list-provider";

async function getImageFromSourceDir(
	chainId: number,
	address: string,
): Promise<{ buffer: Uint8Array; contentType: string; extension?: string } | null> {
	try {
		const tokenDir = join(process.cwd(), "images", chainId.toString(), address.toLowerCase());
		const files = await readdir(tokenDir);
		
		const imageFile = files.find((f: string) => f.startsWith("image.png")) 
			|| files.find((f: string) => f.startsWith("image.jpg"))
			|| files.find((f: string) => f.startsWith("image."));
		
		if (!imageFile) return null;
		
		const imagePath = join(tokenDir, imageFile);
		const extension = imageFile.split(".").pop();
		const buffer = await readFile(imagePath);
		const contentType = extension ? getMimeType(extension) : "application/octet-stream";
		
		return {
			buffer: new Uint8Array(buffer),
			contentType,
			extension,
		};
	} catch {
		return null;
	}
}

const app = new Hono();

const paramsSchema = z.object({
	chainId: z.string().transform((val) => {
		const num = Number(val);
		if (isNaN(num) || !Number.isInteger(num) || num < 0) {
			throw new Error("chainId must be a valid positive integer value: " + val || "undefined");
		}
		return num;
	}),
	address: z.string().refine((val) => isAddress(val), {
		message: "address must be a valid Ethereum address",
	}),
});

const syncParamsSchema = z.object({
	chainId: z.string().transform((val) => {
		const num = Number(val);
		if (isNaN(num) || !Number.isInteger(num) || num < 0) {
			throw new Error("chainId must be a valid positive integer value: " + val || "undefined");
		}
		return num;
	}),
});

const symbolSearchSchema = z.object({
	symbol: z.string().min(1, "symbol is required"),
	chainId: z.string().optional().transform((val) => {
		if (!val) return undefined;
		const num = Number(val);
		if (isNaN(num) || !Number.isInteger(num) || num < 0) {
			throw new Error("chainId must be a valid positive integer value: " + val);
		}
		return num;
	}),
});

const syncService = new SyncService();

function isRateLimitError(result: any): result is RateLimitError {
	return result && result.rateLimited === true;
}

app.get("/sync/:chainId", async (c) => {
	try {
		const { chainId } = syncParamsSchema.parse({
			chainId: c.req.param("chainId"),
		});

		const existingStatus = syncService.getSyncStatus(chainId);

		if (existingStatus && existingStatus.status === 'running') {
			console.log(`Returning existing running sync status for chain ${chainId}`);
			return c.json({
				success: true,
				data: existingStatus,
			});
		}

		console.log(`Attempting to start sync process for chain ${chainId}`);
		const syncResult = await syncService.startSync(chainId);

		if (isRateLimitError(syncResult)) {
			return c.json({
				success: false,
				error: "Rate limit exceeded",
				data: {
					rateLimited: true,
					chainId: syncResult.chainId,
					remainingTime: syncResult.remainingTime,
					message: syncResult.message,
				},
			}, 429);
		}

		return c.json({
			success: true,
			data: syncResult,
		});
	} catch (error) {
		if (error instanceof z.ZodError) {
			return c.json({
				error: "Invalid parameters ",
				details: error.issues.map((issue) => issue.message)
			}, 400);
		}

		console.error(`Error in sync endpoint:`, error);
		return c.json({
			error: "Internal server error",
			message: error instanceof Error ? error.message : "Unknown error"
		}, 500);
	}
});

app.get("/sync/:chainId/status", async (c) => {
	try {
		const { chainId } = syncParamsSchema.parse({
			chainId: c.req.param("chainId"),
		});

		const syncStatus = syncService.getSyncStatus(chainId);

		if (!syncStatus) {
			return c.json({
				success: true,
				data: null,
				message: `No sync process found for chain ${chainId}`,
			});
		}

		return c.json({
			success: true,
			data: syncStatus,
		});
	} catch (error) {
		if (error instanceof z.ZodError) {
			return c.json({
				error: "Invalid parameters ",
				details: error.issues.map((issue) => issue.message)
			}, 400);
		}

		console.error(`Error in sync status endpoint:`, error);
		return c.json({
			error: "Internal server error",
			message: error instanceof Error ? error.message : "Unknown error"
		}, 500);
	}
});

app.get("/:chainId/:address", async (c) => {
	try {
		const { chainId, address } = paramsSchema.parse({
			chainId: c.req.param("chainId"),
			address: c.req.param("address"),
		});

		let storedImage = await getImageFromS3(chainId, address);
		
		if (!storedImage) {
			storedImage = await getImageFromSourceDir(chainId, address);
		}

		if (storedImage) {
			const imageBuffer = new Uint8Array(storedImage.buffer);
			return new Response(imageBuffer, {
				headers: {
					"Content-Type": storedImage.contentType,
					"Content-Length": imageBuffer.length.toString(),
					"Cache-Control": "public, max-age=86400",
				},
			});
		}

		const defaultImagePath = join(process.cwd(), "images", "default.png");
		const defaultImageBuffer = new Uint8Array(await readFile(defaultImagePath));
		const fileExtension = defaultImagePath.split('.').pop() || "png";
		const defaultContentType = getMimeType(fileExtension);

		return new Response(defaultImageBuffer, {
			headers: {
				"Content-Type": defaultContentType,
				"Content-Length": defaultImageBuffer.length.toString(),
				"Cache-Control": "public, max-age=86400",
			},
		});
	} catch (error) {
		if (error instanceof z.ZodError) {
			return c.json({
				error: "Invalid parameters",
				details: error.issues.map((issue) => issue.message)
			}, 400);
		}

		console.error(`Error serving image:`, error);
		return c.json({ error: "Internal server error" }, 500);
	}
});

app.get("/health", (c) => {
	return c.json({ status: "ok" });
});

app.notFound((c) => {
	return c.json({ error: "Not found" }, 404);
});

const port = process.env.PORT || 4000;

console.log(`Server running on port ${port}`);

export default {
	port,
	fetch: app.fetch,
};
