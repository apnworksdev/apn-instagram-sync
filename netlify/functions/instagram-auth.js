// Sends the person to Instagram to approve the app.
// Adds a random "state" (stored in a short-lived cookie) so the callback only
// accepts logins that actually started here.
import crypto from "node:crypto";

export default async () => {
  const state = crypto.randomBytes(16).toString("hex");

  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", process.env.INSTAGRAM_APP_ID);
  url.searchParams.set("redirect_uri", process.env.INSTAGRAM_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "instagram_business_basic");
  url.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Set-Cookie": `ig_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      "Cache-Control": "no-store",
    },
  });
};
