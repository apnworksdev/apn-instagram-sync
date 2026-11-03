// OAuth redirect URI. Exchanges the code for a long-lived token and saves it
// in Netlify Blobs. The token is never shown on screen.
import { saveInstagramToken } from "../lib/instagram-token.js";

export default async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state");

  if (error) {
    return page(400, "Instagram didn't connect", `Instagram returned: ${url.searchParams.get("error_description") || error}`);
  }
  if (!code) {
    return page(400, "Missing authorization code", "Open the connect link again and approve access.");
  }

  const cookieState = readCookie(req.headers.get("cookie"), "ig_oauth_state");
  if (!state || !cookieState || state !== cookieState) {
    return page(400, "Link expired", "Please open the connect link again (it's valid for 10 minutes) and finish in the same browser.");
  }

  const clientId = process.env.INSTAGRAM_APP_ID;
  const clientSecret = process.env.INSTAGRAM_APP_SECRET;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

  // 1) code -> short-lived token
  const shortRes = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    }),
  });
  const shortData = await shortRes.json().catch(() => ({}));
  if (!shortRes.ok || !shortData.access_token) {
    console.error("Short-lived token exchange failed:", shortData.error_message || shortData.error || shortRes.status);
    return page(500, "Connection failed", "Instagram refused the login (step 1). Please try again.");
  }

  // 2) short-lived -> long-lived (~60 days)
  const longUrl = new URL("https://graph.instagram.com/access_token");
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", clientSecret);
  longUrl.searchParams.set("access_token", shortData.access_token);
  const longRes = await fetch(longUrl);
  const longData = await longRes.json().catch(() => ({}));
  if (!longRes.ok || !longData.access_token) {
    console.error("Long-lived token exchange failed:", longData.error?.message || longRes.status);
    return page(500, "Connection failed", "Instagram refused the login (step 2). Please try again.");
  }

  // 3) Which account just connected?
  const meUrl = new URL("https://graph.instagram.com/me");
  meUrl.searchParams.set("fields", "user_id,username");
  meUrl.searchParams.set("access_token", longData.access_token);
  const meRes = await fetch(meUrl);
  const me = await meRes.json().catch(() => ({}));
  if (!meRes.ok || !me.username) {
    console.error("Could not read connected account:", me.error?.message || meRes.status);
    return page(500, "Connection failed", "Couldn't confirm which Instagram account connected. Please try again.");
  }

  // 4) Only accept the expected account (stops someone replacing the feed with theirs)
  const allowed = (process.env.INSTAGRAM_ALLOWED_USERNAME || "").trim().toLowerCase();
  if (allowed && me.username.toLowerCase() !== allowed) {
    return page(403, "Wrong account", `You connected @${me.username}, but this site expects @${allowed}. Log out of Instagram, log in with the right account and try again.`);
  }

  const saved = await saveInstagramToken({
    access_token: longData.access_token,
    expires_in: longData.expires_in,
    username: me.username,
    user_id: me.user_id || me.id,
  });

  const until = saved.expires_at ? new Date(saved.expires_at).toLocaleDateString("es-ES") : "unknown";
  return page(
    200,
    "Connected ✓",
    `@${me.username} is connected. The feed will update on the next sync. Access renews automatically (current expiry: ${until}). You can close this page.`,
    { clearStateCookie: true }
  );
};

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function page(status, title, message, { clearStateCookie = false } = {}) {
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
  if (clearStateCookie) headers["Set-Cookie"] = "ig_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5;color:#222}h1{font-size:1.4rem}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  return new Response(html, { status, headers });
}
