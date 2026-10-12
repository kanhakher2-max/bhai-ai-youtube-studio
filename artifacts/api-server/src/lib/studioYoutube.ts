import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { eq } from "drizzle-orm";
import type { Request, Response as ExpressResponse } from "express";
import { db, studioOwnersTable } from "@workspace/db";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2/reports";
const OAUTH_COOKIE = "studio_youtube_oauth";
const OAUTH_COOKIE_TTL_MS = 5 * 60 * 1000;

const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
];

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
};

type OAuthBundle = { refreshToken: string };

function getGoogleConfig() {
  const clientId = process.env.YOUTUBE_CLIENT_ID?.trim();
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return null;
  }
  const isLocalHttp =
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !isLocalHttp) return null;
  return { clientId, clientSecret, redirectUri: parsed.toString() };
}

function sessionSecret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) {
    throw new Error("Server-side session secret is not configured.");
  }
  return value;
}

function encryptionKey(): Buffer {
  return createHash("sha256")
    .update("BHAI AI Studio YouTube OAuth token encryption v1\0")
    .update(sessionSecret())
    .digest();
}

function encryptBundle(bundle: OAuthBundle): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(bundle), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function decryptBundle(ciphertext: string): OAuthBundle {
  const [version, ivText, tagText, encryptedText] = ciphertext.split(".");
  if (
    version !== "v1" ||
    !ivText ||
    !tagText ||
    !encryptedText ||
    ciphertext.split(".").length !== 4
  ) {
    throw new Error("Encrypted YouTube credentials need to be reconnected.");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(ivText, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as Partial<OAuthBundle>;
    if (typeof parsed.refreshToken !== "string" || !parsed.refreshToken) {
      throw new Error("Stored YouTube credentials are invalid.");
    }
    return { refreshToken: parsed.refreshToken };
  } catch {
    throw new Error(
      "Unable to decrypt saved YouTube credentials. Restore the original SESSION_SECRET or reconnect the channel.",
    );
  }
}

function createSignedState(state: string, timestamp: number): string {
  const message = `${state}.${timestamp}`;
  const signature = createHmac("sha256", sessionSecret())
    .update(message)
    .digest("base64url");
  return `${message}.${signature}`;
}

function verifySignedState(
  signed: string,
  state: string,
): boolean {
  const parts = signed.split(".");
  if (parts.length !== 3 || parts[0] !== state) return false;
  const timestamp = Number(parts[1]);
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp > Date.now() ||
    Date.now() - timestamp > OAUTH_COOKIE_TTL_MS
  ) {
    return false;
  }
  const expected = createHmac("sha256", sessionSecret())
    .update(`${parts[0]}.${parts[1]}`)
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(parts[2] ?? "", "base64url");
  } catch {
    return false;
  }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function cookieValue(req: Request, name: string): string | null {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function cookieOptions(req: Request) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const isSecure =
    process.env.NODE_ENV === "production" ||
    (typeof forwardedProto === "string" &&
      forwardedProto.split(",")[0]?.trim() === "https");
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecure,
    path: "/api/studio/youtube/callback",
    maxAge: OAUTH_COOKIE_TTL_MS,
  };
}

function redirectWithStatus(status: string): string {
  const config = getGoogleConfig();
  const configuredOrigin = process.env.STUDIO_PUBLIC_ORIGIN?.trim();
  const origin =
    configuredOrigin ||
    (config ? new URL(config.redirectUri).origin : undefined);
  if (!origin) {
    return `/publishing?youtube=${encodeURIComponent(status)}`;
  }
  const url = new URL("/publishing", origin);
  url.searchParams.set("youtube", status);
  return url.toString();
}

async function ownerRow() {
  const [owner] = await db.select().from(studioOwnersTable).limit(1);
  return owner ?? null;
}

async function requestJson(
  url: string | URL,
  init: RequestInit,
  timeoutMs = 12_000,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return { response, body };
}

export function youtubeOAuthConfigured(): boolean {
  return getGoogleConfig() !== null;
}

export async function youtubeStatus() {
  const config = youtubeOAuthConfigured();
  const owner = await ownerRow();
  const connected = Boolean(
    owner?.youtubeTokenCiphertext &&
      owner.youtubeChannelId &&
      owner.youtubeChannelTitle,
  );
  return {
    configured: config,
    connected,
    channelTitle: connected ? owner?.youtubeChannelTitle ?? null : null,
    detail: !config
      ? "Add YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and an HTTPS YOUTUBE_REDIRECT_URI as server-side secrets. No account is connected."
      : connected
        ? "Channel connected. OAuth refresh tokens are encrypted on the server; the original SESSION_SECRET is required to decrypt them after migration."
        : "YouTube OAuth is configured. Use Connect channel to grant read-only channel and analytics scopes.",
  };
}

