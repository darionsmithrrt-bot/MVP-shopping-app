import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type IdentifyProductResult = {
  product_name: string;
  brand: string;
  category: string;
  size_value: string;
  size_unit: string;
  size_confidence: number;
  quantity: string;
  quantity_confidence: number;
  price: number | null;
  price_unit: "unknown" | "each" | "price_per_lb" | "price_per_oz" | "price_per_kg" | "price_per_pack";
  price_confidence: number;
  confidence: number;
  raw_text: string;
};

const DEFAULT_RESULT: IdentifyProductResult = {
  product_name: "",
  brand: "",
  category: "",
  size_value: "",
  size_unit: "",
  size_confidence: 0,
  quantity: "1",
  quantity_confidence: 0,
  price: null,
  price_unit: "unknown",
  price_confidence: 0,
  confidence: 0,
  raw_text: "",
};

const VALID_PRICE_UNITS = new Set([
  "unknown",
  "each",
  "price_per_lb",
  "price_per_oz",
  "price_per_kg",
  "price_per_pack",
]);

const ROLE_LABELS: Record<string, string> = {
  product_label: "product front label",
  size_label: "size / net weight label",
  price_sign: "shelf price sign",
};

const VALID_IMAGE_ROLES = new Set(["product_label", "size_label", "price_sign"]);

const SYSTEM_PROMPT = `You are a grocery product identification assistant.

Analyze all provided images together.

Photo roles may include:
1. product_label
2. size_label
3. price_sign

Use cross-image reasoning:
- product_label image identifies brand/name
- size_label image identifies size/net weight
- price_sign image identifies price/unit
- combine these into one product result

Extract only what is visible or strongly supported by the images.

Return ONLY valid JSON with this exact shape:

{
  "product_name": "",
  "brand": "",
  "category": "",
  "size_value": "",
  "size_unit": "",
  "quantity": "1",
  "price": null,
  "price_unit": "unknown",
  "confidence": 0,
  "size_confidence": 0,
  "quantity_confidence": 0,
  "price_confidence": 0,
  "raw_text": ""
}

Rules:
- product_name must be the consumer-facing product name, not "Unknown product", if any readable label is visible.
- brand should be the brand/logo name if visible.
- size_value and size_unit should come from net weight, net wt, fl oz, oz, lb, g, kg, count, pack, etc.
- quantity should be "1" unless a multipack/count is visible.
- price should only come from shelf/price sign images.
- price_unit should be one of:
  "each", "price_per_lb", "price_per_oz", "price_per_kg", "price_per_pack", "unknown"
- If price sign says $3.49/lb, return price: 3.49 and price_unit: "price_per_lb".
- If price sign says $2.99 each, return price: 2.99 and price_unit: "each".
- Do not invent price if not visible.
- raw_text should include all readable text from the images.
- confidence values must be decimals from 0 to 1.

Important:
Return JSON only. No markdown. No explanation.`;

const JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    product_name: { type: "string" },
    brand: { type: "string" },
    category: { type: "string" },
    size_value: { type: "string" },
    size_unit: { type: "string" },
    size_confidence: { type: "number" },
    quantity: { type: "string" },
    quantity_confidence: { type: "number" },
    price: { type: ["number", "null"] },
    price_unit: {
      type: "string",
      enum: ["unknown", "each", "price_per_lb", "price_per_oz", "price_per_kg", "price_per_pack"],
    },
    price_confidence: { type: "number" },
    confidence: { type: "number" },
    raw_text: { type: "string" },
  },
  required: [
    "product_name",
    "brand",
    "category",
    "size_value",
    "size_unit",
    "size_confidence",
    "quantity",
    "quantity_confidence",
    "price",
    "price_unit",
    "price_confidence",
    "confidence",
    "raw_text",
  ],
};

const normalizeConfidence = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n <= 1) return Number(n.toFixed(4));
  if (n <= 100) return Number((n / 100).toFixed(4));
  return 1;
};

const normalizePrice = (value: unknown): number | null => {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Number(value.toFixed(2));
  }
  if (typeof value === "string") {
    const match = value.replace(/[$,]/g, "").match(/\d+(?:\.\d{1,2})?/);
    const parsed = match ? Number(match[0]) : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Number(parsed.toFixed(2));
  }
  return null;
};

