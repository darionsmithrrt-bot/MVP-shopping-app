export const extractAiProductData = (aiResponse) => {
  try {
    if (!aiResponse) return {};

    const raw = aiResponse?.data || aiResponse;

    // Case 1: already clean (edge function already parsed and returned flat fields)
    if (raw.product_name) {
      return {
        product_name: raw.product_name,
        brand: raw.brand || "",
        category: raw.category || "",
        size_value: raw.size_value || "",
        size_unit: raw.size_unit || "",
        quantity: raw.quantity || "",
        secondary_size_value: raw.secondary_size_value || "",
        secondary_size_unit: raw.secondary_size_unit || "",
        price: raw.price ?? null,
        price_unit: raw.price_unit || "unknown",
        price_source: raw.price_source || "none",
        confidence: raw.confidence ?? 0,
        needs_user_confirmation: raw.needs_user_confirmation !== false,
      };
    }

    // Case 2: OpenAI-style response text (raw model output not yet parsed)
    const text =
      raw?.output?.[0]?.content?.[0]?.text ||
      raw?.response ||
      raw?.text ||
      "";

    if (typeof text === "string") {
      const cleanText = text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();
      try {
        const parsed = JSON.parse(cleanText);
        return {
          product_name: parsed.product_name || parsed.name || "",
          brand: parsed.brand || "",
          category: parsed.category || "",
          size_value: parsed.size_value || "",
          size_unit: parsed.size_unit || "",
          quantity: parsed.quantity || "",
          secondary_size_value: parsed.secondary_size_value || "",
          secondary_size_unit: parsed.secondary_size_unit || "",
          price: parsed.price ?? null,
          price_unit: parsed.price_unit || "unknown",
          price_source: parsed.price_source || "none",
          confidence: parsed.confidence ?? 0,
          needs_user_confirmation: parsed.needs_user_confirmation !== false,
        };
      } catch {
        return {
          product_name: cleanText.slice(0, 120),
          brand: "",
          category: "",
          size_value: "",
          size_unit: "",
          quantity: "",
          secondary_size_value: "",
          secondary_size_unit: "",
          price: null,
          price_unit: "unknown",
          price_source: "none",
          confidence: 20,
          needs_user_confirmation: true,
        };
      }
    }

    return {};
  } catch (err) {
    console.error("AI PARSE ERROR:", err);
    return {};
  }
};

export const blobToFile = (blob, filename) => {
  return new File([blob], filename, {
    type: blob.type || "image/jpeg",
  });
};