export function beginYouTubeOAuth(req: Request, res: ExpressResponse): void {
  const config = getGoogleConfig();
  if (!config) {
    res.status(503).json({
      error:
        "Configure YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and YOUTUBE_REDIRECT_URI first.",
    });
    return;
  }
  try {
    const state = randomBytes(32).toString("base64url");
    const timestamp = Date.now();
    res.cookie(OAUTH_COOKIE, createSignedState(state, timestamp), cookieOptions(req));
    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", YOUTUBE_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    res.redirect(302, url.toString());
  } catch (error) {
    req.log.error({ err: error }, "Could not begin YouTube OAuth");
    res.status(500).json({ error: "Could not start YouTube channel connection." });
  }
}

export async function finishYouTubeOAuth(
  req: Request,
  res: ExpressResponse,
): Promise<void> {
  const options = cookieOptions(req);
  res.clearCookie(OAUTH_COOKIE, options);
  const config = getGoogleConfig();
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const signedCookie = cookieValue(req, OAUTH_COOKIE);

  if (!config) {
    res.redirect(302, redirectWithStatus("not-configured"));
    return;
  }
  try {
    if (
      !code ||
      !state ||
      !signedCookie ||
      !verifySignedState(signedCookie, state)
    ) {
      res.redirect(302, redirectWithStatus("state-error"));
      return;
    }
    if (typeof req.query.error === "string") {
      res.redirect(302, redirectWithStatus("authorization-denied"));
      return;
    }
    const tokenForm = new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    });
    const tokenResult = await requestJson(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenForm,
    });
    if (!tokenResult.response.ok) {
      req.log.warn(
        { statusCode: tokenResult.response.status },
        "YouTube OAuth code exchange failed",
      );
      res.redirect(302, redirectWithStatus("token-error"));
      return;
    }
    const token = tokenResult.body as GoogleTokenResponse;
    if (
      typeof token.access_token !== "string" ||
      typeof token.refresh_token !== "string"
    ) {
      res.redirect(302, redirectWithStatus("refresh-token-missing"));
      return;
    }
    const channelResult = await requestJson(
      new URL(`${YOUTUBE_API}/channels?part=snippet&mine=true`),
      { headers: { Authorization: `Bearer ${token.access_token}` } },
    );
    const channels = channelResult.body.items;
    const channel = Array.isArray(channels)
      ? (channels[0] as
          | { id?: unknown; snippet?: { title?: unknown } }
          | undefined)
      : undefined;
    if (
      !channelResult.response.ok ||
      typeof channel?.id !== "string" ||
      typeof channel.snippet?.title !== "string"
    ) {
      res.redirect(302, redirectWithStatus("channel-unavailable"));
      return;
    }
    const owner = await ownerRow();
    if (!owner) {
      res.redirect(302, redirectWithStatus("owner-unavailable"));
      return;
    }
    await db
      .update(studioOwnersTable)
      .set({
        youtubeTokenCiphertext: encryptBundle({
          refreshToken: token.refresh_token,
        }),
        youtubeChannelId: channel.id,
        youtubeChannelTitle: channel.snippet.title.slice(0, 200),
      })
      .where(eq(studioOwnersTable.id, owner.id));
    res.redirect(302, redirectWithStatus("connected"));
  } catch (error) {
    req.log.error(
      { message: error instanceof Error ? error.message.slice(0, 160) : "unknown" },
      "YouTube OAuth callback failed",
    );
    res.redirect(302, redirectWithStatus("connection-error"));
  }
}

async function getAccessToken(): Promise<{
  accessToken: string;
  owner: NonNullable<Awaited<ReturnType<typeof ownerRow>>>;
}> {
  const owner = await ownerRow();
  if (!owner?.youtubeTokenCiphertext) {
    throw new Error("Connect a YouTube channel first.");
  }
  const stored = decryptBundle(owner.youtubeTokenCiphertext);
  const config = getGoogleConfig();
  if (!config) {
    throw new Error("YouTube OAuth server settings are incomplete.");
  }
  const result = await requestJson(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: stored.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!result.response.ok || typeof result.body.access_token !== "string") {
    if (result.body.error === "invalid_grant") {
      await db
        .update(studioOwnersTable)
        .set({
          youtubeTokenCiphertext: null,
          youtubeChannelId: null,
          youtubeChannelTitle: null,
        })
        .where(eq(studioOwnersTable.id, owner.id));
      throw new Error(
        "YouTube authorization expired or was revoked. Connect the channel again.",
      );
    }
    throw new Error(
      `Could not refresh YouTube authorization (HTTP ${result.response.status}). Reconnect the channel if this continues.`,
    );
  }
  return { accessToken: result.body.access_token, owner };
}

