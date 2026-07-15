export async function handler() {
  const clientId = process.env.INSTAGRAM_APP_ID;
  const redirectUri = encodeURIComponent(process.env.INSTAGRAM_REDIRECT_URI);
  const scope = "instagram_business_basic";

  const url =
    `https://www.instagram.com/oauth/authorize` +
    `?client_id=${clientId}` +
    `&redirect_uri=${redirectUri}` +
    `&response_type=code` +
    `&scope=${scope}`;

  return {
    statusCode: 302,
    headers: { Location: url },
  };
}