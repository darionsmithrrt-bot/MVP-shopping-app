import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS_HEADERS = {
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
  secondary_size_value: string;
  secondary_size_unit: string;
  price: number | null;
  price_unit: "unknown" | "each" | "price_per_lb" | "price_per_oz" | "price_per_pack" | "price_per_dozen";
  price_source: "none" | "photo_sign" | "user_corrected";
  price_confidence: number;
  confidence: number;
  needs_user_confirmation: true;
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
  secondary_size_value: "",
  secondary_size_unit: "",
  price: null,
  price_unit: "unknown",
  price_source: "none",
  price_confidence: 0,
  confidence: 0,
  needs_user_confirmation: true,
};

const VALID_PRICE_UNITS = new Set([
  "unknown",
  "each",
  "price_per_lb",
  "price_per_oz",
  "price_per_pack",
  "price_per_dozen",
]);

const VALID_PRICE_SOURCES = new Set(["none", "photo_sign", "user_corrected"]);

const ROLE_LABELS: Record<string, string> = {
  product_label: "product front label",
  size_label: "size / net weight label",
  price_sign: "shelf price sign",
};

const VALID_IMAGE_ROLES = new Set(["product_label", "size_label", "price_sign"]);

const SYSTEM_PROMPT = `You are a grocery product data extraction assistant. You receive one or more product photos with role hints and must return a single strict JSON object. No markdown, no prose, no code fences — raw JSON only.

═══════════════════════════════════════════════
MULTI-IMAGE LOGIC
═══════════════════════════════════════════════
- Use ALL provided images together to build one unified result.
- Image roles MUST be used this way:
  • product_label → prioritize product_name, brand, category, and front package identity
  • size_label    → prioritize NET WT, package size, count, quantity
  • price_sign    → prioritize shelf price and price unit
- Cross-check across photos and merge into ONE product result:
  • If product identity appears in product_label and size appears in size_label, combine both into one final object.
  • If a price sign appears in price_sign, attach price ONLY when it clearly matches the same product.
  • If multiple prices are visible, choose the price most clearly associated with the matching product label/sign.
  • If product-to-price match is ambiguous, leave price null and confidence low.
- If a role-specific image is available for a field, prefer it over other images for that field.
- Do not guess missing fields.

═══════════════════════════════════════════════
SIZE EXTRACTION — STRICT PRIORITY ORDER
═══════════════════════════════════════════════
1. NET WT / NET WEIGHT printed on the package (e.g. "NET WT 15.5 OZ")   ← highest priority
2. Size text on the product front label (e.g. "32 FL OZ")
3. Any other clearly printed package-size statement

NEVER use:
  - Serving size from a nutrition facts panel as the package size
  - Measurements from a price tag (e.g. "$3.99 / lb") as the package size
  - Guessed or inferred sizes

If dual units are present (e.g. "15.5 OZ (439g)"):
  size_value = "15.5"  |  size_unit = "oz"
  secondary_size_value = "439"  |  secondary_size_unit = "g"

If size is genuinely not visible, leave size_value and size_unit blank and set size_confidence = 0.

═══════════════════════════════════════════════
QUANTITY EXTRACTION — STRICT RULES
═══════════════════════════════════════════════
- quantity represents the NUMBER OF INDIVIDUAL ITEMS in the package, as a descriptive string.
- Default for a single can, bottle, bag, box, or carton: quantity = "1"
- Eggs: detect and record "dozen", "18 count", "24 count", etc. as printed.
- Multipacks: detect and record "6 pack", "12 count", "variety 4 pack", etc. as printed.
- Do NOT use weight or volume as quantity (e.g. "32 oz" is NOT a quantity — it is a size).
- If quantity is not clearly visible and item appears to be a single package, use quantity = "1" with quantity_confidence = 0.5.

═══════════════════════════════════════════════
PRICE EXTRACTION — STRICT RULES
═══════════════════════════════════════════════
- ONLY extract price if a shelf price sign is clearly visible in an image with role "shelf price sign".
- NEVER guess or infer price from any other source.
- NEVER use a price-per-weight shown on a size label as the product price.
- If price is not clearly visible: price = null, price_unit = "unknown", price_source = "none", price_confidence = 0.
- Valid price_unit values: "unknown" | "each" | "price_per_lb" | "price_per_oz" | "price_per_pack" | "price_per_dozen"
- price_source must be "photo_sign" when a price is extracted, otherwise "none".

═══════════════════════════════════════════════
OUTPUT FORMAT — MANDATORY EXACT SHAPE
═══════════════════════════════════════════════
Return this exact JSON object. Do not add, remove, or rename fields:
{
  "product_name": "",
  "brand": "",
  "category": "",
  "size_value": "",
  "size_unit": "",
  "size_confidence": 0,
  "quantity": "1",
  "quantity_confidence": 0,
  "secondary_size_value": "",
  "secondary_size_unit": "",
  "price": null,
  "price_unit": "unknown",
  "price_source": "none",
  "price_confidence": 0,
  "confidence": 0,
  "needs_user_confirmation": true
}

ADDITIONAL RULES:
- needs_user_confirmation is ALWAYS true.
- All confidence fields are numbers in 0..1 range (e.g. 0.92, not 92).
- Use lowercase canonical units: oz, lb, g, kg, ml, liter, fl oz, gallon, count, pack, dozen.
- product_name / brand / category: leave blank ("") when not clearly visible — do NOT hallucinate.
- Barcode (if provided) is context only — do not copy it to any output field.`;

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
    secondary_size_value: { type: "string" },
    secondary_size_unit: { type: "string" },
    price: { type: ["number", "null"] },
    price_unit: {
      type: "string",
      enum: ["unknown", "each", "price_per_lb", "price_per_oz", "price_per_pack", "price_per_dozen"],
    },
    price_source: {
      type: "string",
      enum: ["none", "photo_sign", "user_corrected"],
    },
    price_confidence: { type: "number" },
    confidence: { type: "number" },
    needs_user_confirmation: { type: "boolean" },
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
    "secondary_size_value",
    "secondary_size_unit",
    "price",
    "price_unit",
    "price_source",
    "price_confidence",
    "confidence",
    "needs_user_confirmation",
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

