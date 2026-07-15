export async function handler(event) {
  const params = event.queryStringParameters || {};
  const code = params.code;
  const error = params.error;

  if (error) {
    return { statusCode: 400, body: `Instagram auth error: ${error}` };
  }

  if (!code) {
    return { statusCode: 400, body: "Missing authorization code." };
  }

  const clientId = process.env.INSTAGRAM_APP_ID;
  const clientSecret = process.env.INSTAGRAM_APP_SECRET;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

  // Exchange code for short-lived token
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });

  const tokenRes = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    body,
  });

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Token exchange failed", details: tokenData }),
    };
  }

  const shortLivedToken = tokenData.access_token;

  // Exchange for long-lived token (~60 days)
  const longRes = await fetch(
    `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${clientSecret}&access_token=${shortLivedToken}`
  );
  const longData = await longRes.json();

  // v1: show token so you can copy into env vars manually
  // v2: store in Netlify Blobs / DB and redirect to a success page
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Connected. Copy access_token into Netlify env as INSTAGRAM_ACCESS_TOKEN.",
      access_token: longData.access_token,
      expires_in: longData.expires_in,
    }),
  };
}