export async function youtubeAnalytics() {
  if (!youtubeOAuthConfigured()) {
    return {
      available: false,
      views: null,
      subscribers: null,
      estimatedRevenue: null,
      currency: null,
      detail: "Configure Google OAuth before requesting channel analytics.",
    };
  }
  const owner = await ownerRow();
  if (!owner?.youtubeTokenCiphertext || !owner.youtubeChannelId) {
    return {
      available: false,
      views: null,
      subscribers: null,
      estimatedRevenue: null,
      currency: null,
      detail: "Connect a YouTube channel to view authorized analytics.",
    };
  }
  try {
    const { accessToken } = await getAccessToken();
    const channelUrl = new URL(`${YOUTUBE_API}/channels`);
    channelUrl.searchParams.set("part", "statistics");
    channelUrl.searchParams.set("id", owner.youtubeChannelId);
    const channelResult = await requestJson(channelUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const channelItems = channelResult.body.items;
    const channel = Array.isArray(channelItems)
      ? (channelItems[0] as
          | { statistics?: { viewCount?: unknown; subscriberCount?: unknown } }
          | undefined)
      : undefined;
    if (!channelResult.response.ok || !channel?.statistics) {
      return {
        available: false,
        views: null,
        subscribers: null,
        estimatedRevenue: null,
        currency: null,
        detail: `YouTube channel statistics are unavailable (HTTP ${channelResult.response.status}).`,
      };
    }
    const safeCount = (value: unknown): number | null => {
      const number = typeof value === "string" ? Number(value) : Number.NaN;
      return Number.isSafeInteger(number) && number >= 0 ? number : null;
    };
    const views = safeCount(channel.statistics.viewCount);
    const subscribers = safeCount(channel.statistics.subscriberCount);
    let estimatedRevenue: number | null = null;
    let currency: string | null = null;
    let revenueDetail = "Revenue data is not available for this channel/account.";
    try {
      const end = new Date();
      end.setUTCDate(end.getUTCDate() - 1);
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - 27);
      const dateText = (date: Date) => date.toISOString().slice(0, 10);
      const analyticsUrl = new URL(ANALYTICS_API);
      analyticsUrl.searchParams.set("ids", "channel==MINE");
      analyticsUrl.searchParams.set("startDate", dateText(start));
      analyticsUrl.searchParams.set("endDate", dateText(end));
      analyticsUrl.searchParams.set("metrics", "estimatedRevenue");
      const revenueResult = await requestJson(analyticsUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (revenueResult.response.ok) {
        const columns = revenueResult.body.columnHeaders;
        const rows = revenueResult.body.rows;
        if (Array.isArray(columns) && Array.isArray(rows) && rows.length > 0) {
          const revenueIndex = columns.findIndex(
            (column) =>
              typeof column === "object" &&
              column !== null &&
              (column as { name?: unknown }).name === "estimatedRevenue",
          );
          if (revenueIndex >= 0) {
            const values = rows
              .map((row) =>
                Array.isArray(row) ? Number(row[revenueIndex]) : Number.NaN,
              )
              .filter(Number.isFinite);
            if (values.length > 0) {
              estimatedRevenue = values.reduce((sum, value) => sum + value, 0);
              currency = "USD";
              revenueDetail =
                "Estimated revenue is from the authorized YouTube Analytics API for the last 28 complete days.";
            }
          }
        }
      }
    } catch {
      // Views and subscriber totals remain useful when the monetary scope is unavailable.
    }
    return {
      available: views !== null || subscribers !== null,
      views,
      subscribers,
      estimatedRevenue,
      currency,
      detail: `Channel total views and subscribers are live from YouTube. ${revenueDetail}`,
    };
  } catch (error) {
    return {
      available: false,
      views: null,
      subscribers: null,
      estimatedRevenue: null,
      currency: null,
      detail:
        error instanceof Error
          ? error.message.slice(0, 240)
          : "Could not retrieve authorized YouTube analytics.",
    };
  }
}

export async function disconnectYouTube(): Promise<void> {
  const owner = await ownerRow();
  if (!owner) return;
  await db
    .update(studioOwnersTable)
    .set({
      youtubeTokenCiphertext: null,
      youtubeChannelId: null,
      youtubeChannelTitle: null,
    })
    .where(eq(studioOwnersTable.id, owner.id));
}