const extractModelText = (data: Record<string, unknown>): string => {
  const outputText = data?.output_text;
  if (typeof outputText === "string" && outputText.trim()) {
    return outputText.trim();
  }

  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    const content = Array.isArray((item as Record<string, unknown>)?.content)
      ? ((item as Record<string, unknown>).content as unknown[])
      : [];
    for (const part of content) {
      const textValue = (part as Record<string, unknown>)?.text;
      if (typeof textValue === "string" && textValue.trim()) {
        return textValue.trim();
      }
    }
  }

  const fallbackText = data?.response;
  if (typeof fallbackText === "string" && fallbackText.trim()) {
    return fallbackText.trim();
  }
  return "";
};

const extractJsonObjectText = (raw: string): string => {
  const cleaned = String(raw || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  if (!cleaned) return "";

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return cleaned.slice(firstBrace, lastBrace + 1).trim();
  }

  return cleaned;
};

const normalizeParsedResult = (parsed: Record<string, unknown>): IdentifyProductResult => {
  const price = normalizePrice(parsed.price);
  const priceUnitRaw = typeof parsed.price_unit === "string" ? parsed.price_unit : "unknown";

  const price_unit = VALID_PRICE_UNITS.has(priceUnitRaw) ? priceUnitRaw : "unknown";

  const quantityRaw = typeof parsed.quantity === "string" ? parsed.quantity.trim() : "";

  return {
    product_name: typeof parsed.product_name === "string" ? parsed.product_name.trim() : "",
    brand: typeof parsed.brand === "string" ? parsed.brand.trim() : "",
    category: typeof parsed.category === "string" ? parsed.category.trim() : "",
    size_value: typeof parsed.size_value === "string" ? parsed.size_value.trim() : "",
    size_unit: typeof parsed.size_unit === "string" ? parsed.size_unit.trim().toLowerCase() : "",
    size_confidence: normalizeConfidence(parsed.size_confidence),
    quantity: quantityRaw || "1",
    quantity_confidence: normalizeConfidence(parsed.quantity_confidence),
    price,
    price_unit: price == null ? "unknown" : (price_unit as IdentifyProductResult["price_unit"]),
    price_confidence: price == null ? 0 : normalizeConfidence(parsed.price_confidence),
    confidence: normalizeConfidence(parsed.confidence),
    raw_text: typeof parsed.raw_text === "string" ? parsed.raw_text.trim() : "",
  };
};

const defaultRoleByIndex = (index: number): string => {
  if (index === 0) return "product_label";
  if (index === 1) return "size_label";
  if (index === 2) return "price_sign";
  return "price_sign";
};

const normalizeRole = (value: unknown, index: number): string => {
  const role = typeof value === "string" ? value.trim() : "";
  if (VALID_IMAGE_ROLES.has(role)) return role;
  return defaultRoleByIndex(index);
};

