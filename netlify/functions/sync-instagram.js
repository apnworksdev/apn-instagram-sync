const SHOPIFY_API_VERSION = "2025-01";
const METAOBJECT_TYPE = "instagram_post"; // must match your Shopify definition handle

export async function handler() {
  try {
    const igToken = process.env.INSTAGRAM_ACCESS_TOKEN;
    const shop = process.env.SHOPIFY_STORE_DOMAIN;
    const adminToken = process.env.SHOPIFY_ADMIN_TOKEN;
    const limit = Number(process.env.INSTAGRAM_POST_LIMIT || 6);

    if (!igToken || !shop || !adminToken) {
      throw new Error("Missing required environment variables.");
    }

    // 1) Fetch Instagram media
    const igFields = [
      "id",
      "caption",
      "media_type",
      "media_url",
      "permalink",
      "thumbnail_url",
      "timestamp",
    ].join(",");

    const igUrl = new URL("https://graph.instagram.com/me/media");
    igUrl.searchParams.set("fields", igFields);
    igUrl.searchParams.set("limit", String(limit));
    igUrl.searchParams.set("access_token", igToken);

    const igRes = await fetch(igUrl);
    const igData = await igRes.json();

    if (!igRes.ok) {
      throw new Error(`Instagram API error: ${JSON.stringify(igData)}`);
    }

    const posts = igData.data || [];
    const syncedIds = [];

    // 2) Upsert each post into Shopify metaobjects
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const imageUrl = getImageUrl(post);

      if (!imageUrl || !post.permalink) continue;

      const handle = `post-${post.id}`; // unique handle per IG media id
      syncedIds.push(post.id);

      const result = await shopifyGraphql(shop, adminToken, `
        mutation UpsertInstagramPost($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
          metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
            metaobject {
              id
              handle
            }
            userErrors {
              field
              message
            }
          }
        }
      `, {
        handle: {
          type: METAOBJECT_TYPE,
          handle,
        },
        metaobject: {
          fields: [
            { key: "external_id", value: post.id },
            { key: "permalink", value: post.permalink },
            { key: "image_url", value: imageUrl },
            { key: "caption", value: post.caption || "" },
            { key: "media_type", value: post.media_type || "IMAGE" },
            { key: "published_at", value: post.timestamp || new Date().toISOString() },
            { key: "sort_order", value: String(i + 1) },
          ],
        },
      });

      const errors = result.data?.metaobjectUpsert?.userErrors || [];
      if (errors.length) {
        console.error("Metaobject upsert errors:", errors);
      }
    }

    // 3) Optional cleanup: remove old posts no longer in latest fetch
    await cleanupStalePosts(shop, adminToken, syncedIds);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        syncedCount: syncedIds.length,
        syncedIds,
      }),
    };
  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: error.message,
      }),
    };
  }
}

function getImageUrl(post) {
  if (post.media_type === "VIDEO") return post.thumbnail_url || post.media_url;
  if (post.media_type === "CAROUSEL_ALBUM") return post.media_url || post.thumbnail_url;
  return post.media_url || post.thumbnail_url;
}

async function shopifyGraphql(shop, token, query, variables) {
  const res = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const json = await res.json();

  if (!res.ok || json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors || json)}`);
  }

  return json;
}

async function cleanupStalePosts(shop, token, currentIds) {
  const result = await shopifyGraphql(shop, token, `
    query GetInstagramPosts($type: String!) {
      metaobjects(type: $type, first: 50) {
        nodes {
          id
          handle
          field(key: "external_id") {
            value
          }
        }
      }
    }
  `, { type: METAOBJECT_TYPE });

  const nodes = result.data?.metaobjects?.nodes || [];

  for (const node of nodes) {
    const externalId = node.field?.value;
    if (!externalId || currentIds.includes(externalId)) continue;

    await shopifyGraphql(shop, token, `
      mutation DeleteMetaobject($id: ID!) {
        metaobjectDelete(id: $id) {
          deletedId
          userErrors {
            field
            message
          }
        }
      }
    `, { id: node.id });
  }
}