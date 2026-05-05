import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type SearchRequestBody = {
  productName?: string;
  brand?: string;
  category?: string;
};

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });

const buildSearchQuery = ({ productName, brand, category }: SearchRequestBody): string => {
  const parts = [String(brand || "").trim(), String(productName || "").trim(), String(category || "").trim(), "product"]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return parts || "grocery product";
};

const hasPreferredImageExtension = (value: string): boolean => {
  const pathname = value.split("?")[0].toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => pathname.endsWith(ext));
};

const isValidHttpsImageCandidate = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (!candidate) return false;
  if (!candidate.startsWith("https://")) return false;
  if (candidate.startsWith("data:")) return false;
  return true;
};

const isRedirectingUrl = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
    });

    return response.status >= 300 && response.status < 400;
  } catch {
    return true;
  }
};

const normalizeGoogleImageCandidates = (items: unknown[]): string[] => {
  const values: string[] = [];

  for (const item of items) {
    const obj = item as Record<string, unknown>;
    if (isValidHttpsImageCandidate(obj?.link)) values.push(obj.link);
  }

  const unique = [...new Set(values)];

  return unique.sort((a, b) => {
    const aPreferred = hasPreferredImageExtension(a) ? 1 : 0;
    const bPreferred = hasPreferredImageExtension(b) ? 1 : 0;
    return bPreferred - aPreferred;
  });
};

const chooseBestDirectImageUrl = async (candidates: string[]): Promise<string | null> => {
  for (const candidate of candidates) {
    const isRedirect = await isRedirectingUrl(candidate);
    if (!isRedirect) return candidate;
  }

  return null;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        ...corsHeaders,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  try {
    const googleApiKey = Deno.env.get("GOOGLE_API_KEY") || "";
    const googleCx = Deno.env.get("GOOGLE_CSE_ID") || "";

    const body = (await req.json().catch(() => ({}))) as SearchRequestBody;
    const searchQuery = buildSearchQuery(body);

    let bestImageUrl: string | null = null;

    if (googleApiKey && googleCx) {
      const googleUrl = new URL("https://www.googleapis.com/customsearch/v1");
      googleUrl.searchParams.set("key", googleApiKey);
      googleUrl.searchParams.set("cx", googleCx);
      googleUrl.searchParams.set("searchType", "image");
      googleUrl.searchParams.set("num", "10");
      googleUrl.searchParams.set("q", searchQuery);

      const googleResponse = await fetch(googleUrl.toString());
      if (googleResponse.ok) {
        const googleJson = (await googleResponse.json()) as Record<string, unknown>;
        const items = Array.isArray(googleJson?.items) ? (googleJson.items as unknown[]) : [];
        const candidates = normalizeGoogleImageCandidates(items);
        bestImageUrl = await chooseBestDirectImageUrl(candidates);
      }
    }

    if (bestImageUrl) {
      return new Response(
        JSON.stringify({
          imageUrl: bestImageUrl,
          imageSource: "google",
          imageSearchQuery: searchQuery,
          confidence: 0.9,
          fallbackUsed: false,
        }),
        { headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    return jsonResponse({
      imageUrl: null,
      imageSource: "google",
      imageSearchQuery: searchQuery,
      confidence: 0,
      fallbackUsed: true,
    });
  } catch (error) {
    console.error("search-product-image error", error);
    return jsonResponse(
      {
        imageUrl: null,
        imageSource: "google",
        imageSearchQuery: "",
        confidence: 0,
        fallbackUsed: true,
      },
      200
    );
  }
});
