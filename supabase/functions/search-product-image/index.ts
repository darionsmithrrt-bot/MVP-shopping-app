import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type SearchRequestBody = {
  query?: string;
  productName?: string;
  product_name?: string;
  brand?: string;
  category?: string;
};

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });

const toCleanText = (value: unknown): string => String(value || "").trim();

const isValidHttpsImageCandidate = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (!candidate) return false;
  if (!candidate.startsWith("https://")) return false;
  if (candidate.startsWith("data:")) return false;
  return true;
};

const buildQueries = (body: SearchRequestBody): string[] => {
  const query = toCleanText(body?.query);
  const productName = toCleanText(body?.productName) || toCleanText(body?.product_name) || query;
  const brand = toCleanText(body?.brand);
  const category = toCleanText(body?.category);

  return [
    `${brand} ${productName}`.trim(),
    productName,
    `${brand} ${category}`.trim(),
    category,
  ].filter(Boolean);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let googleRaw: unknown = null;

  try {
    const googleApiKey = Deno.env.get("GOOGLE_API_KEY") || "";
    const googleCx = Deno.env.get("GOOGLE_CSE_ID") || "";
    let receivedBody: unknown;
    try {
      receivedBody = await req.json();
    } catch {
      return jsonResponse({ error: "Malformed request body" }, 400);
    }

    if (!receivedBody || typeof receivedBody !== "object" || Array.isArray(receivedBody)) {
      return jsonResponse({ error: "Malformed request body" }, 400);
    }

    const body = receivedBody as SearchRequestBody;
    const triedQueries = buildQueries(body);

    if (!triedQueries.length) {
      return jsonResponse({ error: "Malformed request body" }, 400);
    }

    let bestImageUrl: string | null = null;
    let usedQuery = "";
    let resultCount = 0;
    let firstRawResult: unknown = null;

    if (googleApiKey && googleCx) {
      for (const query of triedQueries) {
        const googleUrl = new URL("https://www.googleapis.com/customsearch/v1");
        googleUrl.searchParams.set("key", googleApiKey);
        googleUrl.searchParams.set("cx", googleCx);
        googleUrl.searchParams.set("searchType", "image");
        googleUrl.searchParams.set("num", "10");
        googleUrl.searchParams.set("q", query);

        const googleResponse = await fetch(googleUrl.toString());
        if (!googleResponse.ok) {
          continue;
        }

        googleRaw = await googleResponse.json();
        console.log("GOOGLE RAW RESPONSE:", JSON.stringify(googleRaw, null, 2));
        const googleJson = googleRaw as Record<string, unknown>;
        const items = Array.isArray(googleJson?.items) ? (googleJson.items as unknown[]) : [];

        if (firstRawResult == null && items.length > 0) {
          firstRawResult = items[0];
        }

        resultCount = items.length;
        usedQuery = query;

        const bestItem = items.find((item) => {
          const candidate = (item as Record<string, unknown>)?.link;
          return isValidHttpsImageCandidate(candidate);
        }) as Record<string, unknown> | undefined;

        if (bestItem && isValidHttpsImageCandidate(bestItem.link)) {
          bestImageUrl = bestItem.link;
          break;
        }
      }
    }

    return jsonResponse({
      imageUrl: bestImageUrl,
      imageSource: "google_custom_search",
      imageSearchQuery: usedQuery,
      confidence: bestImageUrl ? 0.9 : 0,
      fallbackUsed: !bestImageUrl,
      debug: {
        receivedBody,
        triedQueries,
        resultCount,
        firstRawResult,
        googleRaw,
      },
    });
  } catch (error) {
    console.error("search-product-image error", error);
    return jsonResponse(
      {
        imageUrl: null,
        imageSource: "google_custom_search",
        imageSearchQuery: "",
        confidence: 0,
        fallbackUsed: true,
        debug: {
          receivedBody: null,
          triedQueries: [],
          resultCount: 0,
          firstRawResult: null,
          googleRaw,
        },
      },
      200
    );
  }
});
