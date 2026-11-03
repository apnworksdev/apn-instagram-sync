// Weekly: renews the long-lived Instagram token for another ~60 days.
// Instagram requires the token to be at least 24h old and not yet expired.
import { getInstagramToken, saveInstagramToken, notifyFailure } from "../lib/instagram-token.js";

export default async () => {
  const current = await getInstagramToken();
  if (!current?.access_token) {
    await notifyFailure("Token refresh: no Instagram token stored. Reconnect via /.netlify/functions/instagram-auth.");
    return json(500, { ok: false, error: "No token stored" });
  }

  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", current.access_token);

  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) {
    const reason = data.error?.message || `HTTP ${res.status}`;
    await notifyFailure(`Token refresh failed: ${reason}. If it keeps failing, reconnect via /.netlify/functions/instagram-auth.`);
    return json(500, { ok: false, error: reason });
  }

  const saved = await saveInstagramToken({
    access_token: data.access_token,
    expires_in: data.expires_in,
    username: current.username,
    user_id: current.user_id,
  });

  return json(200, { ok: true, username: saved.username, expires_at: saved.expires_at });
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export const config = { schedule: "@weekly" };