const normalizeParsedResult = (parsed: Record<string, unknown>): IdentifyProductResult => {
  const price = normalizePrice(parsed.price);
  const priceUnitRaw = typeof parsed.price_unit === "string" ? parsed.price_unit : "unknown";
  const priceSourceRaw = typeof parsed.price_source === "string" ? parsed.price_source : "none";

  const price_unit = VALID_PRICE_UNITS.has(priceUnitRaw) ? priceUnitRaw : "unknown";
  const price_source =
    price == null
      ? "none"
      : VALID_PRICE_SOURCES.has(priceSourceRaw)
      ? priceSourceRaw
      : "photo_sign";

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
    secondary_size_value:
      typeof parsed.secondary_size_value === "string" ? parsed.secondary_size_value.trim() : "",
    secondary_size_unit:
      typeof parsed.secondary_size_unit === "string"
        ? parsed.secondary_size_unit.trim().toLowerCase()
        : "",
    price,
    price_unit: price == null ? "unknown" : (price_unit as IdentifyProductResult["price_unit"]),
    price_source: price == null ? "none" : (price_source as IdentifyProductResult["price_source"]),
    price_confidence: price == null ? 0 : normalizeConfidence(parsed.price_confidence),
    confidence: normalizeConfidence(parsed.confidence),
    needs_user_confirmation: true,
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
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

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

    if (rawUrls.length === 0) {
      return new Response(
        JSON.stringify({ error: "No image URLs provided" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

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

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
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
      return new Response(
        JSON.stringify({ error: `OpenAI request failed: ${response.status}`, details: errText }),
        {
          status: 502,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        }
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    const rawText = extractModelText(data);
    const cleanText = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    let normalizedResult: IdentifyProductResult = { ...DEFAULT_RESULT };

    try {
      const parsed = JSON.parse(cleanText) as Record<string, unknown>;
      normalizedResult = normalizeParsedResult(parsed);
    } catch {
      normalizedResult = {
        ...DEFAULT_RESULT,
        product_name: cleanText.slice(0, 120),
        confidence: 0.2,
      };
    }

    return new Response(
      JSON.stringify(normalizedResult),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }
});
