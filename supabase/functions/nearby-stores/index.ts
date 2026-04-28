import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  try {
    const apiKey = Deno.env.get("GOOGLE_PLACES_API_KEY");

    if (!apiKey) {
      return new Response(
        JSON.stringify({ stores: [], debug: { error: "Missing GOOGLE_PLACES_API_KEY" } }),
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    let latitude = 21.3069;
    let longitude = -157.8583;
    let query = "";

    if (req.method === "POST") {
      try {
        const body = await req.json();
        const parsedLatitude = Number(body.latitude ?? latitude);
        const parsedLongitude = Number(body.longitude ?? longitude);
        latitude = Number.isFinite(parsedLatitude) ? parsedLatitude : latitude;
        longitude = Number.isFinite(parsedLongitude) ? parsedLongitude : longitude;
        query = String(body.query ?? "");
      } catch (_) {}
    }

    const hasQuery = query.trim().length >= 3;

    const baseUrl = hasQuery
      ? "https://places.googleapis.com/v1/places:searchText"
      : "https://places.googleapis.com/v1/places:searchNearby";

    const requestBody = hasQuery
      ? {
          textQuery: `${query.trim()} near me`,
          locationBias: {
            circle: {
              center: { latitude, longitude },
              radius: 15000,
            },
          },
        }
      : {
          includedTypes: [
            "supermarket",
            "grocery_store",
            "department_store",
            "drugstore",
            "hardware_store",
            "home_goods_store",
            "shopping_mall",
          ],
          maxResultCount: 20,
          locationRestriction: {
            circle: {
              center: { latitude, longitude },
              radius: 15000,
            },
          },
        };

    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.types",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      let googleBody: unknown;
      try {
        googleBody = await response.json();
      } catch (_) {
        googleBody = await response.text();
      }
      return new Response(
        JSON.stringify({
          stores: [],
          debug: {
            error: "Google Places API returned an error",
            googleStatus: response.status,
            googleStatusText: response.statusText,
            googleBody,
            requestBody,
          },
        }),
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const data = await response.json();
    const places = data.places || [];

    const normalizedStores = places.map((place: any) => ({
      google_place_id: place.id,
      name: place.displayName?.text || "Unknown Store",
      address: place.formattedAddress || null,
      city: "Honolulu",
      state: "HI",
      latitude: place.location?.latitude ?? null,
      longitude: place.location?.longitude ?? null,
      types: place.types || [],
    }));

    return new Response(
      JSON.stringify({
        stores: normalizedStores,
        debug: {
          mode: hasQuery ? "text-search" : "nearby-search",
          query: query || null,
          count: normalizedStores.length,
          sample: normalizedStores.slice(0, 3),
          rawPlaceCount: data?.places?.length ?? 0,
        },
      }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const safeError = error instanceof Error ? error : new Error(String(error));

    return new Response(
      JSON.stringify({
        stores: [],
        debug: {
          error: safeError.message,
          stack: safeError.stack,
        },
      }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
});
