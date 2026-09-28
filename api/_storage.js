import fs from "fs";
import path from "path";

const CWD_STORAGE = path.join(process.cwd(), ".app_storage.json");
const TMP_STORAGE = path.join(process.env.TMPDIR || "/tmp", "solar_agenda_storage.json");

export function getStoragePath() {
  try {
    if (fs.existsSync(CWD_STORAGE)) {
      fs.accessSync(CWD_STORAGE, fs.constants.R_OK | fs.constants.W_OK);
      return CWD_STORAGE;
    }
    // Test if CWD is writable to create it
    fs.writeFileSync(CWD_STORAGE + ".test", "ok");
    fs.unlinkSync(CWD_STORAGE + ".test");
    return CWD_STORAGE;
  } catch (_) {}
  return TMP_STORAGE;
}

export function readAppStorage() {
  const target = getStoragePath();
  try {
    if (fs.existsSync(target)) {
      return JSON.parse(fs.readFileSync(target, "utf-8"));
    }
  } catch (_) {}
  if (target !== CWD_STORAGE && fs.existsSync(CWD_STORAGE)) {
    try {
      return JSON.parse(fs.readFileSync(CWD_STORAGE, "utf-8"));
    } catch (_) {}
  }
  return {};
}

export function writeAppStorage(partial) {
  const target = getStoragePath();
  const current = readAppStorage();
  const merged = {
    ...current,
    ...partial,
    updatedAt: new Date().toISOString()
  };

  const payload = JSON.stringify(merged, null, 2);

  // Attempt atomic write using temporary file
  try {
    const tempFile = `${target}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, payload, "utf-8");
    fs.renameSync(tempFile, target);
  } catch (err) {
    // Direct write fallback
    try {
      fs.writeFileSync(target, payload, "utf-8");
    } catch (_) {
      try {
        fs.writeFileSync(TMP_STORAGE, payload, "utf-8");
      } catch (_) {}
    }
  }

  return merged;
}
