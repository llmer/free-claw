import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * Download a Telegram photo to a local file so Claude can read it.
 * Returns the absolute path and a cleanup function.
 */
export async function downloadTelegramPhoto(
  botToken: string,
  fileId: string,
): Promise<{ localPath: string; cleanup: () => Promise<void> }> {
  // 1. Resolve the file path via Telegram API
  const fileRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
  );
  if (!fileRes.ok) {
    throw new Error(`Telegram getFile failed: ${fileRes.status}`);
  }
  const fileData = (await fileRes.json()) as {
    ok: boolean;
    result?: { file_path?: string };
  };
  const filePath = fileData.result?.file_path;
  if (!filePath) {
    throw new Error("Telegram getFile returned no file_path");
  }

  // 2. Download the actual file bytes
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const dlRes = await fetch(downloadUrl);
  if (!dlRes.ok) {
    throw new Error(`Telegram file download failed: ${dlRes.status}`);
  }
  const buffer = Buffer.from(await dlRes.arrayBuffer());

  // 3. Write to uploads directory
  const ext = path.extname(filePath) || ".jpg";
  const filename = `${crypto.randomUUID()}${ext}`;
  const dir = config.uploadsDir;
  await fs.mkdir(dir, { recursive: true });
  const localPath = path.join(dir, filename);
  await fs.writeFile(localPath, buffer);

  return {
    localPath,
    cleanup: async () => {
      try {
        await fs.unlink(localPath);
      } catch {
        // best-effort
      }
    },
  };
}
