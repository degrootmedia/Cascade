/**
 * OAuth support for remote MCP servers.
 *
 * The MCP SDK drives the flow (discovery, dynamic client registration, PKCE,
 * token refresh). We supply: encrypted on-disk storage for client info +
 * tokens, a browser hand-off for the authorization page, and a loopback HTTP
 * server that catches the redirect with the authorization code.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";

// Soft dependency (see mcp.ts): OAuth flows only run inside Electron, but the
// module must load in the test harness too.
let shell: typeof import("electron").shell | undefined;
let safeStorage: typeof import("electron").safeStorage | undefined;
void import("electron")
  .then((m) => {
    shell = m.shell;
    safeStorage = m.safeStorage;
  })
  .catch(() => {});
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export const CALLBACK_PORT = 17971;
export const CALLBACK_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

interface AuthState {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
}

export class McpOAuthProvider implements OAuthClientProvider {
  private auth: AuthState;
  private file: string;

  constructor(serverName: string, storageDir: string) {
    fs.mkdirSync(storageDir, { recursive: true });
    this.file = path.join(storageDir, `${serverName.replace(/[^a-zA-Z0-9_-]/g, "_")}.bin`);
    this.auth = this.load();
  }

  private load(): AuthState {
    try {
      const blob = fs.readFileSync(this.file);
      if (!safeStorage) return {};
      return JSON.parse(safeStorage.decryptString(blob));
    } catch {
      return {};
    }
  }

  private save(): void {
    if (!safeStorage?.isEncryptionAvailable()) {
      throw new Error("OS encryption unavailable; refusing to store OAuth tokens in plain text");
    }
    fs.writeFileSync(this.file, safeStorage.encryptString(JSON.stringify(this.auth)));
  }

  /** Wipe stored credentials (used when the server rejects them). */
  clear(): void {
    this.auth = {};
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* nothing stored */
    }
  }

  get redirectUrl(): string {
    return CALLBACK_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Cascade",
      redirect_uris: [CALLBACK_URL],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client with PKCE
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.auth.client;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.auth.client = info;
    this.save();
  }

  tokens(): OAuthTokens | undefined {
    return this.auth.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.auth.tokens = tokens;
    this.save();
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!shell) throw new Error("browser hand-off requires Electron");
    void shell.openExternal(authorizationUrl.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.auth.verifier = codeVerifier;
    this.save();
  }

  codeVerifier(): string {
    if (!this.auth.verifier) throw new Error("no PKCE verifier saved");
    return this.auth.verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") this.auth = {};
    if (scope === "client") delete this.auth.client;
    if (scope === "tokens") delete this.auth.tokens;
    if (scope === "verifier") delete this.auth.verifier;
    try {
      this.save();
    } catch {
      /* encryption unavailable; state is already cleared in memory */
    }
  }
}

/**
 * Wait for the browser to hit the loopback callback with an authorization
 * code. One flow at a time; server closes as soon as a code arrives.
 */
export function waitForAuthorizationCode(timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", CALLBACK_URL);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body style="font-family:sans-serif;background:#111417;color:#e6e9ec;display:flex;align-items:center;justify-content:center;height:100vh">
          <div style="text-align:center"><h2>${code ? "Signed in" : "Sign-in failed"}</h2>
          <p>You can close this tab and return to Cascade.</p></div></body></html>`
      );
      cleanup();
      if (code) resolve(code);
      else reject(new Error(`authorization failed: ${error ?? "no code returned"}`));
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("sign-in timed out after 3 minutes"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      server.close();
    }

    server.on("error", (e) => {
      cleanup();
      reject(new Error(`callback server failed (is another sign-in in progress?): ${e.message}`));
    });

    server.listen(CALLBACK_PORT, "127.0.0.1");
  });
}
