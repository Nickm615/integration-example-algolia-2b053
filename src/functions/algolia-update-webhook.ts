import { DeliveryClient } from "@kontent-ai/delivery-sdk";
import {
  SignatureHelper,
  WebhookItemNotification,
} from "@kontent-ai/webhook-helper";
import { Handler } from "@netlify/functions";
import createAlgoliaClient from "algoliasearch";

import { customUserAgent } from "../shared/algoliaUserAgent";
import { convertToAlgoliaItem } from "./utils/algoliaItem";
import { createEnvVars } from "./utils/createEnvVars";
import { sdkHeaders } from "./utils/sdkHeaders";
import { serializeUncaughtErrorsHandler } from "./utils/serializeUncaughtErrorsHandler";

const { envVars, missingEnvVars } = createEnvVars([
  "KONTENT_SECRET",
  "ALGOLIA_API_KEY",
] as const);

const signatureHeaderName = "x-kontent-ai-signature";

export const handler: Handler = serializeUncaughtErrorsHandler(async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!event.body) {
    return { statusCode: 400, body: "Missing Data" };
  }

  if (!envVars.KONTENT_SECRET || !envVars.ALGOLIA_API_KEY) {
    return {
      statusCode: 500,
      body: `${missingEnvVars.join(", ")} environment variable(s) are missing, please check the documentation`,
    };
  }

  // Validate webhook signature for security
  const signatureHelper = new SignatureHelper();
  if (
    !event.headers[signatureHeaderName]
    || !signatureHelper.isValidSignatureFromString(
      event.body,
      envVars.KONTENT_SECRET,
      event.headers[signatureHeaderName],
    )
  ) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  // Parse the webhook notification
  let notification: WebhookItemNotification;
  try {
    notification = JSON.parse(event.body);
  } catch (error) {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  // Extract project ID from webhook message
  const projectId = notification.message?.environment_id;
  if (!projectId) {
    return { statusCode: 400, body: "Missing project_id in webhook message" };
  }

  // Extract item data from webhook
  if (!notification.data?.system) {
    return { statusCode: 400, body: "Missing system data in webhook" };
  }

  const itemCodename = notification.data.system.codename;
  if (!itemCodename) {
    return { statusCode: 400, body: "Missing item codename in webhook" };
  }
  
  // Get Algolia configuration from environment variables
  const algoliaAppId = process.env.ALGOLIA_APP_ID;
  const algoliaIndexName = process.env.ALGOLIA_INDEX_NAME;
  const slugCodename = process.env.SLUG_CODENAME || "url"; // Default to "url"

  if (!algoliaAppId || !algoliaIndexName) {
    return {
      statusCode: 500,
      body: "Missing ALGOLIA_APP_ID or ALGOLIA_INDEX_NAME environment variables",
    };
  }

  // Fetch published item from Delivery API using project ID from webhook
  const deliveryClient = new DeliveryClient({
    environmentId: projectId,
    globalHeaders: () => sdkHeaders,
  });

  try {
    // Fetch the specific item that was published
    const response = await deliveryClient
      .item(itemCodename)
      .queryConfig({ waitForLoadingNewContent: true })
      .toPromise();

    const publishedItem = response.data.item;

    // Also fetch all items to build the map (needed for linked items processing)
    const allItemsResponse = await deliveryClient
      .items()
      .queryConfig({ waitForLoadingNewContent: true })
      .toPromise();

    const allItemsMap = new Map(
      [...allItemsResponse.data.items, ...Object.values(allItemsResponse.data.linkedItems)]
        .map(i => [i.system.codename, i])
    );

    // Transform to Algolia record
    const algoliaRecord = convertToAlgoliaItem(allItemsMap, slugCodename)(publishedItem);

    // Update Algolia
    const algoliaClient = createAlgoliaClient(
      algoliaAppId,
      envVars.ALGOLIA_API_KEY,
      { userAgent: customUserAgent }
    );
    const index = algoliaClient.initIndex(algoliaIndexName);
    await index.saveObject(algoliaRecord).wait();

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        objectID: algoliaRecord.objectID, 
        message: "Successfully indexed item",
        itemCodename: itemCodename,
        projectId: projectId,
      }),
    };
  } catch (error: any) {
    console.error("Error fetching or indexing item:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Failed to fetch or index item",
        details: error.message,
        itemCodename: itemCodename,
      }),
    };
  }
});