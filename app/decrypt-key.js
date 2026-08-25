// Decrypt the installed app's real gab.ai API key via safeStorage.
const { app, safeStorage } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Mirror the app's userData path exactly.
app.commandLine.appendSwitch("password-store", "basic");
app.setPath("userData", path.join(app.getPath("appData"), "cascade-app"));

const settingsPath = path.join(app.getPath("userData"), "settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
console.log("MODEL =", settings.model);
console.log("WORKSPACE =", settings.workspace);
console.log("encryptedApiKey present =", !!settings.encryptedApiKey);

try {
  if (!safeStorage.isEncryptionAvailable()) {
    console.log("safeStorage UNAVAILABLE");
  } else {
    const key = safeStorage.decryptString(Buffer.from(settings.encryptedApiKey, "base64"));
    console.log("DECRYPTED_KEY =", key);
  }
} catch (e) {
  console.log("DECRYPT FAILED:", String(e));
}
app.exit(0);