import fs from "fs";
import path from "path";
import { isSensitivePath } from "./tools.js";

// Read a file's current contents for a write_file diff preview. Guarded by the
// same sensitive-path denylist as the write itself, so previewing an overwrite
// of a credential file never discloses its contents to the terminal. Returns ""
// for a sensitive path or a file that does not exist yet (a new-file write).
export function readForPreview(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (isSensitivePath(resolved)) return "";
  try {
    return fs.readFileSync(resolved, "utf-8");
  } catch {
    return "";
  }
}
