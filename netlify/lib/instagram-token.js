// Shared helpers: where the Instagram token lives, and how failures are reported.
// Lives outside netlify/functions so Netlify doesn't deploy it as a function.
import { getStore } from "@netlify/blobs";

const STORE_NAME = "instagram";
const TOKEN_KEY = "access-token";

function tokenStore() {
  // "strong" so the sync always reads the token the refresh/callback just wrote.
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

/**
 * Returns { access_token, username, user_id, saved_at, expires_at } or null.
 * Falls back to the old INSTAGRAM_ACCESS_TOKEN env var, so nothing breaks
 * before the first connection through the new callback.
 */
export async function getInstagramToken() {
  const saved = await tokenStore().get(TOKEN_KEY, { type: "json" });
  if (saved?.access_token) return saved;

  const envToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (envToken) return { access_token: envToken, source: "env" };

  return null;
}

export async function saveInstagramToken({ access_token, expires_in, username, user_id }) {
  const now = Date.now();
  const record = {
    access_token,
    username: username || null,
    user_id: user_id || null,
    saved_at: new Date(now).toISOString(),
    expires_at: expires_in ? new Date(now + Number(expires_in) * 1000).toISOString() : null,
  };
  await tokenStore().setJSON(TOKEN_KEY, record);
  return record;
}

/**
 * Optional alert. Set ALERT_WEBHOOK_URL to a Slack (or compatible) incoming
 * webhook to get a message when the sync or the refresh fails.
 * Never put the token in the message.
 */
export async function notifyFailure(message) {
  console.error(message);
  const webhook = process.env.ALERT_WEBHOOK_URL;
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `[apn-feed-sync] ${message}` }),
    });
  } catch (err) {
    console.error("Alert webhook failed:", err.message);
  }
}
