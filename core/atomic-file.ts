import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export function atomicWriteFileSync(
  filePath: string,
  data: string,
  encoding: BufferEncoding = "utf8",
): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.${process.pid}.${randomUUID()}.tmp`);

  let existingMode: number | undefined;
  try {
    existingMode = fs.statSync(filePath).mode;
  } catch {
    // New file: use the platform/default umask behavior.
  }

  try {
    fs.writeFileSync(tempPath, data, { encoding, flag: "wx" });
    if (existingMode !== undefined) {
      fs.chmodSync(tempPath, existingMode);
    }
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup. Preserve the original write error.
    }
    throw error;
  }
}
