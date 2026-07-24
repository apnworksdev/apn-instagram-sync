const SHOPIFY_API_VERSION = "2025-01";
const METAOBJECT_TYPE = "instagram_post"; // must match your Shopify definition handle
const FILE_READY_ATTEMPTS = 12;
const FILE_READY_DELAY_MS = 1000;

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
      const temporaryImageUrl = getImageUrl(post);

      if (!temporaryImageUrl || !post.permalink) continue;

      const handle = `post-${post.id}`; // unique handle per IG media id
      syncedIds.push(post.id);

      let imageUrl = await getExistingDurableImageUrl(shop, adminToken, handle);

      if (!imageUrl) {
        const downloaded = await downloadInstagramImage(temporaryImageUrl, post.id);
        imageUrl = await uploadImageToShopifyFiles(shop, adminToken, downloaded, post.caption || "");
      }

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
          capabilities: {
            publishable: { status: "ACTIVE" },
          },
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

function isDurableShopifyUrl(url) {
  if (!url) return false;
  return url.includes("cdn.shopify.com") || url.includes("/cdn/shop/");
}

function extensionFromMime(mimeType) {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  return "jpg";
}

async function getExistingDurableImageUrl(shop, token, handle) {
  const result = await shopifyGraphql(shop, token, `
    query GetInstagramPost($handle: MetaobjectHandleInput!) {
      metaobjectByHandle(handle: $handle) {
        field(key: "image_url") {
          value
        }
      }
    }
  `, {
    handle: {
      type: METAOBJECT_TYPE,
      handle,
    },
  });

  const existingUrl = result.data?.metaobjectByHandle?.field?.value;
  return isDurableShopifyUrl(existingUrl) ? existingUrl : null;
}

async function downloadInstagramImage(url, mediaId) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download Instagram image ${mediaId}: ${res.status}`);
  }

  const mimeType = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  const bytes = Buffer.from(await res.arrayBuffer());
  const filename = `instagram-${mediaId}.${extensionFromMime(mimeType)}`;

  return { bytes, mimeType, filename };
}

async function uploadImageToShopifyFiles(shop, token, { bytes, mimeType, filename }, alt) {
  const stagedResult = await shopifyGraphql(shop, token, `
    mutation StageInstagramUpload($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `, {
    input: [
      {
        filename,
        mimeType,
        httpMethod: "POST",
        resource: "FILE",
      },
    ],
  });

  const stagedErrors = stagedResult.data?.stagedUploadsCreate?.userErrors || [];
  if (stagedErrors.length) {
    throw new Error(`stagedUploadsCreate errors: ${JSON.stringify(stagedErrors)}`);
  }

  const target = stagedResult.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url || !target?.resourceUrl) {
    throw new Error("stagedUploadsCreate did not return an upload target.");
  }

  const form = new FormData();
  for (const param of target.parameters || []) {
    form.append(param.name, param.value);
  }
  form.append("file", new Blob([bytes], { type: mimeType }), filename);

  const uploadRes = await fetch(target.url, {
    method: "POST",
    body: form,
  });

  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    throw new Error(`Staged upload POST failed (${uploadRes.status}): ${body}`);
  }

  const createResult = await shopifyGraphql(shop, token, `
    mutation CreateInstagramFile($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          ... on MediaImage {
            image {
              url
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `, {
    files: [
      {
        originalSource: target.resourceUrl,
        contentType: "IMAGE",
        alt: alt.slice(0, 512),
      },
    ],
  });

  const createErrors = createResult.data?.fileCreate?.userErrors || [];
  if (createErrors.length) {
    throw new Error(`fileCreate errors: ${JSON.stringify(createErrors)}`);
  }

  const file = createResult.data?.fileCreate?.files?.[0];
  if (!file?.id) {
    throw new Error("fileCreate did not return a file id.");
  }

  if (file.image?.url) {
    return file.image.url;
  }

  return waitForShopifyFileUrl(shop, token, file.id);
}

async function waitForShopifyFileUrl(shop, token, fileId) {
  for (let attempt = 0; attempt < FILE_READY_ATTEMPTS; attempt++) {
    await sleep(FILE_READY_DELAY_MS);

    const result = await shopifyGraphql(shop, token, `
      query FileReady($id: ID!) {
        node(id: $id) {
          ... on MediaImage {
            fileStatus
            image {
              url
            }
          }
        }
      }
    `, { id: fileId });

    const node = result.data?.node;
    if (node?.fileStatus === "FAILED") {
      throw new Error(`Shopify file processing failed for ${fileId}`);
    }

    if (node?.image?.url) {
      return node.image.url;
    }
  }

  throw new Error(`Timed out waiting for Shopify file URL: ${fileId}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