serve(async (req) => {
  try {
    const debugVersion = "identify-product-debug-v3";
    const jsonResponse = (status: number, payload: Record<string, unknown>) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    if (req.method === "OPTIONS") {
      return jsonResponse(200, { ok: true, debug_version: debugVersion });
    }

    const body = await req.json();
    const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const openAiApiKey = Deno.env.get("OPENAI_API_KEY");

    if (!openAiApiKey) {
      return jsonResponse(500, {
        error: "Missing OPENAI_API_KEY",
        debug_version: debugVersion,
      });
    }

    if (!Array.isArray(payload.imageUrls) || payload.imageUrls.length === 0) {
      return jsonResponse(400, {
        error: "No imageUrls received",
        debug_version: debugVersion,
      });
    }

    // Accept imageUrls (array) and maintain legacy imageUrl support.
    const rawUrls: string[] = Array.isArray(payload.imageUrls)
      ? payload.imageUrls
          .filter((u: unknown) => typeof u === "string" && u.trim())
          .map((u: unknown) => String(u).trim())
      : typeof payload.imageUrl === "string" && payload.imageUrl.trim()
      ? [payload.imageUrl.trim()]
      : [];

    const rawRoles = Array.isArray(payload.imageRoles) ? payload.imageRoles : [];

    const imageRoles = rawUrls.map((_, index) => normalizeRole(rawRoles[index], index));
    const barcode = typeof payload.barcode === "string" && payload.barcode.trim()
      ? payload.barcode.trim()
      : null;

    console.log("IDENTIFY_PRODUCT INPUT DEBUG:", {
      imageUrlsLength: rawUrls.length,
      imageRoles,
      firstImageUrl: rawUrls[0] || null,
      hasBarcode: Boolean(barcode),
      barcode,
    });

    if (rawUrls.length === 0) {
      return jsonResponse(400, {
        error: "No imageUrls received",
        debug_version: debugVersion,
      });
    }

    return new Response(
      JSON.stringify({
        debug_version: "identify-product-hard-test-v1",
        success: true,
        product_name: "FUNCTION IS LIVE",
        brand: "Debug",
        category: "Debug",
        size_value: "1",
        size_unit: "test",
        quantity: "1",
        price: 2.29,
        price_unit: "each",
        confidence: 1,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      }
    );

    const userText = barcode
      ? `Analyze ${rawUrls.length} product image(s). Barcode context: ${barcode}.`
      : `Analyze ${rawUrls.length} product image(s). No barcode provided.`;

    const contentParts: Array<{ type: string; text?: string; image_url?: string }> = [
      { type: "input_text", text: userText },
    ];

    rawUrls.forEach((url, i) => {
      const role = imageRoles[i] || defaultRoleByIndex(i);
      const roleLabel = ROLE_LABELS[role] || role.replace(/_/g, " ");
      contentParts.push({
        type: "input_text",
        text: `Image ${i + 1} role: ${roleLabel}`,
      });
      contentParts.push({ type: "input_image", image_url: url });
    });

    const modelName = Deno.env.get("OPENAI_VISION_MODEL") || "gpt-4.1";
    console.log("IDENTIFY_PRODUCT MODEL:", modelName);

    let data: Record<string, unknown> = {};
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openAiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelName,
          instructions: SYSTEM_PROMPT,
          text: {
            format: {
              type: "json_schema",
              name: "identify_product_result",
              schema: JSON_SCHEMA,
              strict: true,
            },
          },
          input: [
            {
              role: "user",
              content: contentParts,
            },
          ],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI request failed: ${response.status} ${errText}`);
      }

      data = (await response.json()) as Record<string, unknown>;
    } catch (openAiError) {
      return jsonResponse(500, {
        error: "OpenAI call failed",
        details: (openAiError as Error)?.message || "Unknown OpenAI error",
        debug_version: debugVersion,
      });
    }

    console.log("IDENTIFY_PRODUCT RAW OPENAI RESPONSE:", JSON.stringify(data));

    const rawText = extractModelText(data);
    const cleanText = extractJsonObjectText(rawText);

    let normalizedResult: IdentifyProductResult = { ...DEFAULT_RESULT };

    try {
      const parsed = JSON.parse(cleanText) as Record<string, unknown>;
      normalizedResult = normalizeParsedResult(parsed);
    } catch {
      normalizedResult = {
        ...DEFAULT_RESULT,
        raw_text: cleanText.slice(0, 120),
        confidence: 0.2,
      };
    }

    const parsedResult = {
      product_name: normalizedResult.product_name || "",
      brand: normalizedResult.brand || "",
      category: normalizedResult.category || "",
      size_value: normalizedResult.size_value || "",
      size_unit: normalizedResult.size_unit || "",
      quantity: normalizedResult.quantity || "1",
      price: normalizedResult.price ?? null,
      price_unit: normalizedResult.price_unit || "unknown",
      confidence: normalizedResult.confidence || 0,
      size_confidence: normalizedResult.size_confidence || 0,
      quantity_confidence: normalizedResult.quantity_confidence || 0,
      price_confidence: normalizedResult.price_confidence || 0,
      raw_text: normalizedResult.raw_text || "",
      debug_version: debugVersion,
    };

    console.log("IDENTIFY_PRODUCT FINAL JSON:", JSON.stringify(parsedResult));

    return jsonResponse(200, parsedResult);
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Unhandled identify-product error",
        details: (err as Error)?.message || "Unknown error",
        debug_version: "identify-product-debug-v3",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
