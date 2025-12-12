import { DeliveryClient } from "@kontent-ai/delivery-sdk";
import {
  SignatureHelper,
  WebhookItemNotification,
  WebhookResponse,
} from "@kontent-ai/webhook-helper";
import { Handler } from "@netlify/functions";
import createAlgoliaClient from "algoliasearch";

import { customUserAgent } from "../shared/algoliaUserAgent";
import { hasStringProperty, nameOf } from "../shared/utils/typeguards";
import { convertToAlgoliaItem } from "./utils/algoliaItem";
import { createEnvVars } from "./utils/createEnvVars";
import { sdkHeaders } from "./utils/sdkHeaders";
import { serializeUncaughtErrorsHandler } from "./utils/serializeUncaughtErrorsHandler";

const { envVars, missingEnvVars } = createEnvVars(["KONTENT_SECRET", "ALGOLIA_API_KEY"] as const);

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
      body: `${missingEnvVars.join(", ")} environment variables are missing, please check the documentation`,
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

  // Parse webhook payload
  const webhookData: WebhookResponse = JSON.parse(event.body);

  // Get configuration from query string parameters
  const queryParams = event.queryStringParameters;
  if (!areValidQueryParams(queryParams)) {
    return { statusCode: 400, body: "Missing query parameters (slug, appId, index), please check the documentation" };
  }

  // Initialize Algolia client
  const algoliaClient = createAlgoliaClient(queryParams.appId, envVars.ALGOLIA_API_KEY, { userAgent: customUserAgent });
  const index = algoliaClient.initIndex(queryParams.index);

  // Process each notification
  const actions = (await Promise.all(
    webhookData.notifications
      .filter(n => n.message.object_type === "content_item")
      .map(async notification => {
        if (!isItemNotification(notification)) {
          return [];
        }

        const deliveryClient = new DeliveryClient({
          environmentId: notification.message.environment_id,
          globalHeaders: () => sdkHeaders,
        });

        return await updateItem({
          index,
          deliveryClient,
          slug: queryParams.slug,
          item: notification.data.system,
        });
      }),
  )).flat();

  const recordsToReIndex = [
    ...new Map(actions.flatMap(a => a.recordsToReindex.map(i => [i.codename, i] as const))).values(),
  ];
  const objectIdsToRemove = [...new Set(actions.flatMap(a => a.objectIdsToRemove))];

  const reIndexResponse = recordsToReIndex.length ? await index.saveObjects(recordsToReIndex).wait() : undefined;
  const deletedResponse = objectIdsToRemove.length ? await index.deleteObjects(objectIdsToRemove).wait() : undefined;

  return {
    statusCode: 200,
    body: JSON.stringify({
      deletedObjectIds: deletedResponse?.objectIDs ?? [],
      reIndexedObjectIds: reIndexResponse?.objectIDs ?? [],
    }),
  };
});

type UpdateItemParams = Readonly<{
  index: any; // SearchIndex type
  deliveryClient: DeliveryClient;
  slug: string;
  item: WebhookItemNotification["data"]["system"];
}>;

const updateItem = async (params: UpdateItemParams) => {
  // Fetch the published item with all its linked items
  const deliverItems = await findDeliveryItemWithChildrenByCodename(
    params.deliveryClient,
    params.item.codename,
    params.item.language,
  );
  
  const deliverItem = deliverItems.get(params.item.codename);

  if (!deliverItem) {
    // Item not found (might be unpublished) - no action needed
    return [{
      objectIdsToRemove: [],
      recordsToReindex: [],
    }];
  }

  // Transform to Algolia record
  const algoliaRecord = convertToAlgoliaItem(deliverItem, params.slug)(deliverItem);

  return [{
    objectIdsToRemove: [],
    recordsToReindex: [algoliaRecord],
  }];
};

const findDeliveryItemWithChildrenByCodename = async (
  deliveryClient: DeliveryClient,
  codename: string,
  languageCodename: string,
): Promise<ReadonlyMap<string, any>> => {
  try {
    const response = await deliveryClient
      .item(codename)
      .queryConfig({ waitForLoadingNewContent: true })
      .languageParameter(languageCodename)
      .depthParameter(100)
      .toPromise();

    return new Map([response.data.item, ...Object.values(response.data.linkedItems)].map(i => [i.system.codename, i]));
  } catch {
    return new Map();
  }
};

type ExpectedQueryParams = Readonly<{
  slug: string;
  appId: string;
  index: string;
}>;

const areValidQueryParams = (v: Record<string, unknown> | null): v is ExpectedQueryParams =>
  v !== null
  && hasStringProperty(nameOf<ExpectedQueryParams>("slug"), v)
  && hasStringProperty(nameOf<ExpectedQueryParams>("appId"), v)
  && hasStringProperty(nameOf<ExpectedQueryParams>("index"), v);

const isItemNotification = (notification: any): notification is WebhookItemNotification =>
  notification.message.object_type === "content_item";
