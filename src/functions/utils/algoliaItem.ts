import { IContentItem } from "@kontent-ai/delivery-sdk";

export type AlgoliaItem = {
  readonly id: string;
  readonly objectID: string;
  readonly codename: string;
  readonly name: string;
  readonly language: string;
  readonly type: string;
  readonly slug: string | undefined;
  readonly collection: string;
  
  // Structured campground fields
  readonly campground_name?: string;
  readonly phone?: string;
  readonly email?: string;
  readonly address?: string;
  readonly city?: string;
  readonly state?: string;
  readonly zip?: string;
  readonly description?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly amenities?: readonly string[];
  readonly ways_to_stay?: readonly string[];
  readonly region?: string;
  readonly google_place_id?: string;
  
  // Legacy content blocks for non-campground types
  readonly content: readonly ContentBlock[];
};

type ContentBlock = {
  readonly id: string;
  readonly codename: string;
  readonly name: string;
  readonly type: string;
  readonly language: string;
  readonly collection: string;
  readonly parents: readonly string[];
  readonly contents: string;
};

/**
 * Filter function - checks if item has a slug
 */
export const canConvertToAlgoliaItem = (slugCodename: string) => (item: IContentItem): boolean => {
  const slugElement = item.elements[slugCodename];
  return !!slugElement && typeof slugElement.value === "string" && slugElement.value.length > 0;
};

/**
 * Converts Delivery SDK item to Algolia record
 */
export const convertToAlgoliaItem = (allItemsMap: Map<string, IContentItem>, slugCodename: string) => (
  item: IContentItem
): AlgoliaItem => {
  const slugElement = item.elements[slugCodename];
  const slug = slugElement && typeof slugElement.value === "string" ? slugElement.value : undefined;

  // Special handling for Campground content type
  if (item.system.type === "campground") {
    return convertCampgroundToAlgolia(item, slug);
  }

  // Default handling for other content types (legacy format)
  const processedItems = new Set<string>();
  const contentBlocks = createRecordBlocks(item, allItemsMap, processedItems, slugCodename);

  return {
    id: item.system.id,
    objectID: `${item.system.id}_${item.system.language}`,
    codename: item.system.codename,
    name: item.system.name,
    language: item.system.language,
    type: item.system.type,
    slug,
    collection: item.system.collection || "",
    content: contentBlocks,
  };
};

/**
 * Converts campground item to structured Algolia record
 */
const convertCampgroundToAlgolia = (item: IContentItem, slug: string | undefined): AlgoliaItem => {
  const getElement = (codename: string) => item.elements[codename];
  const getTextValue = (codename: string): string | undefined => {
    const el = getElement(codename);
    return el && typeof el.value === "string" ? el.value : undefined;
  };
  const getNumberValue = (codename: string): number | undefined => {
    const el = getElement(codename);
    return el && typeof el.value === "number" ? el.value : undefined;
  };

  // Extract and parse address
  const address = getTextValue('address') || '';
  const { city, state, zip } = parseAddress(address);

  // Extract description from rich text
  const bannerBody = getTextValue('banner_body');
  const description = bannerBody ? stripHtml(bannerBody) : undefined;

  // Extract taxonomy terms
  const amenitiesEl = getElement('amenities');
  const amenities = amenitiesEl && Array.isArray(amenitiesEl.value)
    ? amenitiesEl.value.map((t: any) => t.codename).filter(Boolean)
    : undefined;

  const waysToStayEl = getElement('ways_to_stay');
  const waysToStay = waysToStayEl && Array.isArray(waysToStayEl.value)
    ? waysToStayEl.value.map((t: any) => t.codename).filter(Boolean)
    : undefined;

  const regionEl = getElement('region');
  const region = regionEl && Array.isArray(regionEl.value) && regionEl.value.length > 0
    ? regionEl.value[0].codename
    : undefined;

  return {
    id: item.system.id,
    objectID: `${item.system.id}_${item.system.language}`,
    codename: item.system.codename,
    name: item.system.name,
    language: item.system.language,
    type: "campground",
    slug,
    collection: item.system.collection || "",
    
    // Structured campground fields
    campground_name: getTextValue('name'),
    phone: getTextValue('phone_number'),
    email: getTextValue('email_address'),
    address,
    city,
    state,
    zip,
    description,
    latitude: getNumberValue('latitude_coordinate'),
    longitude: getNumberValue('longitude_coordinate'),
    amenities,
    ways_to_stay: waysToStay,
    region,
    google_place_id: getTextValue('google_place_id'),
    
    content: [], // Empty for campgrounds since we have structured fields
  };
};

/**
 * Parse address string into city, state, zip components
 */
const parseAddress = (address: string): { city?: string; state?: string; zip?: string } => {
  if (!address) return {};
  
  // Address format: "Street\nCity, State ZIP"
  const lines = address.split('\n').filter(l => l.trim());
  if (lines.length < 2) return {};
  
  const cityStateLine = lines[lines.length - 1]; // Last line has city, state, zip
  const match = cityStateLine.match(/^([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  
  if (match) {
    return {
      city: match[1].trim(),
      state: match[2].trim(),
      zip: match[3].trim()
    };
  }
  
  return {};
};

/**
 * Strip HTML tags from rich text
 */
const stripHtml = (html: string): string => {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * Creates content blocks from item (legacy format for non-campground types)
 */
const createRecordBlocks = (
  item: IContentItem,
  allItemsMap: Map<string, IContentItem>,
  processedItems: Set<string>,
  slugCodename: string
): ContentBlock[] => {
  const itemKey = `${item.system.id}_${item.system.language}`;
  
  if (processedItems.has(itemKey)) {
    return [];
  }
  processedItems.add(itemKey);

  let contents = "";
  const parents: string[] = [];

  // Extract text from all elements
  for (const [key, element] of Object.entries(item.elements)) {
    if (key === "metadata") continue;

    if (typeof element.value === "string") {
      const textValue = element.type === "rich_text"
        ? element.value.replace(/<[^>]*>/g, " ")
        : element.value;
      contents += ` ${textValue}`;
    }

    // Track linked items
    if (Array.isArray(element.value) && element.type === "modular_content") {
      for (const linkedItem of element.value) {
        if (typeof linkedItem === "object" && "system" in linkedItem) {
          const linkedItemData = linkedItem as IContentItem;
          
          // Check if linked item has a slug
          const linkedSlugElement = linkedItemData.elements[slugCodename];
          const hasSlug = linkedSlugElement && typeof linkedSlugElement.value === "string" && linkedSlugElement.value.length > 0;
          
          if (!hasSlug) {
            // Include content from linked items without slugs
            const linkedBlocks = createRecordBlocks(linkedItemData, allItemsMap, processedItems, slugCodename);
            contents += " " + linkedBlocks.map(b => b.contents).join(" ");
          } else {
            // Track as parent but don't include content (avoid duplication)
            parents.push(linkedItemData.system.id);
          }
        }
      }
    }
  }

  return [
    {
      id: item.system.id,
      codename: item.system.codename,
      name: item.system.name,
      type: item.system.type,
      language: item.system.language,
      collection: item.system.collection || "",
      parents,
      contents: contents.trim(),
    },
  ];
};