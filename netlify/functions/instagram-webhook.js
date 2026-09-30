export async function handler(event) {
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};
    const mode = params["hub.mode"];
    const token = params["hub.verify_token"];
    const challenge = params["hub.challenge"];

    if (
      mode === "subscribe" &&
      token &&
      token === process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN
    ) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/plain" },
        body: String(challenge ?? ""),
      };
    }

    return { statusCode: 403, body: "Verification failed" };
  }

  if (event.httpMethod === "POST") {
    return { statusCode: 200, body: "EVENT_RECEIVED" };
  }

  return { statusCode: 405, body: "Method not allowed" };
}
