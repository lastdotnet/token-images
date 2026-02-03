import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { uploadImageToS3, checkImageExistsInS3 } from "../src/services/image-s3-service";

async function uploadChainImages(chainId: number) {
    const chainDir = join(process.cwd(), "images", chainId.toString());
    
    if (!existsSync(chainDir)) {
        console.error(`❌ No images directory found for chain ${chainId}`);
        process.exit(1);
    }
    
    console.log(`📂 Scanning chain ${chainId} directory: ${chainDir}`);
    const addresses = await readdir(chainDir);
    
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    
    for (const address of addresses) {
        const addressDir = join(chainDir, address);
        
        try {
            const dirStat = await stat(addressDir);
            if (!dirStat.isDirectory()) continue;
        } catch {
            continue;
        }
        
        const existsInS3 = await checkImageExistsInS3(chainId, address);
        if (existsInS3) {
            console.log(`⏭️  Skipping ${address} (already in S3)`);
            skipped++;
            continue;
        }
        
        const imageExtensions = ["png", "jpg", "jpeg", "webp", "svg"];
        let imageFile: string | null = null;
        let extension: string | null = null;
        
        for (const ext of imageExtensions) {
            const filePath = join(addressDir, `image.${ext}`);
            if (existsSync(filePath)) {
                imageFile = filePath;
                extension = ext;
                break;
            }
        }
        
        if (!imageFile || !extension) {
            console.log(`⚠️  No image file found for ${address}`);
            failed++;
            continue;
        }
        
        try {
            const imageBuffer = await readFile(imageFile);
            const success = await uploadImageToS3(
                chainId,
                address,
                new Uint8Array(imageBuffer),
                extension,
                {
                    provider: "local-migration",
                    downloadDate: new Date().toISOString(),
                    originalUrl: imageFile,
                }
            );
            
            if (success) {
                console.log(`✅ Uploaded ${address}`);
                uploaded++;
            } else {
                console.log(`❌ Failed to upload ${address}`);
                failed++;
            }
        } catch (error) {
            console.error(`❌ Error uploading ${address}:`, error);
            failed++;
        }
    }
    
    console.log("\n📊 Summary:");
    console.log(`  Uploaded: ${uploaded}`);
    console.log(`  Skipped: ${skipped}`);
    console.log(`  Failed: ${failed}`);
    console.log(`  Total: ${uploaded + skipped + failed}`);
}

const chainId = parseInt(process.argv[2] || "999");
if (isNaN(chainId)) {
    console.error("Usage: bun run scripts/upload-chain-images.ts <chainId>");
    process.exit(1);
}

uploadChainImages(chainId).catch((error) => {
    console.error("Error:", error);
    process.exit(1);
});
