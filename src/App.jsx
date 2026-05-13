import React, { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { supabase, supabaseAnonKey, supabaseUrl } from "./supabaseClient";
import {
  PRODUCT_IMAGE_BUCKET,
  LOCATION_SUBMISSION_POINTS,
  CORRECTION_SUBMISSION_POINTS,
  LOCATION_CONFIRMATION_POINTS,
  AREA_OPTIONS,
  SECTION_OPTIONS,
  SHELF_OPTIONS,
} from "./constants";
import { formatTimestamp } from "./utils/formatUtils";
import { isIgnorablePlayInterruption } from "./utils/errorUtils";
import {
  applyLocationFilters,
  calculateConfidenceScore,
  normalizeOptionalText,
} from "./utils/locationUtils";
import { tryInsertWithPayloads } from "./utils/dbUtils";
import { blobToFile, extractAiProductData } from "./utils/productUtils";
import { useRewards } from "./hooks/useRewards";
import ScanditScannerTest from "./ScanditScannerTest";
import mvpLogo from "./assets/mvp-logo.png";

const AUTH_REDIRECT_URL =
  window.location.origin;

const PHOTO_ROLE_SEQUENCE = [
  { key: "product_label", label: "Product front label" },
  { key: "size_label", label: "Size / net weight label" },
  { key: "price_sign", label: "Shelf price sign" },
];

const VALID_IMAGE_ROLES = new Set(["product_label", "size_label", "price_sign"]);
const PRODUCT_KEYWORD_MAP = {
  eggs: [
    { product_name: "Large White Eggs", brand: "Eggland's Best", category: "eggs" },
    { product_name: "Cage Free Large Brown Eggs", brand: "Vital Farms", category: "eggs" },
    { product_name: "Grade A Large Eggs", brand: "Great Value", category: "eggs" },
    { product_name: "Organic Brown Eggs", brand: "365", category: "eggs" },
    { product_name: "18 Count Large Eggs", brand: "Kirkland Signature", category: "eggs" },
    { product_name: "Large Grade A Eggs", brand: "Lucerne", category: "eggs" },
  ],
  milk: [
    { product_name: "Whole Milk", brand: "Horizon Organic", category: "milk" },
    { product_name: "2% Reduced Fat Milk", brand: "Fairlife", category: "milk" },
    { product_name: "Almond Milk", brand: "Silk", category: "milk" },
    { product_name: "Oat Milk", brand: "Oatly", category: "milk" },
  ],
  bread: [
    { product_name: "White Bread", brand: "Wonder", category: "bread" },
    { product_name: "Whole Wheat Bread", brand: "Dave's Killer Bread", category: "bread" },
    { product_name: "Sourdough Bread", brand: "Boudin", category: "bread" },
  ],
  dove: [
    { product_name: "Dove Body Wash", brand: "Dove", category: "personal care" },
    { product_name: "Dove Sensitive Skin Body Wash", brand: "Dove", category: "personal care" },
    { product_name: "Dove Bar Soap", brand: "Dove", category: "personal care" },
    { product_name: "Dove Deodorant", brand: "Dove", category: "personal care" },
  ],
};
const LOCAL_ITEM_REQUEST_PATTERNS = {
  dove: [
    { product_name: "Dove Body Wash", brand: "Dove" },
    { product_name: "Dove Sensitive Skin Body Wash", brand: "Dove" },
    { product_name: "Dove Bar Soap", brand: "Dove" },
    { product_name: "Dove Deodorant", brand: "Dove" },
  ],
  milk: [
    { product_name: "Whole Milk", brand: "" },
    { product_name: "2% Milk", brand: "" },
    { product_name: "Almond Milk", brand: "" },
    { product_name: "Oat Milk", brand: "" },
  ],
  eggs: [
    { product_name: "Large Eggs", brand: "" },
    { product_name: "Brown Eggs", brand: "" },
    { product_name: "Organic Eggs", brand: "" },
    { product_name: "18 Count Eggs", brand: "" },
  ],
};

const isUuidString = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );

const toSafeUserId = (candidateId) =>
  isUuidString(candidateId) ? String(candidateId) : crypto.randomUUID();

const toTitleCase = (value) =>
  String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");

const normalizeSuggestionRow = (row) => ({
  product_name: String(row?.product_name || "").trim(),
  brand: String(row?.brand || "").trim(),
});

const dedupeSuggestions = (suggestions) => {
  const seen = new Set();
  const unique = [];

  for (const suggestion of suggestions || []) {
    const normalized = normalizeSuggestionRow(suggestion);
    if (!normalized.product_name) continue;
    const key = `${normalized.product_name.toLowerCase()}|${normalized.brand.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }

  return unique;
};

const getLocalItemRequestSuggestions = (term) => {
  const query = String(term || "").trim().toLowerCase();
  if (!query) return [];

  const keywordMatches = [];

  for (const [key, suggestions] of Object.entries(PRODUCT_KEYWORD_MAP)) {
    if (query.includes(key)) {
      keywordMatches.push(...suggestions.map((s) => ({
        product_name: s.product_name,
        brand: s.brand || "",
      })));
    }
  }

  for (const [key, suggestions] of Object.entries(LOCAL_ITEM_REQUEST_PATTERNS)) {
    if (query.includes(key)) {
      keywordMatches.push(...suggestions);
    }
  }

  if (keywordMatches.length > 0) {
    return dedupeSuggestions(keywordMatches).slice(0, 10);
  }

  const titled = toTitleCase(query);
  if (!titled) return [];
  return dedupeSuggestions([
    { product_name: titled, brand: "" },
    { product_name: `${titled} Family Size`, brand: "" },
    { product_name: `${titled} Organic`, brand: "" },
  ]).slice(0, 10);
};

const getRoleByPhotoIndex = (index) => {
  const boundedIndex = Math.max(0, Math.min(index, PHOTO_ROLE_SEQUENCE.length - 1));
  return PHOTO_ROLE_SEQUENCE[boundedIndex].key;
};

const normalizeImageRole = (role, index) => {
  const candidate = String(role || "").trim();
  if (VALID_IMAGE_ROLES.has(candidate)) return candidate;
  return getRoleByPhotoIndex(index);
};

const formatStoreAddress = (store) => {
  return [
    store?.address,
    store?.city,
    store?.state,
    store?.zip || store?.postal_code,
  ]
    .filter(Boolean)
    .join(", ");
};

const getStoreAddressSubtitle = (store) => {
  if (store?.address) {
    return formatStoreAddress(store);
  }

  const cityState = [store?.city, store?.state].filter(Boolean).join(", ");
  return cityState || "Address unavailable";
};

const identifyProductFromPhoto = async (imageUrls, barcode, imageRoles = [], visionContext = null, visionByRole = {}) => {
  const urls = Array.isArray(imageUrls) ? imageUrls : [imageUrls].filter(Boolean);
  const normalizedRoles = urls.map((_, index) => normalizeImageRole(imageRoles[index], index));
  
  // Extract role-specific vision data
  const productLabelVision = visionByRole?.product_label || {};
  const sizeLabelVision = visionByRole?.size_label || {};
  const priceSignVision = visionByRole?.price_sign || {};
  
  const payload = {
    imageUrls: urls,
    imageRoles: normalizedRoles,
    barcode,
    // Merged vision context (backward compatible)
    visionText: visionContext?.text || "",
    visionLogos: visionContext?.logos || [],
    visionLabels: visionContext?.labels || [],
    visionObjects: visionContext?.objects || [],
    // New: visionByRole for role-specific extraction
    visionByRole: visionByRole || {},
    productLabelText: productLabelVision?.text || "",
    productLabelLabels: productLabelVision?.labels || [],
    productLabelLogos: productLabelVision?.logos || [],
    sizeLabelText: sizeLabelVision?.text || "",
    sizeLabelLabels: sizeLabelVision?.labels || [],
    sizeLabelObjects: sizeLabelVision?.objects || [],
    priceSignText: priceSignVision?.text || "",
    priceSignLabels: priceSignVision?.labels || [],
    priceSignObjects: priceSignVision?.objects || [],
  };
  console.log("INVOKING identify-product WITH PAYLOAD:", payload);
  const { data, error } = await supabase.functions.invoke("identify-product", {
    body: payload,
  });
  console.log("IDENTIFY PRODUCT INVOKE DATA:", data);
  console.log("IDENTIFY PRODUCT INVOKE ERROR:", error);
  return { data, error };
};

const EGG_QUANTITY_OPTIONS = [
  { label: "6 count", value: "6 count" },
  { label: "dozen", value: "dozen" },
  { label: "18 count", value: "18 count" },
  { label: "2 dozen", value: "2 dozen" },
  { label: "30 count", value: "30 count" },
];

const LOCATION_QUICK_AREAS = [
  "Produce Area",
  "Meat/Poultry Area",
  "Dairy Area",
  "Bakery Area",
  "Deli Area",
  "Frozen Area",
  "General Aisle",
];

const isEggText = (value) => /\beggs?\b/.test(String(value || "").toLowerCase());

const isEggItem = (product, correctionForm) => {
  const haystack = [
    product?.name,
    correctionForm?.product_name,
    product?.category,
    correctionForm?.category,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return isEggText(haystack);
};

const normalizePriceUnitFromAi = (value) => {
  const unit = String(value || "").trim().toLowerCase();

  if (!unit) return "unknown";
  if (["/lb", "lb", "per_lb", "per lb", "price_per_lb", "price/lb"].includes(unit)) {
    return "price_per_lb";
  }
  if (["/oz", "oz", "per_oz", "per oz", "price_per_oz", "price/oz"].includes(unit)) {
    return "price_per_oz";
  }
  if (["/pack", "pack", "per_pack", "per pack", "price_per_pack", "price/pack"].includes(unit)) {
    return "price_per_pack";
  }
  if (["dozen", "per_dozen", "price_per_dozen"].includes(unit)) {
    return "price_per_dozen";
  }
  if (["each", "ea", "per_each", "price_each", "price_per_each"].includes(unit)) {
    return "each";
  }

  return "unknown";
};

const mapDetectedUnitToPriceType = (detectedUnit) => {
  if (detectedUnit === "price_per_lb") return "per_lb";
  if (detectedUnit === "price_per_oz") return "per_oz";
  return "each";
};

const formatDetectedUnitLabel = (detectedUnit) => {
  if (detectedUnit === "price_per_lb") return "/lb";
  if (detectedUnit === "price_per_oz") return "/oz";
  if (detectedUnit === "price_per_pack") return "/pack";
  if (detectedUnit === "price_per_dozen") return "/dozen";
  if (detectedUnit === "each") return " each";
  return "";
};

const getPriceSourceMeta = (priceSource) => {
  if (priceSource === "photo_sign") {
    return {
      icon: "Photo",
      label: "Price from shelf photo",
      color: "#166534",
      background: "#dcfce7",
      border: "#86efac",
    };
  }

  if (priceSource === "user_corrected") {
    return {
      icon: "Edited",
      label: "User edited price",
      color: "#92400e",
      background: "#fef3c7",
      border: "#fcd34d",
    };
  }

  return {
    icon: "",
    label: "Manual entry",
    color: "#334155",
    background: "#f8fafc",
    border: "#cbd5e1",
  };
};

const normalizeDetectedPriceToNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  const text = String(value || "").trim();
  if (!text) return null;

  const matched = text.match(/\d+(?:\.\d{1,2})?/);
  if (!matched) return null;

  const parsed = Number(matched[0]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

// Returns a clean catalog/placeholder image URL for cart display.
// Raw user-captured photo upload URLs are intentionally excluded so the
// Smart Cart never shows a user's personal photo.
// Priority: (1) existing clean catalog image_url, (2) category placeholder, (3) default MVP placeholder.
const MVP_PLACEHOLDER_IMAGE = "https://placehold.co/80x80/e2e8f0/64748b?text=Item";

const CATEGORY_PLACEHOLDER_MAP = {
  produce:    "https://placehold.co/80x80/dcfce7/166534?text=🥦",
  meat:       "https://placehold.co/80x80/fee2e2/991b1b?text=🥩",
  poultry:    "https://placehold.co/80x80/fee2e2/991b1b?text=🍗",
  dairy:      "https://placehold.co/80x80/dbeafe/1d4ed8?text=🥛",
  bakery:     "https://placehold.co/80x80/fef9c3/854d0e?text=🍞",
  deli:       "https://placehold.co/80x80/fce7f3/9d174d?text=🧀",
  frozen:     "https://placehold.co/80x80/e0f2fe/0369a1?text=🧊",
  beverage:   "https://placehold.co/80x80/e0f2fe/0369a1?text=🥤",
  snack:      "https://placehold.co/80x80/fef3c7/92400e?text=🍪",
  cereal:     "https://placehold.co/80x80/fef3c7/92400e?text=🥣",
  canned:     "https://placehold.co/80x80/f1f5f9/475569?text=🥫",
  household:  "https://placehold.co/80x80/f1f5f9/475569?text=🧹",
  personal:   "https://placehold.co/80x80/fdf4ff/7e22ce?text=🧴",
};

const isRawUploadUrl = (url) => {
  if (!url) return false;
  const s = String(url);
  // Supabase storage bucket paths used for AI evidence uploads
  return (
    s.includes("/product-images/") ||
    s.includes("/storage/v1/object/") ||
    s.includes("supabase.co/storage")
  );
};

const getCleanCartImageForProduct = ({
  existingImageUrl,
  verifiedImageUrl,
  category,
  productName,
  brand,
} = {}) => {
  // Prefer verified catalog image when available and safe
  if (verifiedImageUrl && !isRawUploadUrl(verifiedImageUrl)) {
    return verifiedImageUrl;
  }

  // If there's already a clean catalog image (not a raw user upload), use it
  if (existingImageUrl && !isRawUploadUrl(existingImageUrl)) {
    return existingImageUrl;
  }

  // Use a category-matched placeholder when available
  if (category) {
    const cat = String(category).toLowerCase();
    for (const [key, url] of Object.entries(CATEGORY_PLACEHOLDER_MAP)) {
      if (cat.includes(key)) return url;
    }
  }

  // Last resort: show the raw upload photo rather than a blank placeholder
  if (verifiedImageUrl) return verifiedImageUrl;
  if (existingImageUrl) return existingImageUrl;

  return MVP_PLACEHOLDER_IMAGE;
};

const resolveProductImage = (product = {}) => {
  return (
    product?.cart_image_url ||
    product?.image ||
    product?.verified_image_url ||
    product?.image_url ||
    product?.raw_photo_url ||
    MVP_PLACEHOLDER_IMAGE
  );
};

const logButtonClick = (label, meta = {}) => {
  console.log("BUTTON CLICK:", label, meta);
};

const extractWeightedLabelPriceFromText = (rawText) => {
  const text = String(rawText || "");

  // ── Unit-price patterns (ordered: most specific first) ────────────────────
  // "PRICE PER LB. $5.29", "PRICE PER LB $5.29", "PRICE/LB $5.29"
  // "PRICE PER POUND $5.29", "PER LB $5.29"
  // "$5.29 / LB", "$5.29 PER LB"
  // "UNIT PRICE $5.29"  (existing behaviour preserved)
  const perLbUnitPriceMatch =
    text.match(/price\s+per\s+lb\.?s?\.?\s*\$?\s*(\d+(?:\.\d{1,2})?)/i) ||
    text.match(/price\s*\/\s*lb\.?s?\.?\s*\$?\s*(\d+(?:\.\d{1,2})?)/i) ||
    text.match(/price\s+per\s+pound\.?\s*\$?\s*(\d+(?:\.\d{1,2})?)/i) ||
    text.match(/\bper\s+lb\.?s?\.?\s*\$?\s*(\d+(?:\.\d{1,2})?)/i) ||
    text.match(/\$\s*(\d+(?:\.\d{1,2})?)\s*\/\s*lb\.?s?/i) ||
    text.match(/\$\s*(\d+(?:\.\d{1,2})?)\s+per\s+lb\.?s?/i);

  const unitPriceMatch =
    perLbUnitPriceMatch ||
    text.match(/unit\s*price[^$0-9]*\$?\s*(\d+(?:\.\d{1,2})?)/i) ||
    text.match(/\bunit\s*price\b[\s\S]{0,20}?\$?\s*(\d+(?:\.\d{1,2})?)/i);

  const isPerLbPattern = Boolean(perLbUnitPriceMatch);

  // ── Total-price patterns ──────────────────────────────────────────────────
  // "TOTAL PRICE $12.22", "TOTAL $12.22", "PRICE $12.22" (fallback)
  const totalPriceMatch =
    text.match(/total\s+price\s*\$?\s*(\d+(?:\.\d{1,2})?)/i) ||
    text.match(/\btotal\s*\$?\s*(\d+(?:\.\d{1,2})?)/i) ||
    text.match(/\bprice\s*\$?\s*(\d+(?:\.\d{1,2})?)/i);

  // ── Weight patterns ───────────────────────────────────────────────────────
  // "NET WT. LBS. 2.31", "NET WT LBS 2.31", "NET WT. LB 2.31"
  // "NET WEIGHT 2.31 LB", "WT LBS 2.31", "2.31 LBS"
  const netWeightLbMatch =
    text.match(/net\s*wt\.?\s*lb\.?s?\.?\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/net\s*weight\s+(\d+(?:\.\d+)?)\s*lb/i) ||
    text.match(/\bwt\.?\s*lb\.?s?\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/(\d+(?:\.\d+)?)\s*lb\.?s?\b/i);

  if (!unitPriceMatch) return null;

  const unitAmount = Number(unitPriceMatch[1]);
  const weightLb = netWeightLbMatch ? Number(netWeightLbMatch[1]) : null;
  const totalAmount = totalPriceMatch ? Number(totalPriceMatch[1]) : null;

  // Sanity check: unit × weight ≈ total (within $0.10)
  const inferredTotalMatches =
    unitAmount && weightLb && totalAmount
      ? Math.abs(unitAmount * weightLb - totalAmount) <= 0.10
      : false;

  const result = {
    amount: unitAmount,
    unit: (isPerLbPattern || weightLb) ? "price_per_lb" : "each",
    source: "photo_sign",
    price_label_source: isPerLbPattern ? "price_per_lb_label" : "unit_price_label",
    matched_total_price: totalAmount,
    matched_weight_lb: weightLb,
    inferred_total_matches: inferredTotalMatches,
  };

  console.info("WEIGHTED PRICE PARSED", {
    amount: result.amount,
    unit: result.unit,
    matched_weight_lb: result.matched_weight_lb,
    matched_total_price: result.matched_total_price,
    inferred_total_matches: result.inferred_total_matches,
  });

  return result;
};

const extractDetectedPriceFromAi = (aiPayload, aiResponse) => {
  const responseData = aiResponse?.data || {};

  // Collect raw text from all available sources for weighted label detection
  const rawTextSources = [
    aiPayload?.raw_text,
    aiPayload?.detected_text,
    aiPayload?.ocr_text,
    responseData?.raw_text,
    responseData?.detected_text,
    responseData?.result?.raw_text,
  ].filter(Boolean);
  const combinedRawText = rawTextSources.join(" ");

  // Prefer UNIT PRICE over generic price fields for weighted items
  if (combinedRawText) {
    const weightedLabelPrice = extractWeightedLabelPriceFromText(combinedRawText);
    if (weightedLabelPrice) {
      return {
        amount: weightedLabelPrice.amount,
        cents: String(Math.round(weightedLabelPrice.amount * 100)),
        unit: weightedLabelPrice.unit,
        source: "photo_sign",
        price_label_source: weightedLabelPrice.price_label_source || "unit_price",
      };
    }
  }

  const candidatePrice =
    aiPayload?.price ??
    aiPayload?.detected_price ??
    aiPayload?.shelf_price ??
    responseData?.price ??
    responseData?.detected_price ??
    responseData?.shelf_price ??
    responseData?.result?.price;

  const detectedPrice = normalizeDetectedPriceToNumber(candidatePrice);
  if (!detectedPrice) return null;

  // Guard: if the generic price matches total_price AND raw text has weighted signals,
  // reject it ? the edge function returned total price instead of unit price.
  const knownTotalPrice = normalizeDetectedPriceToNumber(
    aiPayload?.total_price ?? responseData?.total_price ?? responseData?.result?.total_price
  );
  const hasWeightedSignal = /net\s*wt|\blb\b|\/lb/i.test(combinedRawText);
  if (
    knownTotalPrice &&
    detectedPrice === knownTotalPrice &&
    hasWeightedSignal
  ) {
    return null;
  }

  const candidateUnit =
    aiPayload?.price_unit ??
    aiPayload?.detected_price_unit ??
    aiPayload?.unit ??
    responseData?.price_unit ??
    responseData?.detected_price_unit ??
    responseData?.unit;

  const normalizedUnit = normalizePriceUnitFromAi(candidateUnit);

  return {
    amount: detectedPrice,
    cents: String(Math.round(detectedPrice * 100)),
    unit: normalizedUnit,
    source: "photo_sign",
  };
};

const getTrustWeight = (trustScore = 0) => {
  const score = Number(trustScore || 0);

  if (score >= 100) return 1.5;
  if (score >= 50) return 1.25;
  if (score >= 20) return 1.1;
  return 1;
};

const calculateCrowdConfidence = ({
  confirmationCount,
  priceCount,
  source,
  hasPhoto,
  priceSource,
  userEdited,
  aiConfidence,
  userTrustScore,
}) => {
  const normalizedConfirmations = Math.max(0, Number(confirmationCount || 0));
  const normalizedPriceCount = Math.max(0, Number(priceCount || 0));
  const normalizedAiConfidence = Number(aiConfidence || 0);
  const trustWeight = getTrustWeight(userTrustScore);

  let score = 0;
  score += Math.min(65, normalizedConfirmations * 20 * trustWeight);

  if (hasPhoto) score += 10;
  if (String(priceSource || "").trim().toLowerCase() === "photo_sign") score += 10;
  if (normalizedAiConfidence >= 0.85) score += 10;
  if (userEdited) score -= 10;

  // Minor stabilization bonus for repeated price observations without overpowering quality signals.
  if (normalizedPriceCount >= 3) score += 5;

  // Slightly lower confidence for fully manual records lacking photo support.
  if (!hasPhoto && String(source || "").trim().toLowerCase().includes("manual")) {
    score -= 5;
  }

  const bounded = Math.min(95, Math.max(0, score));
  return Math.round(bounded);
};

const getConfidenceBadge = (score) => {
  const numericScore = Number(score || 0);

  if (!numericScore || numericScore <= 0) {
    return {
      label: "Needs confirmation",
      color: "#475569",
      background: "#f1f5f9",
      border: "#cbd5e1",
    };
  }

  if (numericScore >= 90) {
    return {
      label: "High confidence",
      color: "#166534",
      background: "#dcfce7",
      border: "#86efac",
    };
  }

  if (numericScore >= 70) {
    return {
      label: "Moderate confidence",
      color: "#92400e",
      background: "#fef3c7",
      border: "#fcd34d",
    };
  }

  return {
    label: "Low confidence",
    color: "#991b1b",
    background: "#fee2e2",
    border: "#fecaca",
  };
};

const normalizeSizeUnit = (unitRaw) => {
  const unit = String(unitRaw || "").trim().toLowerCase().replace(/\./g, "");
  if (!unit) return "";

  if (["fl oz", "floz", "fluid oz", "fluid ounce", "fluid ounces"].includes(unit)) {
    return "fl oz";
  }
  if (["oz", "ounce", "ounces"].includes(unit)) return "oz";
  if (["lb", "lbs", "pound", "pounds"].includes(unit)) return "lb";
  if (["g", "gram", "grams"].includes(unit)) return "g";
  if (["kg", "kilogram", "kilograms"].includes(unit)) return "kg";
  if (["count", "ct"].includes(unit)) return "count";
  if (["pack", "pk"].includes(unit)) return "pack";
  if (["l", "liter", "liters", "litre", "litres"].includes(unit)) return "liter";
  if (["ml", "milliliter", "milliliters", "millilitre", "millilitres"].includes(unit)) return "ml";
  if (["qt", "quart", "quarts"].includes(unit)) return "qt";
  if (["gal", "gallon", "gallons"].includes(unit)) return "gal";
  if (["pt", "pint", "pints"].includes(unit)) return "pt";
  return unit;
};

const collectTextCandidates = (value) => {
  if (value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item == null) return "";
        if (typeof item === "object") {
          try {
            return JSON.stringify(item);
          } catch {
            return "";
          }
        }
        return String(item);
      })
      .filter(Boolean);
  }
  if (typeof value === "object") {
    try {
      return [JSON.stringify(value)];
    } catch {
      return [];
    }
  }
  return [String(value)];
};

const cleanVisionText = (rawText) => {
  const blockedLine = [
    /\bkills?\b/i,
    /\bgerms?\b/i,
    /bad\s+breath/i,
    /\bplaque\b/i,
    /\bgingivitis\b/i,
    /\bfresher\b/i,
    /\bcleaner\b/i,
    /brushing\s+alone/i,
    /\bada\b/i,
    /\baccepted\b/i,
    /american\s+dental\s+association/i,
  ];

  return String(rawText || "")
    .split(/[\n\r]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !blockedLine.some((re) => re.test(line)))
    .join("\n");
};

const extractFallbackSizeFromAiText = (aiPayload, aiResponse) => {
  const responseData = aiResponse?.data || {};
  const textSources = [
    aiPayload?.raw_text,
    aiPayload?.detected_text,
    aiPayload?.ocr_text,
    responseData?.raw_text,
    responseData?.detected_text,
  ];

  const sourceTexts = textSources.flatMap(collectTextCandidates).filter(Boolean);
  if (!sourceTexts.length) return null;

  const servingNoiseRegex = /(serving\s*size|servings?\s*per\s*container|calories)/i;
  const nearNetWeightRegex = /(net\s*wt|net\s*weight|\bwt\b|\boz\b|\bfl\s*oz\b)/i;
  const sizeRegex = /(\d+(?:\.\d+)?)\s*(fl\s*oz|fluid\s*oz|oz|ounces?|g|grams?|kg|kilograms?|lb|lbs|pounds?|pack|pk|count|ct|l|liters?|litres?|ml|qt|quarts?)\b/gi;

  const candidates = [];

  sourceTexts.forEach((sourceText, sourceIndex) => {
    const lines = String(sourceText)
      .split(/[\n\r]+/)
      .map((line) => line.trim())
      .filter(Boolean);

    lines.forEach((line, lineIndex) => {
      if (servingNoiseRegex.test(line)) return;

      const lower = line.toLowerCase();
      let match;
      while ((match = sizeRegex.exec(line)) !== null) {
        const rawValue = match[1];
        const rawUnit = match[2];
        const unit = normalizeSizeUnit(rawUnit);
        const value = String(rawValue || "").trim();
        if (!value || !unit) continue;

        const matchStart = typeof match.index === "number" ? match.index : 0;
        const contextStart = Math.max(0, matchStart - 24);
        const contextEnd = Math.min(line.length, matchStart + match[0].length + 16);
        const nearbyContext = line.slice(contextStart, contextEnd);
        const hasNetWeightHint = nearNetWeightRegex.test(nearbyContext) || nearNetWeightRegex.test(lower);

        // Earlier sources and lines are slightly favored to keep output deterministic.
        // Also prefer liter/L as primary package size when multiple units are present.
        const unitPreferenceBoost = unit === "liter" ? 35 : unit === "qt" ? 18 : 0;
        const score =
          (sourceTexts.length - sourceIndex) +
          (lines.length - lineIndex) +
          (hasNetWeightHint ? 20 : 0) +
          unitPreferenceBoost;

        candidates.push({ value, unit, score });
      }
    });
  });

  if (!candidates.length) return null;

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  // Try to detect dual-size labels and build a clean UI display_size string.
  const allText = sourceTexts.join(" ");
  let displaySize = "";
  let secondarySizeValue = "";
  let secondarySizeUnit = "";

  // Direct patterns for requested formats.
  const literMatch = allText.match(/(\d+(?:\.\d+)?)\s*(l|liters?|litres?)\b/i);
  const directFlOzMatch = allText.match(/(\d+(?:\.\d+)?)\s*(fl\s*oz|fluid\s*oz)\b/i);
  const qtFlOzMatch = allText.match(/(\d+(?:\.\d+)?)\s*(qt|quarts?)\s*(\d+(?:\.\d+)?)\s*(fl\s*oz|fluid\s*oz)\b/i);

  const formatPrimaryValue = (value, unit) => {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && unit === "liter") {
      return Number.isInteger(numeric) ? numeric.toFixed(1) : String(numeric);
    }
    return String(value || "").trim();
  };

  const primaryFromBest = {
    value: formatPrimaryValue(best.value, best.unit),
    unit: best.unit,
  };

  if (literMatch) {
    primaryFromBest.value = formatPrimaryValue(literMatch[1], "liter");
    primaryFromBest.unit = "liter";
  }

  const toDisplayUnitLabel = (unit) => {
    if (unit === "liter") return "L";
    if (unit === "fl oz") return "fl oz";
    return unit;
  };

  // Prefer explicit fl oz equivalent when available.
  if (directFlOzMatch) {
    secondarySizeValue = String(directFlOzMatch[1] || "").trim();
    secondarySizeUnit = "fl oz";
  } else if (qtFlOzMatch) {
    const qt = Number(qtFlOzMatch[1]);
    const extraFlOz = Number(qtFlOzMatch[3]);
    if (Number.isFinite(qt) && Number.isFinite(extraFlOz)) {
      secondarySizeValue = (qt * 32 + extraFlOz).toFixed(1);
      secondarySizeUnit = "fl oz";
    }
  }

  // Pattern: primary unit followed by parenthesised/slash secondary, e.g. "1.0 L (33.8 fl oz)"
  const dualSizePattern = /(\d+(?:\.\d+)?)\s*(fl\s*oz|fluid\s*oz|oz|l|liters?|litres?|ml|qt|quarts?|gal|gallons?|lb|lbs|g|kg)[\s\(\[\/]*((\d+\s+)?\d+(?:\.\d+)?)\s*(fl\s*oz|fluid\s*oz|oz|l|liters?|litres?|ml|qt|quarts?|gal|gallons?|lb|lbs|g|kg)/i;
  const dualMatch = dualSizePattern.exec(allText);
  if (dualMatch && !secondarySizeValue) {
    const pVal = formatPrimaryValue(dualMatch[1], normalizeSizeUnit(dualMatch[2]));
    const pUnit = normalizeSizeUnit(dualMatch[2]);
    const sVal = dualMatch[3].trim();
    const sUnit = normalizeSizeUnit(dualMatch[5]);
    if (pUnit && sUnit && pUnit !== sUnit) {
      secondarySizeValue = sVal;
      secondarySizeUnit = sUnit;
      const pLabel = toDisplayUnitLabel(pUnit);
      const sLabel = toDisplayUnitLabel(sUnit);
      displaySize = `${pVal} ${pLabel} / ${sVal} ${sLabel}`;
    }
  }

  if (!displaySize && secondarySizeValue && secondarySizeUnit && primaryFromBest.value && primaryFromBest.unit) {
    displaySize = `${primaryFromBest.value} ${toDisplayUnitLabel(primaryFromBest.unit)} / ${secondarySizeValue} ${toDisplayUnitLabel(secondarySizeUnit)}`;
  }

  // Fallback: single unit display if no dual match
  if (!displaySize && primaryFromBest.unit && primaryFromBest.value) {
    const unitLabel = toDisplayUnitLabel(primaryFromBest.unit);
    displaySize = `${primaryFromBest.value} ${unitLabel}`;
  }

  return {
    size_value: primaryFromBest.value,
    size_unit: primaryFromBest.unit,
    size_confidence: 0.75,
    secondary_size_value: secondarySizeValue,
    secondary_size_unit: secondarySizeUnit,
    display_size: displaySize,
  };
};

// ============================================================================
// buildFinalProductObject — single authoritative product resolver
// Called in handleSaveLocation before every handleAddToShoppingList call.
// Priority rules:
//   product_name: correctionForm (user edit) > product.name (AI+OCR) > "Review needed"
//   brand:        correctionForm (user edit) > product.brand (AI+logo) > product state
//   size:         locationForm (user edit) > product.size_* (AI+OCR fallback)
//   source tag:   "user" if name was user-edited, "ai" if from AI, "manual" otherwise
// ============================================================================
const buildFinalProductObject = ({
  product,
  correctionForm,
  locationForm,
  savedLocation,
  submissionMethod,
  barcodeValue,
}) => {
  const BAD_NAMES = ["unknown product", "review needed", ""];
  const isBad = (n) => BAD_NAMES.includes(String(n || "").trim().toLowerCase());

  // ── product_name ──────────────────────────────────────────────────────────
  const userEditedName = String(correctionForm?.product_name || "").trim();
  const aiName = String(product?.name || product?.product_name || "").trim();
  const resolvedName =
    (!isBad(userEditedName) && userEditedName) ||
    (!isBad(aiName) && aiName) ||
    "Review needed";

  // ── brand ─────────────────────────────────────────────────────────────────
  const resolvedBrand =
    String(correctionForm?.brand || "").trim() ||
    String(product?.brand || "").trim();

  // ── category ──────────────────────────────────────────────────────────────
  const resolvedCategory = String(correctionForm?.category || product?.category || "").trim();

  // ── size ──────────────────────────────────────────────────────────────────
  const resolvedSizeValue =
    String(locationForm?.size_value || "").trim() ||
    String(product?.size_value || "").trim();
  const resolvedSizeUnit =
    String(locationForm?.size_unit || "").trim() ||
    String(product?.size_unit || "").trim();

  let resolvedDisplaySize = String(product?.display_size || "").trim();
  if (!resolvedDisplaySize && resolvedSizeValue && resolvedSizeUnit) {
    const unitLabel =
      resolvedSizeUnit === "liter" ? "L" :
      resolvedSizeUnit === "fl oz" ? "fl oz" :
      resolvedSizeUnit;
    resolvedDisplaySize = `${resolvedSizeValue} ${unitLabel}`.trim();
  }

  // ── quantity ──────────────────────────────────────────────────────────────
  const resolvedQuantity =
    String(locationForm?.quantity || product?.quantity || "1").trim() || "1";

  // ── source tag ────────────────────────────────────────────────────────────
  const aiName2 = String(product?.name || "").trim();
  let resolvedSource = submissionMethod || product?.source || "manual";
  if (!isBad(userEditedName) && userEditedName && userEditedName !== aiName2) {
    resolvedSource = "user";
  } else if (product?.source === "ai") {
    resolvedSource = "ai";
  }

  // ── confidence ────────────────────────────────────────────────────────────
  const resolvedConfidence =
    savedLocation?.confidence_score ?? product?.confidence_score ?? 0;

  return {
    ...product,
    name: resolvedName,
    product_name: resolvedName,
    brand: resolvedBrand,
    category: resolvedCategory,
    barcode: barcodeValue || product?.barcode || null,
    size_value: resolvedSizeValue,
    size_unit: resolvedSizeUnit,
    quantity: resolvedQuantity,
    display_size: resolvedDisplaySize,
    secondary_size_value: product?.secondary_size_value || "",
    secondary_size_unit: product?.secondary_size_unit || "",
    price: savedLocation?.price ?? product?.price ?? null,
    avg_price: savedLocation?.avg_price ?? product?.avg_price ?? null,
    price_type: savedLocation?.price_type ?? product?.price_type ?? "each",
    price_source: savedLocation?.price_source ?? product?.price_source ?? null,
    price_unit_detected:
      savedLocation?.price_unit_detected ?? product?.price_unit_detected ?? "unknown",
    confidence_score: resolvedConfidence,
    notes: savedLocation?.notes ?? product?.notes ?? "",
    source: resolvedSource,
    needs_review: isBad(resolvedName),
    image: product?.image ?? null,
    image_url: product?.image_url ?? null,
    verified_image_url: product?.verified_image_url ?? null,
    cart_image_url: product?.cart_image_url ?? null,
    raw_photo_url: product?.raw_photo_url ?? null,
  };
};

const isValidProductName = (name) => {
  const raw = String(name || "").trim();
  if (raw.length <= 5) return false;

  const rejectedPatterns = [
    /unknown\s+product/i,
    /review\s+needed/i,
    /^n\/?a$/i,
    /^item$/i,
    /^product$/i,
    /way\s+case\s+bareath/i,
  ];
  if (rejectedPatterns.some((re) => re.test(raw))) return false;

  const words = raw.match(/[A-Za-z][A-Za-z'\-]*/g) || [];
  if (!words.length) return false;

  // Require at least one likely real word (>=3 chars with a vowel).
  const hasRealWord = words.some((word) => word.length >= 3 && /[aeiouy]/i.test(word));
  if (!hasRealWord) return false;

  // Block all-caps nonsense names while allowing normal title-case names.
  const hasLetters = /[A-Za-z]/.test(raw);
  const allCaps = hasLetters && raw === raw.toUpperCase();
  const uppercaseWordCount = words.filter((word) => word === word.toUpperCase()).length;
  const mostlyUpper = words.length > 0 && (uppercaseWordCount / words.length) >= 0.8;
  if (allCaps && mostlyUpper) return false;

  return true;
};

export default function App() {
  // ============================================================================
  // REFS - DOM & Internal State Management
  // ============================================================================
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const codeReaderRef = useRef(null);
  const controlsRef = useRef(null);
  const scanningRef = useRef(false);
  const processingRef = useRef(false);
  const aiAutoAddGuardRef = useRef({ fingerprint: "", timestamp: 0 });
  const transitionTimeoutRef = useRef(null);
  const storeSearchTimeoutRef = useRef(null);
  const priceInputRef = useRef(null);
  const priceConfirmationCardRef = useRef(null);
  const aisleInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const activeScreenRef = useRef("store");
  const activePanelRef = useRef(null);
  const cameraLoadPromiseRef = useRef(null);
  const cloudShoppingListLoadedForUserRef = useRef(null);
  const cloudShoppingListReadyRef = useRef(false);
  const cloudShoppingListExplicitClearRef = useRef(false);
  const latestShoppingListItemsRef = useRef([]);
  const shoppingListRehydrateTimerRef = useRef(null);
  const shoppingListRehydrateInFlightRef = useRef(false);
  const shoppingListRehydrateSignatureRef = useRef("");

  // ============================================================================
  // STATE - Scanner & Camera
  // ============================================================================
  const [isScanning, setIsScanning] = useState(false);
  const [availableCameras, setAvailableCameras] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [manualBarcode, setManualBarcode] = useState("");
  const [awaitingPhoto, setAwaitingPhoto] = useState(false);
  const [isCapturingPhoto, setIsCapturingPhoto] = useState(false);

  // ============================================================================
  // STATE - Barcode & Status
  // ============================================================================
  const [barcode, setBarcode] = useState("");
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState("");
  const [submissionMethod, setSubmissionMethod] = useState("");

  // ============================================================================
  // STATE - Product
  // ============================================================================
  const [product, setProduct] = useState(null);
  const [aiDebug, setAiDebug] = useState(null);
  const [aiDetectedRawText, setAiDetectedRawText] = useState("");
  const [isSavingCorrection, setIsSavingCorrection] = useState(false);
  const [correctionSaved, setCorrectionSaved] = useState(false);

  // ============================================================================
  // STATE - Location
  // ============================================================================
  const [bestKnownLocation, setBestKnownLocation] = useState(null);
  const [isLoadingBestLocation, setIsLoadingBestLocation] = useState(false);
  const [isConfirmingBestLocation, setIsConfirmingBestLocation] = useState(false);
  const [isSavingLocation, setIsSavingLocation] = useState(false);
  const [locationSaved, setLocationSaved] = useState(false);
  const [locationConfirmationCount, setLocationConfirmationCount] = useState(0);
  const [locationConfidenceScore, setLocationConfidenceScore] = useState(0);

  // ============================================================================
  // STATE - UI, Toast & Forms
  // ============================================================================
  const [activePanel, setActivePanel] = useState(null);
  const [toast, setToast] = useState({ message: '', type: '' });
  const [toastIsExiting, setToastIsExiting] = useState(false);
  const [showNextItemPrompt, setShowNextItemPrompt] = useState(false);
  const [priceConfirmed, setPriceConfirmed] = useState(false);
  const [aiDetectedPrice, setAiDetectedPrice] = useState(null);
  const [isEditingDetectedPrice, setIsEditingDetectedPrice] = useState(false);
  const [aiDetectedPriceEdited, setAiDetectedPriceEdited] = useState(false);
  const [aiFieldConfidence, setAiFieldConfidence] = useState({
    size: 0,
    quantity: 0,
    price: 0,
  });
  const [aiAutoLockedFields, setAiAutoLockedFields] = useState({
    size: false,
    quantity: false,
  });
  const [aiUserEditedFields, setAiUserEditedFields] = useState({
    size: false,
    quantity: false,
  });
  const [aiIdentityConfidence, setAiIdentityConfidence] = useState(0);
  const [showAiSummaryCard, setShowAiSummaryCard] = useState(false);
  const [showScanditScannerTest, setShowScanditScannerTest] = useState(false);
  const [imageDebugResult, setImageDebugResult] = useState(null);
  const [isEggQuantityOther, setIsEggQuantityOther] = useState(false);
  // Multi-photo capture
  const MAX_PHOTOS = 3;
  const [capturedPhotos, setCapturedPhotos] = useState([]); // [{file, previewUrl, label}]
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [previewImages, setPreviewImages] = useState([]);
  const [photoAnalysisStatus, setPhotoAnalysisStatus] = useState('idle'); // 'idle'|'uploading'|'analyzing'|'done'|'error'
  const [awaitingProductConfirmation, setAwaitingProductConfirmation] = useState(false);
  const [optionalBarcodeInput, setOptionalBarcodeInput] = useState("");
  const [showOptionalBarcodeInput, setShowOptionalBarcodeInput] = useState(false);
  const [editingCartItemIndex, setEditingCartItemIndex] = useState(null);
  const [cartEditForm, setCartEditForm] = useState(null);
  const [cartEditError, setCartEditError] = useState("");
  const [shoppingListItems, setShoppingListItems] = useState([]);
  const [contributionItems, setContributionItems] = useState([]);
  const [activeAisleView, setActiveAisleView] = useState(null);
  const [shoppingMode, setShoppingMode] = useState(false);
  const [manualListItemName, setManualListItemName] = useState("");
  const [catalogSearchTerm, setCatalogSearchTerm] = useState("");
  const [catalogSearchResults, setCatalogSearchResults] = useState([]);
  const [isSearchingCatalog, setIsSearchingCatalog] = useState(false);
  const [catalogSearchMessage, setCatalogSearchMessage] = useState("");
  const [cartComparison, setCartComparison] = useState(null);
  const [cartPriceInsightsByKey, setCartPriceInsightsByKey] = useState({});
  const [isComparingCart, setIsComparingCart] = useState(false);
  const [isManualCloudSaveInProgress, setIsManualCloudSaveInProgress] = useState(false);
  const [manualCloudSaveStatus, setManualCloudSaveStatus] = useState("");
  const [storeRouteLocations, setStoreRouteLocations] = useState({});
  const [isLoadingStoreRoute, setIsLoadingStoreRoute] = useState(false);
  const [brandComparisonMode, setBrandComparisonMode] = useState("flexible");

  // Architecture boundary aliases:
  // - desiredShoppingListItems: user intent list (store-neutral)
  // - scanCartItems: in-store scan/photo contribution activity (store-specific)
  const desiredShoppingListItems = shoppingListItems;
  const setDesiredShoppingListItems = setShoppingListItems;
  const scanCartItems = contributionItems;

  // ============================================================================
  // STATE - User Profile
  // ============================================================================
  const [currentUserProfile, setCurrentUserProfile] = useState(null);
  const [authUser, setAuthUser] = useState(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [loginMode, setLoginMode] = useState("signIn");
  const [authError, setAuthError] = useState("");
  const [isSubmittingAuth, setIsSubmittingAuth] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [activeScreen, setActiveScreen] = useState("landing");
  const [loginForm, setLoginForm] = useState({
    username: "",
    password: "",
  });
  const [showItemRequestModal, setShowItemRequestModal] = useState(false);
  const [itemRequestForm, setItemRequestForm] = useState({
    product_name: "",
    brand: "",
    notes: "",
  });
  const [itemRequestSuggestions, setItemRequestSuggestions] = useState([]);
  const [isSavingItemRequest, setIsSavingItemRequest] = useState(false);
  const [isCheckingProfile, setIsCheckingProfile] = useState(true);
  const [hasCompletedInitialBootstrap, setHasCompletedInitialBootstrap] = useState(false);
  const [hasHydratedLocalShoppingList, setHasHydratedLocalShoppingList] = useState(false);
  const [isCloudShoppingListReady, setIsCloudShoppingListReady] = useState(false);
  const [profileForm, setProfileForm] = useState({
    display_name: "",
    email: "",
  });

  const {
    userPoints,
    rewards,
    fetchUserPoints,
    handleRedeemReward,
  } = useRewards({ setError, setToast });

  const [correctionForm, setCorrectionForm] = useState({
    product_name: "",
    brand: "",
    category: "",
  });

  const [locationForm, setLocationForm] = useState({
    aisle: "",
    section: "",
    shelf: "",
    notes: "",
    size_value: "",
    size_unit: "",
    quantity: "",
    price: "",
    price_type: "each",
    price_source: "",
    detected_price_unit: "unknown",
  });

  // Location panel mode: 'quick' (aisle + buttons only) or 'full' (includes notes)
  const [locationPanelMode, setLocationPanelMode] = useState('quick');
  const [locationStep, setLocationStep] = useState("aisle");

  // ============================================================================
  // STATE - Store Selection
  // ============================================================================
  const [selectedStore, setSelectedStore] = useState(null);
  const [stores, setStores] = useState([]);
  const [isLoadingStores, setIsLoadingStores] = useState(false);
  const [manualStoreName, setManualStoreName] = useState("");
  const [suggestedStore, setSuggestedStore] = useState(null);
  const [isDetectingStore, setIsDetectingStore] = useState(false);
  const [storeDetectionMessage, setStoreDetectionMessage] = useState("");
  const [userLocation, setUserLocation] = useState(null);
  const [nearbyStores, setNearbyStores] = useState([]);
  const [searchResults, setSearchResults] = useState([]);
  const [isFindingNearbyStores, setIsFindingNearbyStores] = useState(false);

  const applyItemRequestSuggestion = (suggestion) => {
    if (!suggestion?.product_name) return;
    setItemRequestForm((prev) => ({
      ...prev,
      product_name: suggestion.product_name,
      brand: suggestion.brand || prev.brand,
    }));
    setItemRequestSuggestions([]);
  };

  const normalizeComparableText = (value) => {
    return String(value || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };

  const normalizeComparableKey = (value) => {
    return String(value || "")
      .split("|")
      .map((segment) => normalizeComparableText(segment))
      .filter(Boolean)
      .join("|");
  };

  const extractMeatVariantKey = (normalized) => {
    const debugEnabled = window.localStorage.getItem("mvpDebug") === "true";

    // Ground beef: detect lean/fat percent patterns for variant-specific bucket keys.
    if (/\bground\s+beef\b/.test(normalized)) {
      let variant = "ground beef";
      // "80/20", "85/15" style fractions
      const fractionMatch = normalized.match(/\b(\d{2,3})\s*\/\s*(\d{2,3})\b/);
      if (fractionMatch) {
        variant = `ground beef ${fractionMatch[1]}/${fractionMatch[2]}`;
      } else {
        // "80% lean", "93 lean", "90 percent lean" style
        const leanMatch = normalized.match(/\b(\d{2,3})\s*%?\s*(?:percent\s+)?lean\b/);
        if (leanMatch) {
          const lean = Number(leanMatch[1]);
          if (lean >= 90) {
            variant = `ground beef ${lean} lean`;
          } else {
            const fat = 100 - lean;
            variant = `ground beef ${lean}/${fat}`;
          }
        }
      }
      // Preserve family/value pack signal as a separate variant bucket.
      if (/\bfamily\s*pack\b/.test(normalized)) {
        variant += " family pack";
      }
      if (debugEnabled) {
        console.debug("MEAT_VARIANT_KEY", { input: normalized, variant, type: "ground_beef" });
      }
      return variant;
    }

    // Ribeye: normalize to canonical form and preserve meaningful cut details.
    if (/\bribeye\b/.test(normalized)) {
      let variant = "ribeye steak";
      if (/\bbone[\s-]*in\b/.test(normalized)) {
        variant = "ribeye steak bone in";
      } else if (/\bboneless\b/.test(normalized)) {
        variant = "ribeye steak boneless";
      } else if (/\bthin[\s-]*slic(ed)?\b/.test(normalized)) {
        variant = "ribeye steak thin sliced";
      }
      if (debugEnabled) {
        console.debug("MEAT_VARIANT_KEY", { input: normalized, variant, type: "ribeye" });
      }
      return variant;
    }

    return null;
  };

  const normalizeCommodityName = (value) => {
    let normalized = normalizeComparableText(value);
    if (!normalized) return "";

    // Canonical commodity forms first.
    if (/\bcilantro\b/.test(normalized)) return "cilantro";
    if (/\bbanana(s)?\b/.test(normalized)) return "bananas";
    // For ground beef and ribeye, use extractMeatVariantKey for granular variant-specific keys.
    const meatVariantKey = extractMeatVariantKey(normalized);
    if (meatVariantKey) return meatVariantKey;
    if (/\bchicken\s+breast\b/.test(normalized)) return "chicken breast";
    if (/\bchicken\s+thigh\b/.test(normalized)) return "chicken thigh";
    if (/\bpork\s+chop(s)?\b/.test(normalized)) return "pork chop";
    if (/\bsalmon\b/.test(normalized)) return "salmon";
    if (/\bshrimp\b/.test(normalized)) return "shrimp";

    const removableWords = new Set([
      "fresh",
      "organic",
      "bunch",
      "each",
      "pack",
      "package",
      "tray",
      "family",
      "value",
      "boneless",
      "skinless",
      "lb",
      "lbs",
      "oz",
      "count",
      "ct",
    ]);

    const tokens = normalized
      .split(" ")
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token) => !removableWords.has(token));

    const deNoised = tokens.join(" ").trim();
    if (!deNoised) return "";

    // Prevent generic commodity collapse.
    if (["meat", "steak", "produce", "fruit", "vegetable", "seafood"].includes(deNoised)) {
      return "";
    }

    return deNoised;
  };

  const isCommodityItem = (item) => {
    const category = normalizeComparableText(item?.category || item?.last_seen_location?.category);
    const productName = normalizeComparableText(
      item?.product_name || item?.name || item?.title || item?.last_seen_location?.product_name || item?.last_seen_location?.name
    );

    const commodityCategories = ["produce", "meat", "poultry", "seafood", "deli", "bakery"];
    const categoryMatch = commodityCategories.some((entry) => category.includes(entry));
    if (categoryMatch) return true;

    const commodityTerms = [
      "cilantro", "banana", "bananas", "apple", "avocado", "onion", "tomato",
      "ribeye", "ground beef", "chicken breast", "chicken thigh", "sirloin", "tenderloin", "chuck",
      "salmon", "shrimp", "pork chop",
    ];
    const packagedTerms = ["milk", "chips", "shampoo", "cereal", "body wash", "detergent", "eggs"];

    const hasCommodityTerm = commodityTerms.some((term) => productName.includes(term));
    const hasPackagedTerm = packagedTerms.some((term) => productName.includes(term));

    return hasCommodityTerm && !hasPackagedTerm;
  };

  const buildCommodityCategoryFamily = (item) => {
    const category = normalizeComparableText(item?.category || item?.last_seen_location?.category);
    const productName = normalizeComparableText(
      item?.product_name || item?.name || item?.title || item?.last_seen_location?.product_name || item?.last_seen_location?.name
    );

    if (category.includes("produce")) return "produce";
    if (category.includes("poultry")) return "poultry";
    if (category.includes("seafood")) return "seafood";
    if (category.includes("meat")) return "meat";
    if (category.includes("deli")) return "deli";
    if (category.includes("bakery")) return "bakery";

    if (/\b(chicken breast|chicken thigh)\b/.test(productName)) return "poultry";
    if (/\b(salmon|shrimp)\b/.test(productName)) return "seafood";
    if (/\b(ribeye|sirloin|tenderloin|chuck|ground beef|pork chop|steak)\b/.test(productName)) return "meat";
    if (/\b(cilantro|banana|bananas|apple|avocado|onion|tomato)\b/.test(productName)) return "produce";

    return "";
  };

  const buildCommodityMatchKey = (item) => {
    if (!isCommodityItem(item)) return null;

    const family = buildCommodityCategoryFamily(item);
    const normalizedName = normalizeCommodityName(
      item?.product_name || item?.name || item?.title || item?.last_seen_location?.product_name || item?.last_seen_location?.name
    );

    if (!family || !normalizedName) return null;
    return `${family}|${normalizedName}`;
  };

  const buildComparableProductKey = (value) => {
    if (!value) return "";

    // Strongest comparable identity: canonical key when the database already provides one.
    const canonicalKey = normalizeComparableKey(
      value?.canonical_product_key || value?.last_seen_location?.canonical_product_key
    );
    if (canonicalKey) return canonicalKey;

    const brand = normalizeComparableText(value?.brand || value?.last_seen_location?.brand);
    const productName = normalizeComparableText(
      value?.product_name || value?.name || value?.title || value?.last_seen_location?.product_name || value?.last_seen_location?.name
    );
    const sizeValue = normalizeComparableText(value?.size_value || value?.last_seen_location?.size_value);
    const sizeUnit = normalizeComparableText(value?.size_unit || value?.last_seen_location?.size_unit || value?.unit || value?.last_seen_location?.unit);
    const displaySize = normalizeComparableText(value?.display_size || value?.last_seen_location?.display_size);

    const sizeKey = [sizeValue, sizeUnit].filter(Boolean).join(" ") || displaySize;
    return normalizeComparableKey([brand, productName, sizeKey].join("|"));
  };

  const buildComparableLookupTerms = (value) => {
    const rawTerms = [
      value?.product_name,
      value?.name,
      value?.brand,
      value?.size_value,
      value?.size_unit,
      value?.display_size,
    ]
      .map(normalizeComparableText)
      .filter(Boolean);

    const tokenTerms = rawTerms.flatMap((term) => term.split(" ").map((part) => part.trim()).filter((part) => part.length >= 3));

    return [...new Set([...rawTerms, ...tokenTerms])];
  };

  const buildComparableProductKeyCandidates = (value) => {
    const candidates = [];
    const pushCandidate = (candidate) => {
      const normalized = normalizeComparableKey(candidate);
      if (normalized && !candidates.includes(normalized)) {
        candidates.push(normalized);
      }
    };

    // Match priority: barcode > canonical key > exact brand/name/size signature.
    const barcodeValue = String(value?.barcode || value?.last_seen_location?.barcode || "").trim();
    if (barcodeValue) {
      pushCandidate(`barcode|${barcodeValue}`);
    }

    const canonicalKey = value?.canonical_product_key || value?.last_seen_location?.canonical_product_key;
    if (canonicalKey) {
      pushCandidate(canonicalKey);
    }

    const brand = normalizeComparableText(value?.brand || value?.last_seen_location?.brand);
    const productName = normalizeComparableText(
      value?.product_name || value?.name || value?.title || value?.last_seen_location?.product_name || value?.last_seen_location?.name
    );
    const sizeValue = normalizeComparableText(value?.size_value || value?.last_seen_location?.size_value);
    const sizeUnit = normalizeComparableText(value?.size_unit || value?.last_seen_location?.size_unit || value?.unit || value?.last_seen_location?.unit);
    const displaySize = normalizeComparableText(value?.display_size || value?.last_seen_location?.display_size);

    const sizeKey = [sizeValue, sizeUnit].filter(Boolean).join(" ") || displaySize;
    pushCandidate([brand, productName, sizeKey].filter(Boolean).join("|"));

    // Commodity fallback is final-only and commodity-scoped.
    const commodityKey = buildCommodityMatchKey(value);
    if (commodityKey) {
      pushCandidate(`commodity|${commodityKey}`);
    }

    return candidates;
  };

  const getProductIdentityParts = (value) => {
    const barcode = String(value?.barcode || value?.last_seen_location?.barcode || "").trim();
    const canonicalKey = normalizeComparableKey(
      value?.canonical_product_key || value?.last_seen_location?.canonical_product_key
    );
    const brand = normalizeComparableText(value?.brand || value?.last_seen_location?.brand);
    const productName = normalizeComparableText(
      value?.product_name || value?.name || value?.title || value?.last_seen_location?.product_name || value?.last_seen_location?.name
    );
    const sizeValue = normalizeComparableText(value?.size_value || value?.last_seen_location?.size_value);
    const sizeUnit = normalizeComparableText(
      value?.size_unit || value?.last_seen_location?.size_unit || value?.unit || value?.last_seen_location?.unit
    );
    const sizePair = [sizeValue, sizeUnit].filter(Boolean).join(" ");
    const displaySize = normalizeComparableText(value?.display_size || value?.last_seen_location?.display_size);
    const category = normalizeComparableText(value?.category || value?.last_seen_location?.category);

    return {
      barcode,
      canonicalKey,
      brand,
      productName,
      sizePair,
      displaySize,
      category,
    };
  };

  const getProductMatchMethod = (cartItem, row) => {
    const cart = getProductIdentityParts(cartItem);
    const candidate = getProductIdentityParts(row);
    const debugEnabled = window.localStorage.getItem("mvpDebug") === "true";

    const normalizedBrandMode = String(brandComparisonMode || "flexible").toLowerCase();
    const requireExactBrand = normalizedBrandMode === "brand_match" || normalizedBrandMode === "match exact brand";

    if (debugEnabled) {
      console.debug("COMMODITY_MATCH_INPUT", {
        cart_product_name: cartItem?.product_name || cartItem?.name || null,
        row_product_name: row?.product_name || row?.name || null,
        cart_category: cartItem?.category || null,
        row_category: row?.category || null,
      });
    }

    // Priority 1: exact barcode always wins.
    if (cart.barcode && candidate.barcode && cart.barcode === candidate.barcode) {
      return "barcode";
    }

    // Priority 2: canonical key is strong identity, but exact-brand mode still enforces brand.
    if (cart.canonicalKey && candidate.canonicalKey && cart.canonicalKey === candidate.canonicalKey) {
      if (!requireExactBrand) return "canonical_key";
      if (cart.brand && candidate.brand && cart.brand === candidate.brand) {
        return "canonical_key";
      }
      return null;
    }

    // Priority 3: commodity identity — only when BOTH sides are commodity items.
    // Must run BEFORE the strict packaged-goods name/size check so produce/meat/seafood
    // can match even when product names or sizes differ between stores/brands.
    const cartCommodityKey = buildCommodityMatchKey(cartItem);
    const rowCommodityKey = buildCommodityMatchKey(row);

    if (debugEnabled) {
      console.debug("COMMODITY_MATCH_ATTEMPT", {
        cart_product_name: cartItem?.product_name || cartItem?.name || null,
        row_product_name: row?.product_name || row?.name || null,
        cartCommodityKey: cartCommodityKey || null,
        rowCommodityKey: rowCommodityKey || null,
      });
    }

    if (cartCommodityKey && rowCommodityKey) {
      if (cartCommodityKey === rowCommodityKey) {
        if (debugEnabled) {
          console.debug("COMMODITY_MATCH_ACCEPTED", {
            method: "commodity_identity",
            cartCommodityKey,
            rowCommodityKey,
            cart_product_name: cartItem?.product_name || cartItem?.name || null,
            row_product_name: row?.product_name || row?.name || null,
          });
        }
        return "commodity_identity";
      }
      // Both sides are commodity items but different variants — do NOT fall through to
      // packaged-goods strict check (prevents 80/20 from matching 93 lean via flexible_identity).
      if (debugEnabled) {
        console.debug("COMMODITY_MATCH_REJECTED", {
          cartCommodityKey,
          rowCommodityKey,
          reason: "commodity_variant_mismatch",
          cart_product_name: cartItem?.product_name || cartItem?.name || null,
          row_product_name: row?.product_name || row?.name || null,
        });
      }
      return null;
    }

    // Priority 4 (packaged goods): strict identity requires exact name + size.
    // Size comparison is strict: prefer explicit size value+unit, otherwise allow exact display_size fallback.
    const hasExactSizePair = Boolean(cart.sizePair && candidate.sizePair && cart.sizePair === candidate.sizePair);
    const hasExactDisplaySizeFallback = Boolean(
      !hasExactSizePair &&
      cart.productName &&
      candidate.productName &&
      (cart.sizePair === "" || candidate.sizePair === "") &&
      cart.displaySize &&
      candidate.displaySize &&
      cart.displaySize === candidate.displaySize
    );
    const hasExactSize = hasExactSizePair || hasExactDisplaySizeFallback;

    if (!cart.productName || !candidate.productName || cart.productName !== candidate.productName || !hasExactSize) {
      return null;
    }

    // Priority 5: strict identity requires exact brand + name + size.
    if (cart.brand && candidate.brand && cart.brand === candidate.brand) {
      return "strict_identity";
    }

    // Priority 6: flexible identity allows missing brand only when name+size are already exact and category does not conflict.
    if (!requireExactBrand) {
      const categoryCompatible = !cart.category || !candidate.category || cart.category === candidate.category;
      const hasMissingBrand = !cart.brand || !candidate.brand;
      if (hasMissingBrand && categoryCompatible) {
        return "flexible_identity";
      }
    }

    return null;
  };

  const isBetterPriceObservation = (candidate, current) => {
    if (!current) return true;

    const candidatePrice = Number(candidate?.avg_price ?? candidate?.price);
    const currentPrice = Number(current?.avg_price ?? current?.price);

    const candidateHasPrice = Number.isFinite(candidatePrice) && candidatePrice > 0;
    const currentHasPrice = Number.isFinite(currentPrice) && currentPrice > 0;

    if (candidateHasPrice !== currentHasPrice) {
      return candidateHasPrice;
    }

    if (candidateHasPrice && currentHasPrice && candidatePrice !== currentPrice) {
      return candidatePrice < currentPrice;
    }

    const candidateConfidence = Number(candidate?.confidence_score || 0);
    const currentConfidence = Number(current?.confidence_score || 0);
    if (candidateConfidence !== currentConfidence) {
      return candidateConfidence > currentConfidence;
    }

    const candidateConfirmed = candidate?.last_confirmed_at ? new Date(candidate.last_confirmed_at).getTime() : 0;
    const currentConfirmed = current?.last_confirmed_at ? new Date(current.last_confirmed_at).getTime() : 0;
    return candidateConfirmed > currentConfirmed;
  };

  const buildPriceObservationIndex = (rows) => {
    const byKey = {};

    for (const row of rows || []) {
      const keys = buildComparableProductKeyCandidates(row);
      if (!keys.length) continue;

      const storeId = String(row?.store_id || "").trim();
      if (!storeId) continue;

      keys.forEach((key) => {
        if (!byKey[key]) {
          byKey[key] = {
            rowsByStore: {},
            allRows: [],
            cheapestRow: null,
          };
        }

        const bucket = byKey[key];
        const existingStoreRow = bucket.rowsByStore[storeId];
        if (!existingStoreRow || isBetterPriceObservation(row, existingStoreRow)) {
          bucket.rowsByStore[storeId] = row;
        }

        if (!bucket.cheapestRow || isBetterPriceObservation(row, bucket.cheapestRow)) {
          bucket.cheapestRow = row;
        }

        bucket.allRows.push(row);
      });
    }

    return byKey;
  };

  const getComparablePriceBucket = (priceIndex, value) => {
    const candidateKeys = buildComparableProductKeyCandidates(value);
    const mergedBucket = {
      rowsByStore: {},
      allRows: [],
      cheapestRow: null,
    };

    let matched = false;

    candidateKeys.forEach((candidateKey) => {
      const bucket = priceIndex?.[candidateKey];
      if (!bucket) return;
      matched = true;

      Object.entries(bucket.rowsByStore || {}).forEach(([storeId, row]) => {
        const existingStoreRow = mergedBucket.rowsByStore[storeId];
        if (!existingStoreRow || isBetterPriceObservation(row, existingStoreRow)) {
          mergedBucket.rowsByStore[storeId] = row;
        }
      });

      if (!mergedBucket.cheapestRow || isBetterPriceObservation(bucket.cheapestRow, mergedBucket.cheapestRow)) {
        mergedBucket.cheapestRow = bucket.cheapestRow;
      }

      mergedBucket.allRows.push(...(bucket.allRows || []));
    });

    return matched ? mergedBucket : null;
  };

  const fetchComparableProductLocationRows = async ({ barcodes = [], canonicalKeys = [], terms = [], lookupTerms = [] } = {}) => {
    const allRows = [];
    const fullSelect = "barcode, canonical_product_key, product_name, brand, category, size_value, size_unit, display_size, store_id, store_name, aisle, section, shelf, price, avg_price, price_type, confidence_score, last_confirmed_at";
    const fallbackSelect = "barcode, product_name, brand, category, size_value, size_unit, display_size, store_id, aisle, section, shelf, price, avg_price, price_type, confidence_score, last_confirmed_at";

    const addRows = async (queryBuilder, label) => {
      const { data, error } = await queryBuilder;
      if (error) {
        if (isMissingOptionalColumnError(error)) {
          console.warn(`${label} OPTIONAL COLUMN FALLBACK:`, error.message);
          return false;
        }
        throw error;
      }

      if (Array.isArray(data)) {
        allRows.push(...data);
      }

      return true;
    };

    if (Array.isArray(barcodes) && barcodes.length > 0) {
      const query = supabase
        .from("product_locations")
        .select(fullSelect)
        .in("barcode", barcodes)
        .limit(200);

      const succeeded = await addRows(query, "PRICE MATCH BARCODE QUERY");
      if (!succeeded) {
        await addRows(
          supabase
            .from("product_locations")
            .select(fallbackSelect)
            .in("barcode", barcodes)
            .limit(200),
          "PRICE MATCH BARCODE QUERY"
        );
      }
    }

    if (Array.isArray(canonicalKeys) && canonicalKeys.length > 0) {
      try {
        const query = supabase
          .from("product_locations")
          .select(fullSelect)
          .in("canonical_product_key", canonicalKeys)
          .limit(200);

        const succeeded = await addRows(query, "PRICE MATCH CANONICAL QUERY");
        if (!succeeded) {
          await addRows(
            supabase
              .from("product_locations")
              .select(fallbackSelect)
              .limit(200),
            "PRICE MATCH CANONICAL QUERY"
          );
        }
      } catch (err) {
        if (!isMissingOptionalColumnError(err)) {
          throw err;
        }
      }
    }

    if (Array.isArray(terms) && terms.length > 0) {
      const normalizedTerms = [...new Set(terms.map(normalizeComparableText).filter(Boolean))].slice(0, 12);
      if (normalizedTerms.length > 0) {
        const orClause = normalizedTerms
          .flatMap((term) => [
            `product_name.ilike.%${term}%`,
            `brand.ilike.%${term}%`,
            `category.ilike.%${term}%`,
          ])
          .join(",");

        const query = supabase
          .from("product_locations")
          .select(fullSelect)
          .or(orClause)
          .limit(200);

        const succeeded = await addRows(query, "PRICE MATCH TERM QUERY");
        if (!succeeded) {
          await addRows(
            supabase
              .from("product_locations")
              .select(fallbackSelect)
              .or(orClause)
              .limit(200),
            "PRICE MATCH TERM QUERY"
          );
        }
      }
    }


    if (Array.isArray(lookupTerms) && lookupTerms.length > 0) {
      const tokenTerms = [...new Set(lookupTerms.map(normalizeComparableText).filter((term) => term.length >= 3).slice(0, 20))];
      if (tokenTerms.length > 0) {
        const orClause = tokenTerms
          .flatMap((term) => [
            `product_name.ilike.%${term}%`,
            `brand.ilike.%${term}%`,
            `display_size.ilike.%${term}%`,
          ])
          .join(",");

        const query = supabase
          .from("product_locations")
          .select(fullSelect)
          .or(orClause)
          .limit(200);

        const succeeded = await addRows(query, "PRICE MATCH TOKEN QUERY");
        if (!succeeded) {
          await addRows(
            supabase
              .from("product_locations")
              .select(fallbackSelect)
              .or(orClause)
              .limit(200),
            "PRICE MATCH TOKEN QUERY"
          );
        }
      }
    }
    const dedupedRows = [];
    const seen = new Set();
    for (const row of allRows) {
      const key = [
        String(row?.store_id || "").trim(),
        String(row?.barcode || "").trim(),
        String(row?.canonical_product_key || "").trim(),
        String(row?.product_name || "").trim(),
        String(row?.brand || "").trim(),
        String(row?.category || "").trim(),
        String(row?.size_value || "").trim(),
        String(row?.size_unit || "").trim(),
        String(row?.display_size || "").trim(),
        String(row?.price || "").trim(),
        String(row?.avg_price || "").trim(),
      ].join("|");

      if (seen.has(key)) continue;
      seen.add(key);
      dedupedRows.push(row);
    }

    return dedupedRows;
  };

  const buildStoreComparisonResults = (cartItems, priceIndex) => {
    const storeGroups = {};
    const totalItems = Array.isArray(cartItems) ? cartItems.length : 0;
    let matchedItemCount = 0;

    (cartItems || []).forEach((cartItem) => {
      const itemKey = buildComparableProductKey(cartItem);
      const priceBucket = getComparablePriceBucket(priceIndex, cartItem);

      if (!priceBucket) return;

      matchedItemCount += 1;

      Object.values(priceBucket.rowsByStore || {}).forEach((row) => {
        const storeId = String(row?.store_id || "").trim();
        if (!storeId) return;

        const price = Number(row?.avg_price ?? row?.price);
        if (!Number.isFinite(price) || price <= 0) return;

        if (!storeGroups[storeId]) {
          storeGroups[storeId] = {
            store_id: storeId,
            store: row?.stores || (row?.store_name ? { name: row.store_name } : null),
            matched_count: 0,
            total_price: 0,
            total_confidence: 0,
            brand_match_count: 0,
            itemsByKey: {},
            is_estimate: false,
          };
        }

        const storeGroup = storeGroups[storeId];
        // Validate row identity against cart item using the same strict logic as calculateBestStore
        const matchMethod = getProductMatchMethod(cartItem, row);
        if (!matchMethod) return;

        // Stable bucket key — never use Math.random()
        const bucketKey =
          itemKey ||
          String(
            cartItem?.cart_item_id ||
            cartItem?.id ||
            cartItem?.barcode ||
            cartItem?.product_name ||
            cartItem?.name ||
            "cart-item"
          );
        const currentMatch = storeGroup.itemsByKey[bucketKey];
        if (!currentMatch || isBetterPriceObservation(row, currentMatch.row)) {
          storeGroup.itemsByKey[bucketKey] = { row: { ...row, match_method: matchMethod }, cartItem };
        }
      });
    });

    Object.values(storeGroups).forEach((storeGroup) => {
      const matches = Object.values(storeGroup.itemsByKey || {});
      storeGroup.matched_count = matches.length;
      storeGroup.total_price = matches.reduce((sum, match) => {
        const price = Number(match?.row?.avg_price ?? match?.row?.price);
        return Number.isFinite(price) && price > 0 ? sum + price : sum;
      }, 0);
      storeGroup.total_confidence = matches.reduce((sum, match) => sum + Number(match?.row?.confidence_score || 0), 0);
      storeGroup.avg_confidence = matches.length > 0 ? Math.round(storeGroup.total_confidence / matches.length) : 0;
      storeGroup.coverage = totalItems > 0 ? Math.round((storeGroup.matched_count / totalItems) * 100) : 0;
      storeGroup.brand_match_pct = 0;
      storeGroup.is_estimate = matches.some((match) => !Number.isFinite(Number(match?.row?.avg_price ?? match?.row?.price)));
    });

    const sortedStores = Object.values(storeGroups).sort((a, b) => {
      if (b.coverage !== a.coverage) return b.coverage - a.coverage;
      if (a.total_price !== b.total_price) return a.total_price - b.total_price;
      return b.avg_confidence - a.avg_confidence;
    });

    return {
      byKey: priceIndex,
      stores: sortedStores,
      matchedItemCount,
      totalItems,
    };
  };

  const isMissingOptionalColumnError = (err) => {
    const message = String(err?.message || "").toLowerCase();
    const details = String(err?.details || "").toLowerCase();
    const hint = String(err?.hint || "").toLowerCase();
    const code = String(err?.code || "").toLowerCase();
    const combined = `${message} ${details} ${hint} ${code}`;

    return (
      combined.includes("column") ||
      combined.includes("schema cache") ||
      combined.includes("does not exist") ||
      combined.includes("could not find") ||
      combined.includes("pgrst") ||
      combined.includes("42703")
    );
  };

  // Hydrate a catalog product with store-specific price offers from product_locations
  const hydratePriceOffers = async (catalogProduct) => {
    if (!catalogProduct) return { offers: [], bestOffer: null };

    const barcode = String(catalogProduct?.barcode || "").trim() || null;
    const canonicalKey = normalizeComparableKey(
      catalogProduct?.canonical_product_key || buildComparableProductKey(catalogProduct)
    ) || null;
    const productName = String(catalogProduct?.product_name || catalogProduct?.name || "").trim();
    const brand = String(catalogProduct?.brand || "").trim();
    const sizeValue = String(catalogProduct?.size_value || "").trim();
    const sizeUnit = String(catalogProduct?.size_unit || "").trim();

    try {
      const debugEnabled = window.localStorage.getItem("mvpDebug") === "true";
      const normalizedCatalogCanonical = normalizeComparableKey(catalogProduct?.canonical_product_key || canonicalKey);

      // Query order: barcode -> canonical key -> text fallback.
      const barcodeRows = barcode
        ? await fetchComparableProductLocationRows({ barcodes: [barcode], canonicalKeys: [], terms: [], lookupTerms: [] })
        : [];
      const canonicalRows = normalizedCatalogCanonical
        ? await fetchComparableProductLocationRows({ barcodes: [], canonicalKeys: [normalizedCatalogCanonical], terms: [], lookupTerms: [] })
        : [];
      const fallbackRows = await fetchComparableProductLocationRows({
        barcodes: [],
        canonicalKeys: [],
        terms: [productName, brand, sizeValue].filter(Boolean),
        lookupTerms: [productName, brand, sizeValue, sizeUnit].filter(Boolean),
      });

      const mergedRowsByKey = new Map();
      [...barcodeRows, ...canonicalRows, ...fallbackRows].forEach((row) => {
        const dedupeKey = [
          String(row?.store_id || "").trim(),
          String(row?.barcode || "").trim(),
          normalizeComparableKey(row?.canonical_product_key) || "",
          normalizeComparableText(row?.product_name) || "",
          normalizeComparableText(row?.brand) || "",
          String(row?.avg_price ?? row?.price ?? "").trim(),
        ].join("|");
        if (!mergedRowsByKey.has(dedupeKey)) {
          mergedRowsByKey.set(dedupeKey, row);
        }
      });
      const priceRows = Array.from(mergedRowsByKey.values());

      const rejectedRows = [];
      const filteredPriceRows = (Array.isArray(priceRows) ? priceRows : []).filter((row) => {
        const rowBarcode = String(row?.barcode || "").trim();
        const rowCanonical = normalizeComparableKey(row?.canonical_product_key);
        const isBarcodeMatch = Boolean(barcode && rowBarcode && barcode === rowBarcode);

        if (isBarcodeMatch) {
          return true;
        }

        if (normalizedCatalogCanonical && rowCanonical && normalizedCatalogCanonical === rowCanonical) {
          return true;
        }

        const matchMethod = getProductMatchMethod(catalogProduct, row);
        if (!matchMethod) {
          if (rejectedRows.length < 5) {
            rejectedRows.push({
              reason: "no_strict_match_method",
              product_name: row?.product_name || null,
              brand: row?.brand || null,
              barcode: rowBarcode || null,
              canonical_product_key: rowCanonical || null,
            });
          }
          return false;
        }

        return true;
      });
      if (debugEnabled) {
        console.debug("PRICE_HYDRATION_FILTER", {
          product_name: productName || null,
          fetched_row_count: Array.isArray(priceRows) ? priceRows.length : 0,
          filtered_row_count: filteredPriceRows.length,
          rejected_examples: rejectedRows,
        });
      }

      // Group by store and pick best price per store
      const offersByStore = {};
      filteredPriceRows.forEach((row) => {
        const storeId = String(row?.store_id || "").trim();
        if (!storeId) return;

        const price = Number(row?.avg_price ?? row?.price);
        if (!Number.isFinite(price) || price <= 0) return;

        const offer = {
          store_id: storeId,
          store_name: row?.store_name || "Unknown store",
          price: price,
          avg_price: Number(row?.avg_price) || price,
          price_type: row?.price_type || "each",
          aisle: row?.aisle || "",
          section: row?.section || "",
          shelf: row?.shelf || "",
          confidence_score: Number(row?.confidence_score || 0),
          updated_at: row?.last_confirmed_at || new Date().toISOString(),
          last_confirmed_at: row?.last_confirmed_at || null,
          canonical_product_key: row?.canonical_product_key || canonicalKey || null,
          barcode: String(row?.barcode || "").trim() || barcode || null,
          product_name: row?.product_name || productName || null,
          brand: row?.brand || brand || null,
          size_value: row?.size_value || sizeValue || null,
          size_unit: row?.size_unit || sizeUnit || null,
          display_size: row?.display_size || null,
        };

        // Group by store + commodity variant key to prevent cross-variant merging.
        // e.g. "Ground Beef 80/20" and "Ground Beef 93 Lean" at the same store must not share a bucket.
        const rowCommodityKey = buildCommodityMatchKey(row);
        const offerGroupKey = rowCommodityKey ? `${storeId}|${rowCommodityKey}` : storeId;

        if (debugEnabled) {
          const nameStr = String(row?.product_name || "").toLowerCase();
          if (/ground\s+beef/.test(nameStr)) {
            console.debug("GROUND_BEEF_VARIANT_BUCKET", {
              storeId, offerGroupKey, rowCommodityKey: rowCommodityKey || null, price, product_name: row?.product_name || null,
            });
          } else if (/ribeye/.test(nameStr)) {
            console.debug("RIBEYE_VARIANT_BUCKET", {
              storeId, offerGroupKey, rowCommodityKey: rowCommodityKey || null, price, product_name: row?.product_name || null,
            });
          }
        }

        // Keep the best (lowest) price per store+variant group.
        if (!offersByStore[offerGroupKey] || price < offersByStore[offerGroupKey].price) {
          offersByStore[offerGroupKey] = offer;
        }
      });

      const offers = Object.values(offersByStore).sort((a, b) => a.price - b.price);
      const bestOffer = offers.length > 0 ? offers[0] : null;

      if (debugEnabled) {
        console.debug("PRICE_HYDRATION_RESULT", {
          product_name: productName || null,
          barcode: barcode || null,
          canonical_product_key: normalizedCatalogCanonical || null,
          locationRowCount: filteredPriceRows.length,
          storesWithOffers: offers.length,
          cheapest_known_price: bestOffer?.price ?? null,
          cheapest_known_store_name: bestOffer?.store_name || null,
        });
      }

      return { offers, bestOffer };
    } catch (err) {
      console.warn("PRICE_HYDRATION_ERROR", {
        productName,
        error: err?.message || String(err),
      });
      return { offers: [], bestOffer: null };
    }
  };

  const loadProfileFromLocalStorage = ({ guestOnly = false } = {}) => {
    const saved = localStorage.getItem("currentUserProfile");

    if (!saved) {
      setCurrentUserProfile(null);
      setIsAuthLoading(false);
      setIsCheckingProfile(false);
      return;
    }

    try {
      const parsed = JSON.parse(saved);
      if (parsed?.display_name) {
        if (guestOnly && !parsed?.is_guest) {
          localStorage.removeItem("currentUserProfile");
          setCurrentUserProfile(null);
          setIsAuthLoading(false);
          setIsCheckingProfile(false);
          return;
        }
        if (parsed?.is_guest) {
          const safeUserId = toSafeUserId(parsed?.id);
          const normalizedGuestProfile = { ...parsed, id: safeUserId };
          if (parsed?.id !== safeUserId) {
            localStorage.setItem("currentUserProfile", JSON.stringify(normalizedGuestProfile));
          }
          setCurrentUserProfile(normalizedGuestProfile);
          setIsAuthLoading(false);
          setIsCheckingProfile(false);
          return;
        }
        setCurrentUserProfile(parsed);
        setIsAuthLoading(false);
        setIsCheckingProfile(false);
        return;
      }
      localStorage.removeItem("currentUserProfile");
      setCurrentUserProfile(null);
      setIsAuthLoading(false);
      setIsCheckingProfile(false);
    } catch {
      localStorage.removeItem("currentUserProfile");
      setCurrentUserProfile(null);
      setIsAuthLoading(false);
      setIsCheckingProfile(false);
    }
  };

  useEffect(() => {
    latestShoppingListItemsRef.current = shoppingListItems;
  }, [shoppingListItems]);

  const resetAppSession = async () => {
    try {
      await supabase.auth.signOut();
    } catch (err) {
      console.warn("RESET APP SESSION SIGNOUT WARNING:", err);
    }

    localStorage.removeItem("currentUserProfile");
    localStorage.removeItem("selectedStore");

    setAuthUser(null);
    setCurrentUserProfile(null);
    setSelectedStore(null);
    setIsAuthLoading(false);
    setIsCheckingProfile(false);
    setShowLoginModal(false);
    setAppScreen("store");
    setError("");
    setStatus("Ready");
  };

  const ensureCamerasLoaded = async () => {
    if (availableCameras.length > 0) {
      return availableCameras;
    }

    if (cameraLoadPromiseRef.current) {
      return cameraLoadPromiseRef.current;
    }

    cameraLoadPromiseRef.current = (async () => {
      try {
        setStatus("Loading cameras...");
        const devices = await BrowserMultiFormatReader.listVideoInputDevices();
        setAvailableCameras(devices);

        const rearCamera =
          devices.find((d) => /back|rear|environment|camera 2/gi.test(d.label)) ||
          devices.find((d) => !/front|user|selfie/gi.test(d.label)) ||
          devices[0];

        if (rearCamera?.deviceId) {
          setSelectedDeviceId(rearCamera.deviceId);
        }

        setStatus("Ready");
        return devices;
      } catch (err) {
        console.error("CAMERA LOAD ERROR:", err);
        setError("Unable to load cameras");
        setStatus("Camera load failed");
        return [];
      } finally {
        cameraLoadPromiseRef.current = null;
      }
    })();

    return cameraLoadPromiseRef.current;
  };

  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out`)), ms)
      ),
    ]);

  const createTemporarySupabaseProfile = (user) => {
    const username = user?.email?.split("@")[0] || "mvp_shopper";
    const displayName = user?.email?.split("@")[0] || "MVP Shopper";

    return {
      id: user?.id,
      username,
      display_name: displayName,
      email: user?.email || null,
      trust_score: 0,
      points: 0,
      total_points: 0,
      is_guest: false,
    };
  };

  const loadOrCreateSupabaseProfile = async (user) => {
    if (!user?.id) return null;

    console.info("PROFILE LOAD START", {
      userId: user?.id || null,
      emailDomain: String(user?.email || "").split("@").slice(1).join("@") || null,
    });

    try {
      const { data: existingProfile, error: existingProfileError } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .maybeSingle();

      if (existingProfileError) throw existingProfileError;

      if (existingProfile) {
        setCurrentUserProfile(existingProfile);
        localStorage.setItem("currentUserProfile", JSON.stringify(existingProfile));
        console.info("PROFILE LOAD SUCCESS", {
          profileId: existingProfile?.id || null,
          isGuest: Boolean(existingProfile?.is_guest),
          source: "existing",
        });
        return existingProfile;
      }

      const newProfilePayload = {
        id: user.id,
        username:
          user.email?.split("@")[0] ||
          user.user_metadata?.display_name ||
          "mvp_shopper",
        display_name:
          user.user_metadata?.display_name ||
          user.email?.split("@")[0] ||
          "MVP Shopper",
        email: user.email,
        trust_score: 0,
        points: 0,
        total_points: 0,
        is_guest: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      console.log("PROFILE INSERT PAYLOAD:", newProfilePayload);

      const { data: insertedProfile, error: insertProfileError } = await supabase
        .from("profiles")
        .insert(newProfilePayload)
        .select()
        .single();

      console.log("PROFILE INSERT RESULT:", insertedProfile);
      console.log("PROFILE INSERT ERROR:", insertProfileError);

      if (insertProfileError) throw insertProfileError;

      setCurrentUserProfile(insertedProfile);
      localStorage.setItem("currentUserProfile", JSON.stringify(insertedProfile));
      console.info("PROFILE LOAD SUCCESS", {
        profileId: insertedProfile?.id || null,
        isGuest: Boolean(insertedProfile?.is_guest),
        source: "inserted",
      });
      return insertedProfile;
    } catch (err) {
      console.info("PROFILE LOAD FAILED", {
        userId: user?.id || null,
        message: err?.message || "Unable to load profile",
      });
      console.error("SUPABASE PROFILE BOOTSTRAP ERROR:", err);
      setError(err?.message || "Unable to load your profile.");
      return null;
    }
  };

  // Supabase email confirmation may block sign-in unless disabled in Authentication > Settings > Email Auth or the user confirms by email.
  const handleSupabaseAuth = async () => {
    const email = loginForm.username.trim().toLowerCase();
    const password = loginForm.password;

    if (!email || !password) {
      setAuthError("Enter email and password.");
      return;
    }

    setAuthError("");
    setIsSubmittingAuth(true);
    console.info("AUTH LOGIN START", {
      mode: loginMode,
      emailDomain: String(email || "").split("@").slice(1).join("@") || null,
    });

    try {
      let shouldCloseModal = false;
      let successMessage = "Signed in successfully.";

      if (loginMode === "signUp") {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: AUTH_REDIRECT_URL,
            data: {
              display_name: email.split("@")[0],
            },
          },
        });
        if (signUpError) throw signUpError;
        if (data?.user && data?.session) {
          setAuthUser(data.user);
          shouldCloseModal = true;
          successMessage = "Account created. Welcome to MVP.";
          console.info("AUTH LOGIN SUCCESS", {
            mode: loginMode,
            userId: data.user?.id || null,
          });

          // Never block the auth modal flow on profile bootstrap.
          withTimeout(loadOrCreateSupabaseProfile(data.user), 8000, "Profile load")
            .then((profile) => {
              if (!profile) {
                setToast({
                  message: "Signed in, but your profile is still loading in the background.",
                  type: "error",
                });
              }
            })
            .catch((err) => {
              console.error("BACKGROUND PROFILE LOAD ERROR:", err);
              setToast({
                message: "Signed in, but your profile is still loading in the background.",
                type: "error",
              });
            });
        } else if (data?.user && !data?.session) {
          setAuthError("Account created. Check your inbox and spam folder to confirm your email before signing in. If no email arrives, tap Resend Confirmation Email or continue as guest for now.");
          return;
        }
      } else {
        const { data, error: signInError } = await withTimeout(
          supabase.auth.signInWithPassword({
            email,
            password,
          }),
          10000,
          "Login"
        );
        if (signInError) throw signInError;
        if (data?.user && data?.session) {
          setAuthUser(data.user);
          localStorage.removeItem("currentUserProfile");
          setCurrentUserProfile(null);
          setAuthError("");
          setShowLoginModal(false);
          setLoginForm({ username: "", password: "" });
          setToast({ message: "Signed in successfully.", type: "success" });
          setAppScreen("store");
          console.info("AUTH LOGIN SUCCESS", {
            mode: loginMode,
            userId: data.user?.id || null,
          });

          withTimeout(loadOrCreateSupabaseProfile(data.user), 8000, "Profile load")
            .then((profile) => {
              if (!profile) {
                setToast({
                  message: "Signed in, but your profile is still loading in the background.",
                  type: "error",
                });
              }
            })
            .catch((err) => {
              console.error("BACKGROUND PROFILE LOAD ERROR:", err);
              setToast({
                message: "Signed in, but your profile is still loading in the background.",
                type: "error",
              });
            });

          return;
        } else {
          throw new Error("Unable to authenticate right now.");
        }
      }

      if (shouldCloseModal) {
        setAuthError("");
        setAppScreen("store");
        setShowLoginModal(false);
        setLoginForm({ username: "", password: "" });
        setToast({
          message: successMessage,
          type: "success",
        });
      }
    } catch (err) {
      console.info("AUTH LOGIN FAILED", {
        mode: loginMode,
        message: err?.message || "Unable to authenticate right now.",
      });
      console.error("SUPABASE AUTH ERROR:", err);
      const errorMessage = String(err?.message || "");
      const lowerErrorMessage = errorMessage.toLowerCase();
      if (lowerErrorMessage.includes("login timed out")) {
        setAuthError("Login is taking too long. Please try again or continue as guest.");
        setToast({
          message: "Login is taking too long. Please try again or continue as guest.",
          type: "error",
        });
      } else if (loginMode === "signIn" && lowerErrorMessage.includes("invalid login credentials")) {
        setAuthError("Invalid login credentials. This usually means the user does not exist, the password is wrong, or the email was not confirmed. Create a new test user or reset the password, then try again.");
      } else if (loginMode === "signIn" && errorMessage.includes("Email not confirmed")) {
        setAuthError("Please confirm your email before logging in");
      } else if (lowerErrorMessage.includes("invalid login credentials")) {
        setAuthError("Invalid login credentials. This usually means the user does not exist, the password is wrong, or the email was not confirmed. Create a new test user or reset the password, then try again.");
      } else if (lowerErrorMessage.includes("rate limit") || lowerErrorMessage.includes("email rate limit exceeded")) {
        setAuthError("Too many email attempts. Please wait a few minutes before trying again, or continue as guest for now.");
      } else {
        setAuthError(err?.message || "Unable to authenticate right now.");
      }
    } finally {
      setIsSubmittingAuth(false);
    }
  };

  const handleResendConfirmationEmail = async () => {
    const email = loginForm.username.trim().toLowerCase();

    if (!email) {
      setAuthError("Enter your email first, then resend the confirmation link.");
      return;
    }

    setIsSubmittingAuth(true);
    setAuthError("");

    try {
      const { error } = await supabase.auth.resend({
        type: "signup",
        email,
        options: {
          emailRedirectTo: AUTH_REDIRECT_URL,
        },
      });

      if (error) throw error;

      setAuthError("Confirmation email resent. Check your inbox and spam folder.");
    } catch (err) {
      console.error("RESEND CONFIRMATION ERROR:", err);
      const lowerErrorMessage = String(err?.message || "").toLowerCase();
      if (lowerErrorMessage.includes("rate limit") || lowerErrorMessage.includes("email rate limit exceeded")) {
        setAuthError("Too many confirmation emails were requested. Please wait a few minutes, then try Resend Confirmation Email again.");
      } else {
        setAuthError(err?.message || "Could not resend confirmation email.");
      }
    } finally {
      setIsSubmittingAuth(false);
    }
  };

  const handleForgotPassword = async () => {
    const email = loginForm.username.trim().toLowerCase();

    if (!email) {
      setAuthError("Enter your email first to reset your password.");
      return;
    }

    setIsSubmittingAuth(true);
    setAuthError("");

    try {
      await supabase.auth.resetPasswordForEmail(email);
      setAuthError("Password reset email sent. Check your inbox and spam folder.");
    } catch (err) {
      console.error("PASSWORD RESET ERROR:", err);
      setAuthError(err?.message || "Unable to send password reset email.");
    } finally {
      setIsSubmittingAuth(false);
    }
  };

  // ============================================================================
  // EFFECTS - Initialization & Cleanup
  // ============================================================================

  useEffect(() => {
    return () => {
      if (transitionTimeoutRef.current) {
        clearTimeout(transitionTimeoutRef.current);
      }
      if (storeSearchTimeoutRef.current) {
        clearTimeout(storeSearchTimeoutRef.current);
      }
      stopScanner();
    };
  }, []);

  // ============================================================================
  // EFFECTS - Toast Auto-Dismiss
  // ============================================================================
  
  // New effect for toast auto-dismiss with smooth exit animation
  useEffect(() => {
    if (toast.message && !toastIsExiting) {
      const exitTimer = setTimeout(() => {
        setToastIsExiting(true);
      }, 2400); // Start exit animation at 2.4s

      const clearTimer = setTimeout(() => {
        setToast({ message: '', type: '' });
        setToastIsExiting(false);
      }, 2800); // Clear after full animation (2.4s + 0.4s fade)

      return () => {
        clearTimeout(exitTimer);
        clearTimeout(clearTimer);
      };
    }
  }, [toast.message, toastIsExiting]);

  useEffect(() => {
    fetchUserPoints();
  }, [fetchUserPoints]);

  useEffect(() => {
    let isMounted = true;

    const loadAuthProfileWithRecovery = async (user) => {
      if (!user?.id) return null;

      try {
        return await withTimeout(loadOrCreateSupabaseProfile(user), 8000, "Profile load");
      } catch (err) {
        const didProfileTimeout = String(err?.message || "")
          .toLowerCase()
          .includes("profile load timed out");

        if (!isMounted) return null;

        if (didProfileTimeout) {
          const temporaryProfile = createTemporarySupabaseProfile(user);
          setCurrentUserProfile(temporaryProfile);
          localStorage.setItem("currentUserProfile", JSON.stringify(temporaryProfile));
          setIsAuthLoading(false);
          setIsCheckingProfile(false);
          setToast({
            message: "Signed in. Profile is still syncing.",
            type: "success",
          });
          return temporaryProfile;
        }

        throw err;
      }
    };

    const bootstrapAuth = async () => {
      console.info("AUTH BOOTSTRAP START");
      setIsAuthLoading(true);

      try {
        const { data, error: sessionError } = await withTimeout(
          supabase.auth.getSession(),
          8000,
          "Session load"
        );
        if (sessionError) throw sessionError;
        if (!isMounted) return;

        const user = data?.session?.user || null;

        if (user) {
          console.info("AUTH BOOTSTRAP SESSION FOUND", {
            authUserId: user?.id || null,
          });
          setAuthUser(user);
          localStorage.removeItem("currentUserProfile");
          setCurrentUserProfile(null);
          await loadAuthProfileWithRecovery(user);
        } else {
          console.info("AUTH BOOTSTRAP NO SESSION");
          setAuthUser(null);
          loadProfileFromLocalStorage({ guestOnly: true });
        }
      } catch (err) {
        console.error("AUTH SESSION BOOTSTRAP ERROR:", err);
        if (!isMounted) return;

        const didSessionTimeout = String(err?.message || "")
          .toLowerCase()
          .includes("session load timed out");

        if (didSessionTimeout) {
          loadProfileFromLocalStorage({ guestOnly: true });
          setToast({
            message: "Session took too long to load. Try signing in again.",
            type: "error",
          });
        } else {
          setError(err?.message || "Unable to initialize authentication.");
          loadProfileFromLocalStorage({ guestOnly: true });
        }
      } finally {
        if (isMounted) {
          setIsAuthLoading(false);
          setIsCheckingProfile(false);
          setHasCompletedInitialBootstrap(true);
          console.info("AUTH BOOTSTRAP COMPLETE");
        }
      }
    };

    bootstrapAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      const user = session?.user || null;
      console.info("AUTH STATE CHANGE", {
        event: _event || null,
        authUserId: user?.id || null,
        hasSession: Boolean(session),
      });
      setAuthUser(user);

      if (user) {
        localStorage.removeItem("currentUserProfile");
        setCurrentUserProfile(null);
        loadAuthProfileWithRecovery(user).catch((err) => {
          console.error("AUTH STATE PROFILE LOAD ERROR:", err);
        });
      } else {
        loadProfileFromLocalStorage({ guestOnly: true });
      }
    });

    return () => {
      isMounted = false;
      subscription?.unsubscribe();
    };
  }, []);

  useEffect(() => {
    try {
      const savedShoppingList = localStorage.getItem("shoppingListItems");
      if (!savedShoppingList) return;
      const parsedShoppingList = JSON.parse(savedShoppingList);
      if (Array.isArray(parsedShoppingList)) {
        const normalizedShoppingList = parsedShoppingList.map(normalizeCartItemForStoreNeutral).filter(Boolean);
        setShoppingListItems(normalizedShoppingList);
      } else {
        localStorage.removeItem("shoppingListItems");
      }
    } catch (_) {
      localStorage.removeItem("shoppingListItems");
    } finally {
      setHasHydratedLocalShoppingList(true);
    }
  }, []);

  useEffect(() => {
    if (!hasHydratedLocalShoppingList) return;
    const normalizedShoppingList = shoppingListItems.map(normalizeCartItemForStoreNeutral).filter(Boolean);
    localStorage.setItem("shoppingListItems", JSON.stringify(normalizedShoppingList));
  }, [shoppingListItems, hasHydratedLocalShoppingList]);

  useEffect(() => {
    if (!hasHydratedLocalShoppingList) return;

    const canUseCloudList = Boolean(
      authUser?.id &&
      currentUserProfile?.id &&
      !currentUserProfile?.is_guest &&
      String(authUser.id) === String(currentUserProfile.id)
    );

    console.info("CLOUD ELIGIBILITY CHECK", {
      hasAuthUser: Boolean(authUser?.id),
      authUserId: authUser?.id || null,
      hasProfile: Boolean(currentUserProfile?.id),
      profileId: currentUserProfile?.id || null,
      isGuest: Boolean(currentUserProfile?.is_guest),
      idsMatch: String(authUser?.id || "") === String(currentUserProfile?.id || ""),
      canUseCloudList: canUseSavedShoppingList(),
    });

    if (!canUseCloudList) {
      cloudShoppingListLoadedForUserRef.current = null;
      cloudShoppingListReadyRef.current = false;
      setIsCloudShoppingListReady(false);
      return;
    }

    const userId = String(currentUserProfile.id);
    if (cloudShoppingListLoadedForUserRef.current === userId) {
      cloudShoppingListReadyRef.current = true;
      setIsCloudShoppingListReady(true);
      return;
    }

    cloudShoppingListReadyRef.current = false;
    setIsCloudShoppingListReady(false);

    const runLoad = async () => {
      try {
        await loadShoppingListFromCloud();
      } finally {
        cloudShoppingListLoadedForUserRef.current = userId;
        cloudShoppingListReadyRef.current = true;
        setIsCloudShoppingListReady(true);
      }
    };

    runLoad();
  }, [authUser?.id, currentUserProfile?.id, currentUserProfile?.is_guest, hasHydratedLocalShoppingList]);

  useEffect(() => {
    if (!hasCompletedInitialBootstrap) return;

    const isSignedInProfile = Boolean(authUser?.id && currentUserProfile && !currentUserProfile?.is_guest);
    if (!isSignedInProfile) return;

    if (activeScreen === "landing") {
      setActiveScreen(getSafeResumeScreen());
    }
  }, [
    hasCompletedInitialBootstrap,
    authUser?.id,
    currentUserProfile?.id,
    currentUserProfile?.is_guest,
    shoppingListItems.length,
    selectedStore?.id,
  ]);

  useEffect(() => {
    if (!hasHydratedLocalShoppingList) return;
    if (!canUseSavedShoppingList()) return;
    if (!isCloudShoppingListReady) return;
    if (shoppingListItems.length === 0 && !cloudShoppingListExplicitClearRef.current) {
      console.info("CLOUD LIST SKIPPED EMPTY INITIAL SAVE");
      return;
    }

    const timeoutId = setTimeout(() => {
      const allowEmptySave = cloudShoppingListExplicitClearRef.current && shoppingListItems.length === 0;
      const itemsToSave = latestShoppingListItemsRef.current || [];
      saveShoppingListToCloud(itemsToSave, { allowEmptySave })
        .finally(() => {
          cloudShoppingListExplicitClearRef.current = false;
        });
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [shoppingListItems, authUser?.id, currentUserProfile?.id, currentUserProfile?.is_guest, isCloudShoppingListReady, hasHydratedLocalShoppingList]);

  useEffect(() => {
    let cancelled = false;

    const refreshCartPriceInsights = async () => {
      if (!hasHydratedLocalShoppingList) return;

      const cartItems = latestShoppingListItemsRef.current || [];
      if (cartItems.length === 0) {
        setCartPriceInsightsByKey({});
        return;
      }

      try {
        const cartBarcodes = [...new Set(cartItems.map((item) => String(item?.barcode || "").trim()).filter(Boolean))];
        const cartKeys = [...new Set(cartItems.flatMap((item) => buildComparableProductKeyCandidates(item)).filter(Boolean))];
        const cartTerms = [...new Set(cartItems.flatMap((item) => [item?.product_name, item?.name, item?.brand, item?.category, item?.size_value, item?.size_unit, item?.display_size]).map(normalizeComparableText).filter(Boolean))];
        const cartLookupTerms = [...new Set(cartItems.flatMap((item) => buildComparableLookupTerms(item)))];

        const priceRows = await fetchComparableProductLocationRows({
          barcodes: cartBarcodes,
          canonicalKeys: cartKeys,
          terms: cartTerms,
          lookupTerms: cartLookupTerms,
        });

        if (cancelled) return;
        setCartPriceInsightsByKey(buildPriceObservationIndex(priceRows));
      } catch (err) {
        if (!cancelled) {
          console.warn("SHOPPING LIST PRICE INTELLIGENCE WARNING:", err?.message || err);
          setCartPriceInsightsByKey({});
        }
      }
    };

    refreshCartPriceInsights();

    return () => {
      cancelled = true;
    };
  }, [shoppingListItems, hasHydratedLocalShoppingList, selectedStore?.id]);

  useEffect(() => {
    if (!hasHydratedLocalShoppingList) return;
    if (canUseSavedShoppingList() && !isCloudShoppingListReady) return;

    const items = latestShoppingListItemsRef.current || [];
    if (!Array.isArray(items) || items.length === 0) return;

    const hasRehydratableItem = items.some((item) => Boolean(
      item?.source === "shared_catalog" ||
      item?.catalog_id ||
      item?.barcode ||
      item?.canonical_product_key ||
      item?.product_name
    ));
    if (!hasRehydratableItem) return;

    const selectedStoreId = String(selectedStore?.id || "").trim();
    const toSignature = (list) => JSON.stringify((list || []).map((item) => ({
      cart_item_id: item?.cart_item_id || null,
      id: item?.id || null,
      barcode: item?.barcode || "",
      catalog_id: item?.catalog_id || null,
      canonical_product_key: item?.canonical_product_key || null,
      offersCount: Array.isArray(item?.offers) ? item.offers.length : 0,
      cheapest_known_price: item?.cheapest_known_price ?? null,
      cheapest_known_store_name: item?.cheapest_known_store_name || null,
      price: item?.price ?? null,
      avg_price: item?.avg_price ?? null,
      price_type: item?.price_type || null,
      selected_store_location: item?.selected_store_location || null,
      cheapest_location: item?.cheapest_location || null,
      last_seen_location: item?.last_seen_location || null,
      selectedStoreId,
    })));

    const inputSignature = toSignature(items);
    if (shoppingListRehydrateSignatureRef.current === inputSignature) {
      return;
    }

    if (shoppingListRehydrateTimerRef.current) {
      clearTimeout(shoppingListRehydrateTimerRef.current);
    }

    shoppingListRehydrateTimerRef.current = setTimeout(async () => {
      if (shoppingListRehydrateInFlightRef.current) return;
      shoppingListRehydrateInFlightRef.current = true;

      try {
        const nextItems = await rehydrateShoppingListPriceIntelligence(items);
        const nextSignature = toSignature(nextItems);
        shoppingListRehydrateSignatureRef.current = nextSignature;

        if (nextSignature !== inputSignature) {
          setShoppingListItems(nextItems);
        }
      } catch (rehydrateErr) {
        console.warn("SHOPPING_LIST_REHYDRATE_WARNING:", rehydrateErr?.message || rehydrateErr);
      } finally {
        shoppingListRehydrateInFlightRef.current = false;
      }
    }, 400);

    return () => {
      if (shoppingListRehydrateTimerRef.current) {
        clearTimeout(shoppingListRehydrateTimerRef.current);
      }
    };
  }, [
    shoppingListItems,
    selectedStore?.id,
    hasHydratedLocalShoppingList,
    isCloudShoppingListReady,
    authUser?.id,
    currentUserProfile?.id,
    currentUserProfile?.is_guest,
  ]);

  useEffect(() => {
    const trimmedTerm = String(catalogSearchTerm || "").trim();
    if (trimmedTerm.length < 2) {
      setCatalogSearchResults([]);
      setCatalogSearchMessage("");
      setIsSearchingCatalog(false);
      return;
    }

    const timeoutId = setTimeout(() => {
      searchSharedCatalogItems(trimmedTerm);
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [catalogSearchTerm, selectedStore?.id]);

  // Reset shopping route when the selected store changes so stale aisle data is not shown.
  useEffect(() => {
    setShoppingMode(false);
    setActiveAisleView(null);
  }, [selectedStore?.id]);

  // Fetch product_locations for the selected store keyed by barcode.
  // This allows the route to show correct aisle data even when a cart item was
  // originally added under a different store.
  useEffect(() => {
    const storeId = selectedStore?.id;
    // Always clear the previous store's route map and loading flag immediately before fetching.
    setStoreRouteLocations({});
    setIsLoadingStoreRoute(false);
    if (!storeId) {
      return;
    }
    const barcodes = shoppingListItems
      .map((i) => String(i?.barcode || "").trim())
      .filter(Boolean);
    if (barcodes.length === 0) {
      return;
    }
    let cancelled = false;
    const fetchRouteLocations = async () => {
      setIsLoadingStoreRoute(true);
      try {
        const { data, error } = await supabase
          .from("product_locations")
          .select("barcode, aisle, section, shelf, notes, price, price_type, avg_price, confidence_score, last_confirmed_at, store_id")
          .eq("store_id", storeId)
          .in("barcode", barcodes);
        if (cancelled) return;
        if (error) {
          console.warn("[storeRoute] Failed to fetch product_locations:", error.message);
          return;
        }
        const locationMap = {};
        for (const row of (data || [])) {
          const key = String(row.barcode || "").trim();
          if (!key) continue;
          const existing = locationMap[key];
          if (!existing) {
            locationMap[key] = row;
          } else {
            const newConf = Number(row.confidence_score || 0);
            const curConf = Number(existing.confidence_score || 0);
            if (newConf > curConf) {
              locationMap[key] = row;
            } else if (newConf === curConf) {
              const newTs = row.last_confirmed_at ? new Date(row.last_confirmed_at).getTime() : 0;
              const curTs = existing.last_confirmed_at ? new Date(existing.last_confirmed_at).getTime() : 0;
              if (newTs > curTs) locationMap[key] = row;
            }
          }
        }
        setStoreRouteLocations(locationMap);
      } catch (err) {
        if (!cancelled) console.warn("[storeRoute] Unexpected error fetching product_locations:", err);
      } finally {
        if (!cancelled) setIsLoadingStoreRoute(false);
      }
    };
    fetchRouteLocations();
    return () => { cancelled = true; };
  }, [selectedStore?.id, shoppingListItems]);

  useEffect(() => {
    if (!showItemRequestModal) {
      setItemRequestSuggestions([]);
      return;
    }

    const term = itemRequestForm.product_name.trim();
    if (!term || term.length < 2) {
      setItemRequestSuggestions([]);
      return;
    }

    const timeoutId = setTimeout(async () => {
      try {
        const safeTerm = term.replace(/,/g, " ").trim();
        const wildcardTerm = `%${safeTerm}%`;

        let catalogRows = [];
        try {
          const { data, error: catalogError } = await supabase
            .from("catalog_products")
            .select("product_name, brand")
            .or(`product_name.ilike.%${safeTerm}%,brand.ilike.%${safeTerm}%`)
            .limit(8);

          if (catalogError) throw catalogError;
          catalogRows = data || [];
        } catch (catalogSearchErr) {
          console.warn("ITEM REQUEST CATALOG LOOKUP FALLBACK:", catalogSearchErr);
          const { data, error: fallbackCatalogError } = await supabase
            .from("catalog_products")
            .select("product_name, brand")
            .ilike("product_name", wildcardTerm)
            .limit(8);

          if (fallbackCatalogError) throw fallbackCatalogError;
          catalogRows = data || [];
        }

        let seedRows = [];
        try {
          const { data, error: seedError } = await supabase
            .from("seed_products")
            .select("product_name, brand")
            .or(`product_name.ilike.%${safeTerm}%,brand.ilike.%${safeTerm}%,category.ilike.%${safeTerm}%`)
            .limit(8);

          if (seedError) throw seedError;
          seedRows = data || [];
        } catch (seedSearchErr) {
          console.warn("ITEM REQUEST SEED LOOKUP FALLBACK:", seedSearchErr);
          const { data, error: fallbackSeedError } = await supabase
            .from("seed_products")
            .select("product_name, brand")
            .or(`product_name.ilike.%${safeTerm}%,category.ilike.%${safeTerm}%`)
            .limit(8);

          if (fallbackSeedError) {
            console.warn("ITEM REQUEST SEED LOOKUP FAILED", fallbackSeedError);
          }
          seedRows = data || [];
        }

        const catalogSuggestions = dedupeSuggestions(catalogRows.map(normalizeSuggestionRow));
        const seedSuggestions = dedupeSuggestions(seedRows.map(normalizeSuggestionRow));
        const localSuggestions = getLocalItemRequestSuggestions(term);

        const mergedSuggestions = dedupeSuggestions([
          ...catalogSuggestions,
          ...seedSuggestions,
          ...localSuggestions,
        ]).slice(0, 10);

        setItemRequestSuggestions(mergedSuggestions);
      } catch (err) {
        console.warn("ITEM REQUEST CATALOG LOOKUP FAILED", err);
        setItemRequestSuggestions(getLocalItemRequestSuggestions(term));
      }
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [itemRequestForm.product_name, showItemRequestModal]);

  useEffect(() => {
    const files = capturedPhotos.map((photo) => photo.file).filter(Boolean);
    const previews = capturedPhotos.map((photo) => photo.previewUrl).filter(Boolean);
    setSelectedFiles(files);
    setPreviewImages(previews);
  }, [capturedPhotos]);

  // ============================================================================
  // STORE LOGIC - Load Stores, Select/Create Store
  // ============================================================================

  const fetchStores = async () => {
    setIsLoadingStores(true);
    try {
      const { data, error: storesError } = await supabase
        .from("stores")
        .select("id, name, address, city, state")
        .order("name", { ascending: true });
      if (storesError) throw storesError;
      setStores(data || []);
    } catch (err) {
      console.error("STORES LOAD ERROR:", err);
    } finally {
      setIsLoadingStores(false);
    }
  };

  useEffect(() => {
    fetchStores();
  }, []);

  useEffect(() => {
    try {
      const savedStore = localStorage.getItem("selectedStore");
      if (!savedStore) return;
      const parsedStore = JSON.parse(savedStore);
      if (parsedStore && typeof parsedStore === "object") {
        setSelectedStore(parsedStore);
      } else {
        localStorage.removeItem("selectedStore");
        setSelectedStore(null);
      }
    } catch (_) {
      localStorage.removeItem("selectedStore");
      setSelectedStore(null);
      setIsAuthLoading(false);
      setIsCheckingProfile(false);
    }
  }, []);

  useEffect(() => {
    activeScreenRef.current = activeScreen;
    activePanelRef.current = activePanel;
  }, [activeScreen, activePanel]);

  useEffect(() => {
    const handleBack = () => {
      if (activePanel === "location") {
        setActivePanel(null);
        setActiveScreen("identify");
        return;
      }

      if (activeScreen === "identify" || activeScreen === "cart") {
        setActiveScreen("store");
        return;
      }

      if (activeScreen === "profile") {
        setActiveScreen(selectedStore ? "store" : "landing");
        return;
      }

      if (activeScreen === "store") {
        // prevent app exit behavior
        window.history.pushState(null, "", window.location.href);
      }
    };

    window.addEventListener("popstate", handleBack);

    return () => window.removeEventListener("popstate", handleBack);
  }, [activeScreen, activePanel, selectedStore]);

  const storeSearchQuery = manualStoreName.trim().toLowerCase();
  const setStoreSearchQuery = setManualStoreName;

  const combinedStoreOptions = [
    ...searchResults,
    ...nearbyStores,
    ...stores,
  ].filter((store, index, self) => {
    const key = store.google_place_id || store.id || `${store.name}-${store.address || ""}`;
    return index === self.findIndex((s) => {
      const sKey = s.google_place_id || s.id || `${s.name}-${s.address || ""}`;
      return sKey === key;
    });
  });

  const filteredStores = storeSearchQuery
    ? combinedStoreOptions.filter((s) =>
        `${s.name || ""} ${s.address || ""} ${s.city || ""} ${s.state || ""} ${s.zip || ""} ${s.postal_code || ""}`
          .toLowerCase()
          .includes(storeSearchQuery)
      )
    : nearbyStores;

  const getSafeResumeScreen = () => {
    if (shoppingListItems.length > 0) return "cart";
    if (selectedStore?.id) return "store";
    return "store";
  };

  const calculateCartTotal = (cart) => {
    return (cart || []).reduce((sum, item) => {
      const itemKey = buildComparableProductKey(item);
      const routeBarcode = String(item?.barcode || "").trim();
      const selectedStoreId = String(selectedStore?.id || "").trim();

      // Priority 1: Check offers array (from hydrated catalog items)
      const itemOffers = Array.isArray(item?.offers) ? item.offers : [];
      if (itemOffers.length > 0) {
        const bestOffer = itemOffers[0];
        const bestOfferPrice = Number(bestOffer?.price);
        if (Number.isFinite(bestOfferPrice) && bestOfferPrice > 0) {
          return sum + bestOfferPrice;
        }
      }

      // Priority 2: Use route location if in shopping mode for selected store
      if (shoppingMode && selectedStoreId && routeBarcode) {
        const routeLocation = storeRouteLocations[routeBarcode] || null;
        const locationStoreId = String(routeLocation?.store_id || "").trim();
        if (routeLocation && locationStoreId === selectedStoreId) {
          const routePrice = Number(routeLocation?.avg_price ?? routeLocation?.price);
          if (Number.isFinite(routePrice) && routePrice > 0) {
            return sum + routePrice;
          }
        }
      }

      // Priority 3: Use price index from search/compare (considers barcode, canonical key, and commodity key candidates)
      const priceInsights = getComparablePriceBucket(cartPriceInsightsByKey, item);
      const cheapestRow = priceInsights?.cheapestRow || null;
      const cheapestPrice = Number(cheapestRow?.avg_price ?? cheapestRow?.price);
      if (Number.isFinite(cheapestPrice) && cheapestPrice > 0) {
        return sum + cheapestPrice;
      }

      // Priority 4: Use last seen location or item price
      const lastSeenLocation = item?.last_seen_location || null;
      const fallbackPrice = Number(lastSeenLocation?.avg_price ?? lastSeenLocation?.price ?? item?.avg_price ?? item?.price);
      return Number.isNaN(fallbackPrice) || fallbackPrice <= 0 ? sum : sum + fallbackPrice;
    }, 0);
  };

  const shoppingListEstimatedTotal = calculateCartTotal(shoppingListItems);

  const cartComparisonBestStore = Array.isArray(cartComparison) && cartComparison.length > 0 ? cartComparison[0] : null;
  const cartComparisonBestStoreTotalItems = Number(
    cartComparisonBestStore?.total_item_count ?? cartComparisonBestStore?.total_items ?? shoppingListItems.length
  ) || shoppingListItems.length;
  const cartComparisonBestStoreCoverage = Number(
    cartComparisonBestStore?.coverage_pct ?? cartComparisonBestStore?.coverage ?? 0
  ) || 0;
  const cartComparisonWinningRows = cartComparisonBestStore
    ? Object.values(cartComparisonBestStore.itemsByKey || {}).map((entry) => ({
        product_name: entry?.cartItem?.product_name || entry?.cartItem?.name || entry?.row?.product_name || "Unknown product",
        price: Number(entry?.row?.avg_price ?? entry?.row?.price ?? 0) || null,
        price_type: entry?.row?.price_type || "each",
        aisle: entry?.row?.aisle || "",
        section: entry?.row?.section || "",
        shelf: entry?.row?.shelf || "",
        store_name: entry?.row?.store_name || entry?.row?.stores?.name || "Unknown store",
        confidence_score: Number(entry?.row?.confidence_score || 0),
        match_method: entry?.row?.match_method || "strict_identity",
      })).sort((a, b) => String(a.product_name).localeCompare(String(b.product_name), undefined, { sensitivity: "base", numeric: true }))
    : [];
  const cartComparisonAlternativeStores = Array.isArray(cartComparison)
    ? cartComparison.slice(1, 4)
    : [];
  const cartComparisonDebugKeys = shoppingListItems.flatMap((item) => buildComparableProductKeyCandidates(item));
  const cartComparisonMissingCanonicalCount = shoppingListItems.filter(
    (item) => !normalizeComparableKey(item?.canonical_product_key || item?.last_seen_location?.canonical_product_key)
  ).length;

  // smartCartItems: used for general cart display (all items, store-agnostic)
  const smartCartItems = shoppingListItems
    .map((item, originalIndex) => {
      const lastSeenLocation = item?.last_seen_location || null;
      const aisleText = String(lastSeenLocation?.aisle || "").trim();
      const confidenceScore = Number(lastSeenLocation?.confidence_score || 0);
      return {
        product_name: item?.product_name || "",
        brand: item?.brand || "",
        aisle: aisleText,
        section: lastSeenLocation?.section || "",
        shelf: lastSeenLocation?.shelf || "",
        confidence_score: Number.isFinite(confidenceScore) ? confidenceScore : 0,
        isKnownLocation: Boolean(aisleText),
        needsContribution: !aisleText,
        originalIndex,
        item,
      };
    })
    .sort((a, b) => {
      if (a.isKnownLocation !== b.isKnownLocation) {
        return a.isKnownLocation ? -1 : 1;
      }
      if (!a.isKnownLocation && !b.isKnownLocation) {
        return String(a.product_name || "").localeCompare(String(b.product_name || ""));
      }
      const confidenceDiff = Number(b.confidence_score || 0) - Number(a.confidence_score || 0);
      if (confidenceDiff !== 0) return confidenceDiff;
      return String(a.product_name || "").localeCompare(String(b.product_name || ""));
    });

  // storeScopedSmartCartItems: used for the smart shopping ROUTE.
  // Location data (aisle/section/shelf) is only trusted when item.store_id matches selectedStore.id.
  const storeScopedSmartCartItems = shoppingListItems
    .map((item, originalIndex) => {
      const barcode = String(item?.barcode || "").trim();
      const selectedStoreId = String(selectedStore?.id || "").trim();

      // Priority 1: use product_locations row fetched for the selected store —
      // but only trust it when its own store_id matches the selected store (double-check).
      const rawRouteLocation = selectedStoreId && barcode ? (storeRouteLocations[barcode] || null) : null;
      const routeLocationStoreId = String(rawRouteLocation?.store_id || "").trim();
      const routeLocation = rawRouteLocation && routeLocationStoreId === selectedStoreId ? rawRouteLocation : null;

      let aisleText = "";
      let section = "";
      let shelf = "";
      let confidenceScore = 0;

      if (routeLocation) {
        aisleText = String(routeLocation.aisle || "").trim();
        section = routeLocation.section || "";
        shelf = routeLocation.shelf || "";
        confidenceScore = Number(routeLocation.confidence_score || 0);
      }

      const knownSelectedStoreLocation = item?.selected_store_location || null;
      const knownCheapestLocation = item?.cheapest_location || null;
      const knownStorePrices = Array.isArray(item?.known_store_prices)
        ? item.known_store_prices
        : (Array.isArray(item?.all_known_store_prices) ? item.all_known_store_prices : []);
      const hasAnyComparisonContext = Boolean(
        routeLocation ||
        knownSelectedStoreLocation ||
        knownCheapestLocation ||
        knownStorePrices.length > 0 ||
        item?.last_seen_location
      );

      return {
        product_name: item?.product_name || "",
        brand: item?.brand || "",
        aisle: aisleText,
        section,
        shelf,
        confidence_score: Number.isFinite(confidenceScore) ? confidenceScore : 0,
        routeLocation,
        isKnownLocation: Boolean(routeLocation),
        hasAnyComparisonContext,
        needsContribution: !routeLocation && !hasAnyComparisonContext,
        needsSelectedStoreLocation: !routeLocation && hasAnyComparisonContext,
        originalIndex,
        item,
      };
    })
    .sort((a, b) => {
      if (a.isKnownLocation !== b.isKnownLocation) {
        return a.isKnownLocation ? -1 : 1;
      }
      if (!a.isKnownLocation && !b.isKnownLocation) {
        return String(a.product_name || "").localeCompare(String(b.product_name || ""));
      }
      const confidenceDiff = Number(b.confidence_score || 0) - Number(a.confidence_score || 0);
      if (confidenceDiff !== 0) return confidenceDiff;
      return String(a.product_name || "").localeCompare(String(b.product_name || ""));
    });

  const smartCartByAisle = storeScopedSmartCartItems.reduce((acc, smartItem) => {
    const aisleKey = smartItem.aisle || "Unknown location";
    if (!acc[aisleKey]) {
      acc[aisleKey] = [];
    }
    acc[aisleKey].push(smartItem);
    return acc;
  }, {});

  const getAisleSortCategory = (aisleLabel) => {
    const label = String(aisleLabel || "").trim().toLowerCase();
    if (label === "unknown location") return 3;
    if (label.includes("area")) return 0;
    if (/\d+/.test(label)) return 1;
    return 2;
  };

  const getAisleSortNumber = (aisleLabel) => {
    const match = String(aisleLabel || "").match(/\d+/);
    return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
  };

  const smartCartAisleGroups = Object.entries(smartCartByAisle).sort(([aisleA, itemsA], [aisleB, itemsB]) => {
    const categoryA = getAisleSortCategory(aisleA);
    const categoryB = getAisleSortCategory(aisleB);
    if (categoryA !== categoryB) return categoryA - categoryB;

    if (categoryA === 1) {
      const numberA = getAisleSortNumber(aisleA);
      const numberB = getAisleSortNumber(aisleB);
      if (numberA !== numberB) return numberA - numberB;
    }

    const maxA = Math.max(...itemsA.map((i) => Number(i.confidence_score || 0)), 0);
    const maxB = Math.max(...itemsB.map((i) => Number(i.confidence_score || 0)), 0);
    if (maxB !== maxA) return maxB - maxA;

    return String(aisleA).localeCompare(String(aisleB), undefined, { numeric: true, sensitivity: "base" });
  });

  const smartShoppingKnownAisleGroups = smartCartAisleGroups
    .filter(([aisleLabel]) => aisleLabel !== "Unknown location")
    .map(([aisleLabel, groupedItems]) => {
      const totalConfidence = groupedItems.reduce(
        (sum, smartItem) => sum + Number(smartItem.confidence_score || 0),
        0
      );
      const aisleConfidence = groupedItems.length
        ? Math.round(totalConfidence / groupedItems.length)
        : 0;

      return {
        aisleLabel,
        aisleConfidence,
        items: groupedItems,
      };
    });

  const smartShoppingItemsToLocate = storeScopedSmartCartItems.filter((smartItem) => smartItem.needsContribution);
  const smartShoppingItemsMissingSelectedStoreLocation = storeScopedSmartCartItems.filter(
    (smartItem) => smartItem.needsSelectedStoreLocation
  );
  const smartShoppingKnownItemCount = smartShoppingKnownAisleGroups.reduce(
    (sum, group) => sum + group.items.length,
    0
  );
  const smartShoppingVisibleAisleGroups = activeAisleView
    ? smartShoppingKnownAisleGroups.filter((group) => group.aisleLabel === activeAisleView)
    : smartShoppingKnownAisleGroups;
  const shoppingModeAisleLabels = smartShoppingKnownAisleGroups.map((group) => group.aisleLabel);
  const shoppingModeActiveAisleLabel = shoppingMode
    ? (activeAisleView && shoppingModeAisleLabels.includes(activeAisleView)
      ? activeAisleView
      : shoppingModeAisleLabels[0] || null)
    : null;
  const shoppingModeVisibleAisleGroups = shoppingModeActiveAisleLabel
    ? smartShoppingKnownAisleGroups.filter((group) => group.aisleLabel === shoppingModeActiveAisleLabel)
    : smartShoppingVisibleAisleGroups;
  const shoppingModeCurrentAisleIndex = shoppingModeActiveAisleLabel
    ? shoppingModeAisleLabels.indexOf(shoppingModeActiveAisleLabel)
    : -1;
  const smartShoppingNeedsLocationCount = smartShoppingItemsToLocate.length;
  const isSmartCartEmpty = desiredShoppingListItems.length === 0;
  const hasKnownSmartCartItems = smartShoppingKnownItemCount > 0;
  const hasUnknownSmartCartItems = smartShoppingNeedsLocationCount > 0;
  const hasSelectedStoreGapItems = smartShoppingItemsMissingSelectedStoreLocation.length > 0;
  const smartCartStateMessage = isSmartCartEmpty
    ? "Your desired shopping list is empty. Add items by search or manual entry."
    : hasKnownSmartCartItems && hasUnknownSmartCartItems
      ? "Some items are ready to shop. Others have no known comparison context yet."
      : hasSelectedStoreGapItems
        ? "Some items have known prices elsewhere, but not for your selected store route yet."
      : hasUnknownSmartCartItems
        ? "Some desired items are unresolved. Scan or map them to build shared intelligence."
        : "Ready to shop by aisle.";

  const startShoppingMode = () => {
    if (!selectedStore) {
      setError("Select a store first to build your route.");
      setAppScreen("store");
      return;
    }
    if (isLoadingStoreRoute) {
      setError("Loading route for this store. Try again in a moment.");
      return;
    }
    if (shoppingListItems.length === 0) {
      setError("Add items to your cart before starting a route.");
      return;
    }
    if (!shoppingModeAisleLabels.length) {
      setError("No route available for this store yet. Add or confirm item locations to build this route.");
      return;
    }
    setShoppingMode(true);
    setActiveAisleView(shoppingModeAisleLabels[0]);
  };

  const exitShoppingMode = () => {
    setShoppingMode(false);
    setActiveAisleView(null);
  };

  const goToNextAisle = () => {
    if (shoppingModeCurrentAisleIndex < shoppingModeAisleLabels.length - 1) {
      setActiveAisleView(shoppingModeAisleLabels[shoppingModeCurrentAisleIndex + 1]);
    } else {
      setShoppingMode(false);
      setActiveAisleView(null);
      setToast({ message: "Shopping route complete!", type: "success" });
    }
  };

  const normalizeMatchValue = (value) => String(value || "").trim().toLowerCase();

  const doesCartItemMatchProduct = (item, productLike) => {
    const targetKey = buildComparableProductKey(productLike);
    const itemKey = buildComparableProductKey(item);
    if (targetKey && itemKey && targetKey === itemKey) {
      return true;
    }

    const targetBarcode = String(productLike?.barcode || "").trim();
    const itemBarcode = String(item?.barcode || "").trim();
    if (targetBarcode && itemBarcode && targetBarcode === itemBarcode) {
      return true;
    }

    const targetName = normalizeComparableText(productLike?.product_name || productLike?.name);
    const targetBrand = normalizeComparableText(productLike?.brand);
    const targetSizeValue = normalizeComparableText(productLike?.size_value);
    const targetSizeUnit = normalizeComparableText(productLike?.size_unit);
    const targetDisplaySize = normalizeComparableText(productLike?.display_size);

    const itemName = normalizeComparableText(item?.product_name || item?.name);
    const itemBrand = normalizeComparableText(item?.brand);
    const itemSizeValue = normalizeComparableText(item?.size_value);
    const itemSizeUnit = normalizeComparableText(item?.size_unit);
    const itemDisplaySize = normalizeComparableText(item?.display_size);

    if (!targetName) return false;

    return (
      itemName === targetName &&
      itemBrand === targetBrand &&
      (itemSizeValue === targetSizeValue || itemDisplaySize === targetDisplaySize) &&
      itemSizeUnit === targetSizeUnit
    );
  };

  const currentProductBarcode = product?.barcode || barcode;
  const currentProductName = product?.name || "";
  const currentProductBrand = product?.brand || "";
  const isCurrentProductInCart = shoppingListItems.some((item) =>
    doesCartItemMatchProduct(item, {
      barcode: currentProductBarcode,
      product_name: currentProductName,
      brand: currentProductBrand,
    })
  );
  const effectiveScreen = activePanel === "location" ? "location" : activeScreen;

  const isUuid = (value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

  const handlePickStore = async (store) => {
    console.info("STORE SELECTED:", store);
    try {
      let resolvedStore = store;

      // If store.id is not a UUID, resolve it to a Supabase store
      if (!isUuid(store.id)) {
        // Try to find existing store by google_place_id
        if (store.google_place_id) {
          const { data: existing } = await supabase
            .from("stores")
            .select("id, name, address, city, state, latitude, longitude, google_place_id")
            .eq("google_place_id", store.google_place_id)
            .limit(1)
            .single();

          if (existing) {
            resolvedStore = existing;
          } else {
            // Insert new store
            const { data: inserted, error: insertError } = await supabase
              .from("stores")
              .insert([
                {
                  name: store.name,
                  address: store.address || null,
                  city: store.city || null,
                  state: store.state || null,
                  latitude: store.latitude || null,
                  longitude: store.longitude || null,
                  google_place_id: store.google_place_id || store.id || null,
                },
              ])
              .select("id, name, address, city, state, latitude, longitude, google_place_id")
              .single();

            if (insertError) {
              console.error("Error inserting store:", insertError);
              setError("Failed to save store");
              return;
            }
            resolvedStore = inserted;
          }
        } else {
          // No google_place_id, try to insert with store.id as google_place_id
          const { data: inserted, error: insertError } = await supabase
            .from("stores")
            .insert([
              {
                name: store.name,
                address: store.address || null,
                city: store.city || null,
                state: store.state || null,
                latitude: store.latitude || null,
                longitude: store.longitude || null,
                google_place_id: store.id || null,
              },
            ])
            .select("id, name, address, city, state, latitude, longitude, google_place_id")
            .single();

          if (insertError) {
            console.error("Error inserting store:", insertError);
            setError("Failed to save store");
            return;
          }
          resolvedStore = inserted;
        }
      }

      const storeWithAddressDetails = {
        ...store,
        ...resolvedStore,
        address: resolvedStore?.address ?? store?.address ?? null,
        city: resolvedStore?.city ?? store?.city ?? null,
        state: resolvedStore?.state ?? store?.state ?? null,
        zip: resolvedStore?.zip ?? store?.zip ?? null,
        postal_code: resolvedStore?.postal_code ?? store?.postal_code ?? null,
        latitude: resolvedStore?.latitude ?? store?.latitude ?? null,
        longitude: resolvedStore?.longitude ?? store?.longitude ?? null,
        google_place_id: resolvedStore?.google_place_id ?? store?.google_place_id ?? null,
      };

      setSelectedStore(storeWithAddressDetails);
      localStorage.setItem("selectedStore", JSON.stringify(storeWithAddressDetails));
      setManualStoreName("");
      setSearchResults([]);
      setError("");
    } catch (err) {
      console.error("Error in handlePickStore:", err);
      setError("Failed to select store");
    }
  };

  const handleCreateManualStore = async () => {
    const trimmed = manualStoreName.trim();
    if (!trimmed) {
      setError("Select or enter a store first");
      return;
    }
    console.info("STORE INSERT: creating manual store", trimmed);
    try {
      const { data, error: insertError } = await supabase
        .from("stores")
        .insert([{ name: trimmed }])
        .select("id, name, address, city, state")
        .single();
      if (insertError) {
        console.error("STORE INSERT ERROR:", insertError);
        throw insertError;
      }
      console.info("STORE INSERT SUCCESS:", data);
      setStores((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedStore(data);
      localStorage.setItem("selectedStore", JSON.stringify(data));
      setManualStoreName("");
      setError("");
    } catch (err) {
      setError(err.message || "Failed to add store");
    }
  };

  const handleDetectStore = () => {
    if (!navigator.geolocation) {
      setStoreDetectionMessage("Geolocation is not supported by this browser.");
      return;
    }
    setIsFindingNearbyStores(true);
    setIsDetectingStore(true);
    setStoreDetectionMessage("");
    setSuggestedStore(null);
    setNearbyStores([]);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        console.info("STORE NEARBY: location obtained", { latitude, longitude });
        setUserLocation({ latitude, longitude });
        try {
          const { data: fnData, error: fnError } = await supabase.functions.invoke(
            "nearby-stores",
            { body: { latitude, longitude } }
          );
          console.log("NEARBY STORES RESPONSE:", fnData);
          console.log("NEARBY STORES ERROR:", fnError);
          console.info("NEARBY STORES FN DATA:", fnData);
          console.info("NEARBY STORES FN ERROR:", fnError);
          console.info("STORE NEARBY DEBUG:", fnData?.debug);
          console.info("STORE NEARBY DEBUG FULL:", JSON.stringify(fnData?.debug, null, 2));
          if (fnError) {
            console.error("STORE NEARBY: edge function error", fnError);
            throw new Error(fnError.message || "nearby-stores function failed");
          }
          const rawStores = Array.isArray(fnData)
            ? fnData
            : Array.isArray(fnData?.stores)
            ? fnData.stores
            : [];
          console.info("STORE NEARBY: results", rawStores);
          const withDistance = rawStores
            .filter((s) => s.latitude != null && s.longitude != null)
            .map((s) => ({
              ...s,
              distance_miles: calculateDistanceMiles(latitude, longitude, s.latitude, s.longitude),
            }))
            .sort((a, b) => a.distance_miles - b.distance_miles);
          setNearbyStores(withDistance.length > 0 ? withDistance : rawStores);
          const debugError = fnData?.debug?.error;
          const debugCount = fnData?.debug?.count;
          const rawPlacesCount =
            fnData?.debug?.rawPlaceCount ??
            fnData?.debug?.rawGoogleResponse?.places?.length ??
            0;
          const googleStatus = fnData?.debug?.googleStatus;
          const googleStatusText = fnData?.debug?.googleStatusText;
          const googleBody = fnData?.debug?.googleBody;
          const googleBodyText =
            typeof googleBody === "string"
              ? googleBody
              : googleBody?.error?.message || googleBody?.message || "";
          setStoreDetectionMessage(
            rawStores.length > 0
              ? "Showing nearby stores."
              : debugError
              ? `Google Places error${googleStatus ? ` ${googleStatus}` : ""}${googleStatusText ? ` ${googleStatusText}` : ""}: ${googleBodyText || debugError}`
              : `No nearby stores returned. Count: ${debugCount ?? 0}. Raw places: ${rawPlacesCount}.`
          );
        } catch (err) {
          console.error("EDGE FUNCTION INVOKE ERROR FULL:", err);
          setError(err?.message || "Failed to call nearby-stores");
          setStoreDetectionMessage(
            `Nearby store lookup failed: ${err?.message || "unknown error"}`
          );
        } finally {
          setIsDetectingStore(false);
          setIsFindingNearbyStores(false);
        }
      },
      (err) => {
        console.warn("STORE NEARBY: geolocation error", err);
        setIsDetectingStore(false);
        setIsFindingNearbyStores(false);
        if (err.code === err.PERMISSION_DENIED) {
          setStoreDetectionMessage(
            "Location permission denied. Search or select your store manually."
          );
        } else {
          setStoreDetectionMessage("Unable to find nearby stores. Please select your store manually.");
        }
      },
      { timeout: 10000 }
    );
  };

  const calculateDistanceMiles = (lat1, lon1, lat2, lon2) => {
    const R = 3958.8; // Earth radius in miles
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  // ============================================================================
  // SCANNER LOGIC - Controls, Lifecycle, Photo Capture
  // ============================================================================

  const resetAiPhotoState = () => {
    setCapturedPhotos([]);
    setSelectedFiles([]);
    setPreviewImages([]);
    setPhotoAnalysisStatus('idle');
    setAiDebug(null);
    setAiDetectedRawText("");
    setAiDetectedPrice(null);
    setAiDetectedPriceEdited(false);
    setIsEditingDetectedPrice(false);
    setAiFieldConfidence({ size: 0, quantity: 0, price: 0 });
    setAiAutoLockedFields({ size: false, quantity: false });
    setAiUserEditedFields({ size: false, quantity: false });
    setAiIdentityConfidence(0);
    setShowAiSummaryCard(false);
    setAwaitingProductConfirmation(false);
    setOptionalBarcodeInput("");
    setShowOptionalBarcodeInput(false);
  };

  const resetContributionFlow = () => {
    setCorrectionSaved(false);
    setLocationSaved(false);
    setPriceConfirmed(false);
    setLocationConfirmationCount(0);
    setLocationConfidenceScore(0);
    setBestKnownLocation(null);
    setCorrectionForm({
      product_name: "",
      brand: "",
      category: "",
    });
    setLocationForm({
      aisle: "",
      section: "",
      shelf: "",
      notes: "",
      size_value: product?.size_value || "",
      size_unit: product?.size_unit || "",
      quantity: product?.quantity || "",
      price: "",
      price_type: "each",
      price_source: "",
      detected_price_unit: "unknown",
    });
    // New resets
    setActivePanel(null);
    setShowNextItemPrompt(false);
    setLocationPanelMode('quick');
    setLocationStep("aisle");
    setIsEggQuantityOther(false);
    resetAiPhotoState();
  };

  const stopScanner = async () => {
    scanningRef.current = false;
    setIsScanning(false);

    try {
      if (controlsRef.current) {
        controlsRef.current.stop();
        controlsRef.current = null;
      }
    } catch (err) {
      console.warn("Stop warning:", err);
    }

    try {
      if (codeReaderRef.current) {
        codeReaderRef.current.reset();
      }
    } catch (err) {
      console.warn("Reset warning:", err);
    }

    try {
      const video = videoRef.current;
      const stream = video?.srcObject;

      if (video && typeof video.pause === "function") {
        video.pause();
      }

      if (stream && typeof stream.getTracks === "function") {
        stream.getTracks().forEach((track) => track.stop());
      }

      if (video) {
        video.srcObject = null;
        video.removeAttribute("src");
        video.load?.();
      }
    } catch (err) {
      console.warn("Track cleanup warning:", err);
    }
  };

  const startLivePreview = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError("Camera is not supported in this browser. Use Upload from Gallery instead.");
      setStatus("Use Gallery Instead to continue.");
      return;
    }

    try {
      await stopScanner();
      await new Promise((resolve) => requestAnimationFrame(resolve));

      setError("");
      setStatus("Opening camera...");
      setAwaitingPhoto(true);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const devices = await ensureCamerasLoaded();
      const freshestRearCamera =
        (devices || []).find((d) => /back|rear|environment|camera 2/gi.test(d.label || "")) ||
        (devices || []).find((d) => !/front|user|selfie/gi.test(d.label || "")) ||
        (devices || [])[0] ||
        null;
      const rearDeviceId = freshestRearCamera?.deviceId || "";

      const attempts = [];
      if (rearDeviceId) {
        attempts.push({
          label: "rear-deviceId",
          constraints: {
            video: { deviceId: { exact: rearDeviceId } },
            audio: false,
          },
        });
      }
      if (selectedDeviceId && selectedDeviceId !== rearDeviceId) {
        attempts.push({
          label: "selected-deviceId",
          constraints: {
            video: { deviceId: { exact: selectedDeviceId } },
            audio: false,
          },
        });
      }

      attempts.push(
        {
          label: "facingMode-ideal-environment",
          constraints: {
            video: { facingMode: { ideal: "environment" } },
            audio: false,
          },
        },
        {
          label: "facingMode-environment",
          constraints: {
            video: { facingMode: "environment" },
            audio: false,
          },
        },
        {
          label: "video-true",
          constraints: {
            video: true,
            audio: false,
          },
        }
      );

      let stream = null;
      let successfulAttempt = null;

      for (let i = 0; i < attempts.length; i += 1) {
        const attempt = attempts[i];
        try {
          stream = await navigator.mediaDevices.getUserMedia(attempt.constraints);
          successfulAttempt = attempt;
          break;
        } catch (attemptErr) {
          console.warn(
            `LIVE PREVIEW ATTEMPT FAILED [${attempt.label}]`,
            attemptErr?.name,
            attemptErr?.message
          );
        }
      }

      if (!stream) {
        setError("Camera could not start. Use Gallery instead.");
        setStatus("Use Gallery Instead to continue.");
        return;
      }

      let video = videoRef.current;
      if (!video) {
        const mountStart = Date.now();
        while (!video && Date.now() - mountStart < 500) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          video = videoRef.current;
        }
      }

      if (!video) {
        if (typeof stream.getTracks === "function") {
          stream.getTracks().forEach((track) => track.stop());
        }
        throw new Error("Video element not ready");
      }

      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "true");
      await video.play();

      setIsScanning(true);
      setAwaitingPhoto(true);
      setStatus("Camera live. Capture a product photo.");
      setError("");
    } catch (err) {
      console.error("LIVE PREVIEW ERROR:", err);
      setError("Camera could not start. Use Gallery instead.");
      setStatus("Use Gallery Instead to continue.");
    }
  };

  // ============================================================================
  // LOCATION LOGIC - Load Best Known, Confirm, Save New Locations
  // ============================================================================

  const loadBestKnownLocation = async (scannedBarcode) => {
    if (!scannedBarcode) return null;
    if (!selectedStore) return null;

    console.info("BEST LOCATION: checking store-specific location", {
      barcode: scannedBarcode,
      store_id: selectedStore.id,
      store_name: selectedStore.name,
    });

    setIsLoadingBestLocation(true);

    try {
      const { data, error: bestLocationError } = await supabase
        .from("product_locations")
        .select(
          "id, barcode, aisle, section, shelf, notes, price, price_type, confidence_score, last_confirmed_at, source, avg_price, price_count, price_confidence"
        )
        .eq("barcode", scannedBarcode)
        .eq("store_id", selectedStore.id)
        .order("confidence_score", { ascending: false })
        .order("last_confirmed_at", { ascending: false })
        .limit(1);

      if (bestLocationError) {
        throw bestLocationError;
      }

      const bestLocationRow = data?.[0] || null;

      if (!bestLocationRow) {
        setBestKnownLocation(null);
        return null;
      }

      let countQuery = supabase
        .from("location_confirmations")
        .select("id", { count: "exact", head: true })
        .eq("barcode", scannedBarcode)
        .eq("action_type", "confirm")
        .eq("aisle", bestLocationRow.aisle)
        .eq("store_id", selectedStore.id);

      if (bestLocationRow.section === null) {
        countQuery = countQuery.is("section", null);
      } else {
        countQuery = countQuery.eq("section", bestLocationRow.section);
      }

      if (bestLocationRow.shelf === null) {
        countQuery = countQuery.is("shelf", null);
      } else {
        countQuery = countQuery.eq("shelf", bestLocationRow.shelf);
      }

      const { count, error: countError } = await countQuery;

      if (countError) {
        throw countError;
      }

      const result = {
        ...bestLocationRow,
        confirmation_count: Number(count || 0),
      };

      setBestKnownLocation(result);
      return result;
    } catch (err) {
      console.error("BEST LOCATION LOAD ERROR:", err);
      setBestKnownLocation(null);
      return null;
    } finally {
      setIsLoadingBestLocation(false);
    }
  };

  // ============================================================================
  // PRODUCT LOGIC - Load, Upload, Identify, Handle Corrections
  // ============================================================================

  const loadKnownProduct = async (scannedBarcode) => {
    if (!scannedBarcode) return null;

    try {
      let data = null;
      let productError = null;

      const isMissingOptionalColumnError = (err) => {
        const message = String(err?.message || "").toLowerCase();
        const details = String(err?.details || "").toLowerCase();
        const hint = String(err?.hint || "").toLowerCase();
        const code = String(err?.code || "").toLowerCase();
        const combined = `${message} ${details} ${hint} ${code}`;

        return (
          combined.includes("column") ||
          combined.includes("schema cache") ||
          combined.includes("does not exist") ||
          combined.includes("could not find") ||
          combined.includes("pgrst") ||
          combined.includes("42703")
        );
      };

      const preferredResult = await supabase
        .from("catalog_products")
        .select("id, barcode, product_name, image_url, verified_image_url, brand, source, size_value, size_unit, quantity, category")
        .eq("barcode", scannedBarcode)
        .maybeSingle();

      data = preferredResult.data;
      productError = preferredResult.error;

      if (productError && isMissingOptionalColumnError(productError)) {
        const fallbackResult = await supabase
          .from("catalog_products")
          .select("id, barcode, product_name, image_url, brand, source, size_value, size_unit, quantity")
          .eq("barcode", scannedBarcode)
          .maybeSingle();

        data = fallbackResult.data;
        productError = fallbackResult.error;
      }

      if (productError) {
        throw productError;
      }

      if (!data) {
        return null;
      }

      const _scannedImage = getCleanCartImageForProduct({
        verifiedImageUrl: data?.verified_image_url || null,
        existingImageUrl: data?.image_url || "",
        category: data?.category || "",
        productName: data?.product_name || "",
        brand: data?.brand || "",
      });
      return {
        catalog_id: data?.id || null,
        name: data?.product_name || "Unknown product",
        image: _scannedImage,
        image_url: data?.image_url || null,
        verified_image_url: data?.verified_image_url || null,
        cart_image_url: _scannedImage,
        raw_photo_url: data?.image_url || null,
        barcode: data?.barcode || scannedBarcode,
        brand: data?.brand || "",
        category: data?.category || "",
        size_value: data?.size_value || "",
        size_unit: data?.size_unit || "",
        quantity: data?.quantity || "",
        source: data?.source || "catalog",
      };
    } catch (err) {
      console.error("KNOWN PRODUCT LOAD ERROR:", err);
      return null;
    }
  };

  const startScanner = async () => {
    if (!selectedStore?.id) {
      setError("Select a store before scanning.");
      setStatus("Store required before scanning");
      return;
    }

    if (scanningRef.current || processingRef.current) return;

    setError("");
    setStatus("Starting scanner...");
    setProduct(null);
    setBarcode("");
    setAwaitingPhoto(false);
    setAiDebug(null);
    setSubmissionMethod("");
    resetContributionFlow();

    await stopScanner();
    await ensureCamerasLoaded();

    try {
      if (!videoRef.current) {
        throw new Error("Video element not ready");
      }

      setStatus("Opening camera...");
      codeReaderRef.current = new BrowserMultiFormatReader();
      scanningRef.current = true;
      setIsScanning(true);

      console.info("SCANNER START: decodeFromVideoDevice", {
        selectedDeviceId: selectedDeviceId || "default",
      });

      const controls = await codeReaderRef.current.decodeFromVideoDevice(
        selectedDeviceId || undefined,
        videoRef.current,
        async (result, decodeError) => {
          if (!scanningRef.current || processingRef.current) return;

          if (result) {
            const scanned = result.getText();
            console.info("SCANNER BARCODE DETECTED:", scanned);

            scanningRef.current = false;
            setBarcode(scanned);
            setStatus("Barcode detected. Checking product and best known location...");

            const [knownProduct, knownLocation] = await Promise.all([
              loadKnownProduct(scanned),
              loadBestKnownLocation(scanned),
            ]);

            if (knownProduct) {
              setProduct(knownProduct);
              setCorrectionForm({
                product_name: knownProduct.name || "",
                brand: knownProduct.brand || "",
                category: knownProduct.category || "",
              });
              setBestKnownLocation(knownLocation || null);
              setLocationForm((prev) => ({
                ...prev,
                size_value: knownProduct.size_value || "",
                size_unit: knownProduct.size_unit || "",
                quantity: knownProduct.quantity || "",
              }));

              if (knownLocation) {
                setLocationConfirmationCount(knownLocation.confirmation_count || 0);
                setLocationConfidenceScore(
                  Number(knownLocation.confidence_score || 0)
                );
                setLocationSaved(true);
                handleAddToContributionItems(knownProduct, {
                  ...knownLocation,
                  store_id: knownLocation?.store_id || selectedStore?.id || null,
                  store_name: knownLocation?.store_name || selectedStore?.name || "",
                });
                resolveUnresolvedDesiredListItemFromContribution(knownProduct, knownLocation);
              } else {
                setLocationSaved(false);
              }

              setAwaitingPhoto(false);
              setSubmissionMethod("retrieved");

              if (!knownLocation) {
                openLocationPanel();
                setLocationPanelMode("quick");
                setLocationStep("aisle");
              }

              setStatus(
                knownLocation
                  ? "Known product found. Added to scan contributions. Add to your shopping list if needed."
                  : "Known product found. Add location to contribute store intelligence."
              );
              await stopScanner();
              return;
            }

            setAwaitingPhoto(true);
            transitionTimeoutRef.current = setTimeout(() => {
              startLivePreview();
            }, 120);

            return;
          }

          if (decodeError) {
            const message = String(
              decodeError?.message || decodeError || ""
            ).toLowerCase();

            const expected =
              message.includes("not found") ||
              message.includes("no multiformat readers were able to detect") ||
              message.includes("no code found");

            if (!expected) {
              console.warn("Decode warning:", decodeError);
            }
          }
        }
      );

      controlsRef.current = controls;
      setStatus("Scanner live. Point camera at barcode.");
    } catch (err) {
      console.error("SCANNER ERROR:", err);
      setError(err.message || "Failed to start scanner");
      setStatus("Scanner failed. Check camera permission and retry.");
      await stopScanner();
    }
  };

  const capturePhotoFromLiveCamera = async () => {
    if (!videoRef.current || !canvasRef.current) {
      setError("Camera is not ready");
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video.videoWidth || !video.videoHeight) {
      setError("Camera preview is not ready yet");
      return;
    }

    if (navigator.vibrate) {
      navigator.vibrate(50);
    }

    setIsCapturingPhoto(true);
    setError("");
  console.info("CAPTURE START: live camera capture", { barcode });

    try {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Unable to access canvas context");
      }

      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", 0.92);
      });

      if (!blob) {
        throw new Error("Failed to capture photo");
      }

      console.info("CAPTURE BLOB CREATED", {
        size: blob.size,
        type: blob.type || "image/jpeg",
      });

      const file = blobToFile(blob, `camera-${Date.now()}.jpg`);
      if (!file || file.size === 0) {
        alert("Camera failed. Please try again or upload from your gallery.");
        throw new Error("Captured camera file is empty");
      }
      const previewUrl = URL.createObjectURL(blob);
      console.log("FILES RECEIVED:", [file]);
      console.log("FILE TYPES:", [file].map((f) => f.type));
      console.log("FILE SIZE:", [file].map((f) => f.size));
      setSubmissionMethod("camera");
      setCapturedPhotos((prev) => {
        if (prev.length >= MAX_PHOTOS) return prev;
        const role = getRoleByPhotoIndex(prev.length);
        return [
          ...prev,
          {
            file,
            previewUrl,
            label: `Photo ${prev.length + 1}`,
            role,
          },
        ];
      });
      const nextRoleLabel = PHOTO_ROLE_SEQUENCE[Math.min(capturedPhotos.length + 1, MAX_PHOTOS - 1)]?.label;
      setStatus(nextRoleLabel ? `Photo captured. Next: ${nextRoleLabel}.` : "Photo captured. Tap Analyze now.");
    } catch (err) {
      console.error("CAPTURE ERROR:", err);
      alert("Camera failed. Please try again or upload from your gallery.");
      setError(err.message || "Failed to capture photo");
      setStatus("Photo capture failed");
    } finally {
      setIsCapturingPhoto(false);
    }
  };

  const handlePhotoSelected = (event, source) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length === 0) {
      setStatus("No photo selected.");
      return;
    }
    console.log("FILES RECEIVED:", files);
    console.log("FILE TYPES:", files.map((f) => f.type));
    console.log("FILE SIZE:", files.map((f) => f.size));
    setSubmissionMethod(source);
    setCapturedPhotos((prev) => {
      if (prev.length >= MAX_PHOTOS) return prev;
      const slotsLeft = Math.max(MAX_PHOTOS - prev.length, 0);
      const filesToAdd = files.slice(0, slotsLeft);
      const mappedPhotos = filesToAdd.map((file, index) => {
        const absoluteIndex = prev.length + index;
        const role = getRoleByPhotoIndex(absoluteIndex);
        return {
          file,
          previewUrl: URL.createObjectURL(file),
          label: `Photo ${absoluteIndex + 1}`,
          role,
        };
      });
      return [...prev, ...mappedPhotos];
    });
    const nextRoleLabel = PHOTO_ROLE_SEQUENCE[Math.min(capturedPhotos.length + 1, MAX_PHOTOS - 1)]?.label;
    setStatus(nextRoleLabel ? `Photo added. Next: ${nextRoleLabel}.` : "Photo added. Tap Analyze now.");
  };

  const handleImageUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setStatus("Processing image...");
      handlePhotoSelected(event, "library");
    } catch (err) {
      console.error("Image upload error:", err);
      setError("Failed to process image");
    }
  };

  const readFileAsDataURL = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const analyzeAllPhotos = async (filesInput = selectedFiles) => {
    const files = (filesInput && filesInput.length > 0)
      ? filesInput
      : capturedPhotos.map((photo) => photo.file).filter(Boolean);

    if (files.length === 0) {
      alert("Camera failed. Please try again or upload from your gallery.");
      return;
    }

    processingRef.current = true;
    setPhotoAnalysisStatus('uploading');
    setError("");
    setAiDebug(null);

    const normalizedBarcode = String(barcode || "").trim();
    const productKey = normalizedBarcode || `photo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const isPhotoOnlyProduct = !normalizedBarcode;
    console.log("PHOTO-FIRST PRODUCT KEY:", productKey);
    console.log("PHOTO-FIRST HAS REAL BARCODE:", Boolean(normalizedBarcode));
    const initialSourceValue = submissionMethod === "library" ? "manual" : "camera";

    try {
      const images = await Promise.all(files.map(readFileAsDataURL));
      console.info("Prepared image payloads for analysis", { imageCount: images.length });

      // -- Upload all captured photos ------------------------------------------
      const uploadedUrls = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setStatus(`Uploading photo ${i + 1} of ${files.length}...`);

        const safeFileName = `${Date.now()}-p${i}-${file.name || "photo.jpg"}`;
        const filePath = `${productKey}/${safeFileName}`;

        const { error: uploadError } = await supabase.storage
          .from(PRODUCT_IMAGE_BUCKET)
          .upload(filePath, file, {
            cacheControl: "3600",
            upsert: true,
            contentType: file.type || "image/jpeg",
          });

        if (uploadError) throw new Error(`Upload failed (photo ${i + 1}): ${uploadError.message}`);

        const { data: publicUrlData } = supabase.storage
          .from(PRODUCT_IMAGE_BUCKET)
          .getPublicUrl(filePath);

        const imageUrl = publicUrlData?.publicUrl;
        if (!imageUrl) throw new Error(`Failed to get public URL for photo ${i + 1}`);

        uploadedUrls.push(imageUrl);
      }

      const firstImageUrl = uploadedUrls[0];

      // -- Save initial product record using first photo URL -------------------
      setStatus("Saving initial product to database...");

      let savedRow = null;
      let saveError = null;

      if (normalizedBarcode) {
        const result = await supabase
          .from("catalog_products")
          .upsert(
            [{ barcode: productKey, product_name: "Unknown product", image_url: firstImageUrl, source: initialSourceValue }],
            { onConflict: "barcode" }
          )
          .select("id, barcode, product_name, image_url, verified_image_url, brand, source, size_value, size_unit, quantity")
          .single();
        savedRow = result.data;
        saveError = result.error;
      } else {
        const result = await supabase
          .from("catalog_products")
          .insert([{ barcode: productKey, product_name: "Unknown product", image_url: firstImageUrl, source: initialSourceValue }])
          .select("id, barcode, product_name, image_url, verified_image_url, brand, source, size_value, size_unit, quantity")
          .single();
        savedRow = result.data;
        saveError = result.error;
      }

      if (saveError) throw new Error(`Database save failed: ${saveError.message}`);

      // -- Call AI identify-product as the primary analysis flow ----------------
      setPhotoAnalysisStatus('analyzing');
      setStatus(`Analyzing ${uploadedUrls.length} photo${uploadedUrls.length > 1 ? "s" : ""} with AI...`);
      console.log("PHOTO ANALYSIS USING IDENTIFY-PRODUCT PRIMARY FLOW");
      console.log("CLOUD VISION BYPASSED FOR STABILITY");

      const imageRoles = capturedPhotos
        .slice(0, files.length)
        .map((photo, index) => normalizeImageRole(photo?.role, index));

      const visionContext = null;
      const visionByRole = {};

      let aiResponse = await identifyProductFromPhoto(
        uploadedUrls,
        normalizedBarcode,
        imageRoles,
        visionContext,
        visionByRole
      );
      console.log("FULL AI RESPONSE:", aiResponse);
      
      if (aiResponse?.error) {
        const aiInvokeErrorMessage = String(
          aiResponse.error?.message || aiResponse.error?.context || JSON.stringify(aiResponse.error)
        );
        const isRecoverableEdgeInvokeError =
          /edge function returned a non-2xx status code|non-2xx|edge function/i.test(aiInvokeErrorMessage);

        if (isRecoverableEdgeInvokeError) {
          console.warn("AI invoke failed, continuing with safe fallback:", aiInvokeErrorMessage);
          aiResponse = {
            data: {
              product_name: "",
              brand: "",
              category: "",
              size_value: "",
              size_unit: "",
              quantity: "1",
              price: null,
              price_unit: "unknown",
              confidence: 0,
              size_confidence: 0,
              quantity_confidence: 0,
              price_confidence: 0,
              raw_text: "",
              error: "AI could not confidently identify the product",
            },
            error: null,
          };
        } else {
          throw new Error(`AI function failed: ${aiInvokeErrorMessage}`);
        }
      }
      
      console.log("AI RESPONSE DATA:", aiResponse?.data);
      console.log("AI RESPONSE ERROR:", aiResponse?.error);
      console.log("AI RESPONSE RESULT:", aiResponse?.data?.result);
      console.log("AI RESPONSE PRODUCT NAME CANDIDATES:", {
        product_name: aiResponse?.data?.product_name,
        name: aiResponse?.data?.name,
        result_product_name: aiResponse?.data?.result?.product_name,
        result_name: aiResponse?.data?.result?.name,
        item_name: aiResponse?.data?.item_name,
      });
      
      setAiDebug(aiResponse);

      const extractedPayload = extractAiProductData(aiResponse);
      const rawAiData = aiResponse?.data || {};
      const rawAiResult = rawAiData?.result || {};
      const rawAiNestedData = rawAiData?.data || {};

      const aiPayload = {
        ...extractedPayload,
        product_name:
          extractedPayload?.product_name ||
          rawAiData?.product_name ||
          rawAiData?.name ||
          rawAiData?.item_name ||
          rawAiNestedData?.product_name ||
          rawAiNestedData?.name ||
          rawAiNestedData?.item_name ||
          rawAiData?.output?.product_name ||
          rawAiData?.output?.name ||
          rawAiData?.output?.item_name ||
          rawAiData?.product?.name ||
          rawAiData?.product?.product_name ||
          rawAiResult?.product_name ||
          rawAiResult?.product?.name ||
          rawAiResult?.product?.product_name ||
          rawAiResult?.name ||
          "",
        brand:
          extractedPayload?.brand ||
          rawAiData?.brand ||
          rawAiNestedData?.brand ||
          rawAiData?.output?.brand ||
          rawAiData?.product?.brand ||
          rawAiResult?.brand ||
          rawAiResult?.product?.brand ||
          "",
        category:
          extractedPayload?.category ||
          rawAiData?.category ||
          rawAiNestedData?.category ||
          rawAiData?.output?.category ||
          rawAiResult?.category ||
          "",
        size_value:
          extractedPayload?.size_value ||
          rawAiData?.size_value ||
          rawAiNestedData?.size_value ||
          rawAiData?.output?.size_value ||
          rawAiData?.product?.size_value ||
          rawAiResult?.size_value ||
          rawAiData?.size?.value ||
          rawAiResult?.size?.value ||
          "",
        size_unit:
          extractedPayload?.size_unit ||
          rawAiData?.size_unit ||
          rawAiNestedData?.size_unit ||
          rawAiData?.output?.size_unit ||
          rawAiData?.product?.size_unit ||
          rawAiResult?.size_unit ||
          rawAiData?.size?.unit ||
          rawAiResult?.size?.unit ||
          "",
        quantity:
          extractedPayload?.quantity ||
          rawAiData?.quantity ||
          rawAiNestedData?.quantity ||
          rawAiData?.output?.quantity ||
          rawAiData?.product?.quantity ||
          rawAiResult?.quantity ||
          "1",
        price:
          extractedPayload?.price ??
          rawAiData?.price ??
          rawAiNestedData?.price ??
          rawAiData?.output?.price ??
          rawAiResult?.price ??
          null,
        price_unit:
          extractedPayload?.price_unit ||
          rawAiData?.price_unit ||
          rawAiNestedData?.price_unit ||
          rawAiData?.output?.price_unit ||
          rawAiResult?.price_unit ||
          "unknown",
        confidence:
          Number(
            extractedPayload?.confidence ??
            rawAiData?.confidence ??
            rawAiNestedData?.confidence ??
            rawAiResult?.confidence ??
            0
          ),
        size_confidence:
          Number(
            extractedPayload?.size_confidence ??
            rawAiData?.size_confidence ??
            rawAiNestedData?.size_confidence ??
            rawAiResult?.size_confidence ??
            0
          ),
        quantity_confidence:
          Number(
            extractedPayload?.quantity_confidence ??
            rawAiData?.quantity_confidence ??
            rawAiNestedData?.quantity_confidence ??
            rawAiResult?.quantity_confidence ??
            0
          ),
        price_confidence:
          Number(
            extractedPayload?.price_confidence ??
            rawAiData?.price_confidence ??
            rawAiNestedData?.price_confidence ??
            rawAiResult?.price_confidence ??
            0
          ),
        total_price:
          extractedPayload?.total_price ??
          rawAiData?.total_price ??
          rawAiNestedData?.total_price ??
          rawAiResult?.total_price ??
          null,
        raw_text:
          extractedPayload?.raw_text ||
          rawAiData?.raw_text ||
          rawAiNestedData?.raw_text ||
          rawAiData?.output?.raw_text ||
          rawAiData?.output_text ||
          rawAiResult?.raw_text ||
          rawAiData?.detected_text ||
          rawAiResult?.detected_text ||
          "",
        verified_image_url:
          extractedPayload?.verified_image_url ||
          rawAiData?.verified_image_url ||
          rawAiNestedData?.verified_image_url ||
          rawAiResult?.verified_image_url ||
          null,
      };
      
      console.log("NORMALIZED AI PAYLOAD AFTER FALLBACK:", aiPayload);
      console.log("IDENTIFY PRODUCT RESPONSE NORMALIZED", aiPayload);
      setAiDetectedRawText(String(aiPayload.raw_text || "").trim());

      // Structured product-name extraction from vision OCR text.
      // Uses known brand/variant/type/descriptor signals to compose a clean name.
      // Returns null when no known brand is detected so the AI result is preserved.
      const extractBrandPriorityName = (visionTextInput) => {
        const upper = String(visionTextInput || "").toUpperCase();
        if (!upper) return null;

        // Hard override requested: Listerine Freshburst should always normalize consistently.
        if (upper.includes("LISTERINE") && upper.includes("FRESHBURST")) {
          return {
            product_name: "Listerine Freshburst Antiseptic Mouthwash",
            brand: "Listerine",
            category: "Oral Care",
          };
        }

        const brandSignals = [
          { signal: "LISTERINE", label: "Listerine", category: "Oral Care" },
          { signal: "COLGATE", label: "Colgate", category: "Oral Care" },
          { signal: "CREST", label: "Crest", category: "Oral Care" },
          { signal: "SCOPE", label: "Scope", category: "Oral Care" },
          { signal: "BIOTENE", label: "Biotene", category: "Oral Care" },
          { signal: "SENSODYNE", label: "Sensodyne", category: "Oral Care" },
          { signal: "AQUAFRESH", label: "Aquafresh", category: "Oral Care" },
          { signal: "ORAL-B", label: "Oral-B", category: "Oral Care" },
        ];

        const matchedBrand = brandSignals.find((b) => upper.includes(b.signal));
        if (!matchedBrand) return null;

        const variant = upper.includes("FRESHBURST")
          ? "Freshburst"
          : upper.includes("COOL MINT")
            ? "Cool Mint"
            : upper.includes("FRESH MINT")
              ? "Fresh Mint"
              : "";

        const descriptor = upper.includes("ANTISEPTIC")
          ? "Antiseptic"
          : upper.includes("ANTIGINGIVITIS")
            ? "Antigingivitis"
            : upper.includes("ANTIPLAQUE")
              ? "Antiplaque"
              : "";

        const productType = upper.includes("MOUTHWASH")
          ? "Mouthwash"
          : upper.includes("MOUTH RINSE")
            ? "Mouth Rinse"
            : upper.includes("TOOTHPASTE")
              ? "Toothpaste"
              : "";

        const parts = [matchedBrand.label];
        if (variant) parts.push(variant);
        if (descriptor) parts.push(descriptor);
        if (productType) parts.push(productType);

        return {
          product_name: parts.join(" ").trim(),
          brand: matchedBrand.label,
          category: matchedBrand.category,
        };
      };

      const normalizeProductNameFromVisionText = (rawText, _aiPayload, _visionData) => {
        const upper = String(rawText || "").toUpperCase();
        if (!upper) return null;

        // Marketing/claims blocklist — these lines are never a product name.
        // Shared with extractLikelyProductPhraseFromRawText via closure.
        const MARKETING_CLAIM_BLOCKLIST = [
          /KILLS\s+\d{1,3}\.?\d*%/i,
          /KILLS\s+GERMS/i,
          /\bGERMS\b/i,
          /BAD\s+BREATH/i,
          /\bBREATH\b/i,
          /\bPLAQUE\b/i,
          /\bGINGIVITIS\b/i,
          /FRESHER/i,
          /CLEANER\s+MOUTH/i,
          /FRESHER\s+(AND\s+)?CLEANER/i,
          /FIGHT[S]?\s+(GERMS|PLAQUE|GINGIVITIS)/i,
          /BRUSHING\s+ALONE/i,
          /ADA\s+ACCEPTED/i,
          /AMERICAN\s+DENTAL\s+ASSOCIATION/i,
          /NO\s+BURN/i,
          /CLINICALLY\s+PROVEN/i,
          /\bACCEPTED\b.*\bDENTAL\b/i,
        ];
        const isMarketingClaimLine = (text) =>
          MARKETING_CLAIM_BLOCKLIST.some((re) => re.test(text));

        // Known brand signals
        const BRAND_SIGNALS = [
          { signal: "LISTERINE", label: "Listerine" },
          { signal: "COLGATE", label: "Colgate" },
          { signal: "CREST", label: "Crest" },
          { signal: "SCOPE", label: "Scope" },
          { signal: "BIOTENE", label: "Biotene" },
          { signal: "SENSODYNE", label: "Sensodyne" },
          { signal: "AQUAFRESH", label: "Aquafresh" },
          { signal: "ORAL-B", label: "Oral-B" },
        ];

        // Product type signals
        const TYPE_SIGNALS = [
          { signal: "MOUTHWASH", label: "Mouthwash" },
          { signal: "MOUTH RINSE", label: "Mouth Rinse" },
          { signal: "TOOTHPASTE", label: "Toothpaste" },
          { signal: "TOOTHBRUSH", label: "Toothbrush" },
          { signal: "DENTAL FLOSS", label: "Dental Floss" },
          { signal: "WHITENING STRIPS", label: "Whitening Strips" },
        ];

        // Variant/flavor signals
        const VARIANT_SIGNALS = [
          { signal: "FRESHBURST", label: "Freshburst" },
          { signal: "COOL MINT", label: "Cool Mint" },
          { signal: "FRESH MINT", label: "Fresh Mint" },
          { signal: "SPEARMINT", label: "Spearmint" },
          { signal: "ARCTIC MINT", label: "Arctic Mint" },
          { signal: "WINTERGREEN", label: "Wintergreen" },
          { signal: "PEPPERMINT", label: "Peppermint" },
          { signal: "CLEAN MINT", label: "Clean Mint" },
          { signal: "WHITENING", label: "Whitening" },
          { signal: "SENSITIVE", label: "Sensitive" },
          { signal: "ORIGINAL", label: "Original" },
          { signal: "TOTAL", label: "Total" },
        ];

        // Descriptor signals (placed between brand+variant and type)
        const DESCRIPTOR_SIGNALS = [
          { signal: "ANTISEPTIC", label: "Antiseptic" },
          { signal: "ANTIGINGIVITIS", label: "Antigingivitis" },
          { signal: "ANTIPLAQUE", label: "Antiplaque" },
          { signal: "FLUORIDE", label: "Fluoride" },
        ];

        // Prefer Google Vision logo detection as authoritative brand source
        const logoDetectedBrand =
          Array.isArray(_visionData?.logos) && _visionData.logos.length > 0
            ? String(
                _visionData.logos[0]?.description ||
                  _visionData.logos[0]?.name ||
                  _visionData.logos[0] ||
                  ""
              ).trim()
            : "";

        // Strip marketing lines from OCR before matching signals
        const cleanedUpper = String(rawText || "")
          .split(/[\n\r]+/)
          .map((l) => l.trim())
          .filter((l) => l && !isMarketingClaimLine(l))
          .join(" ")
          .toUpperCase();

        const matchedBrand = BRAND_SIGNALS.find((b) => cleanedUpper.includes(b.signal));
        if (!matchedBrand) return null; // No known brand in OCR — preserve AI result

        const brandLabel = logoDetectedBrand || matchedBrand.label;
        const variantMatch = VARIANT_SIGNALS.find((v) => cleanedUpper.includes(v.signal));
        const typeMatch = TYPE_SIGNALS.find((t) => cleanedUpper.includes(t.signal));
        const descriptorMatch = DESCRIPTOR_SIGNALS.find((d) => cleanedUpper.includes(d.signal));

        // Build: Brand [ + Variant ] [ + Descriptor ] [ + Type ]
        const parts = [brandLabel];
        if (variantMatch) parts.push(variantMatch.label);
        if (descriptorMatch) parts.push(descriptorMatch.label);
        if (typeMatch) parts.push(typeMatch.label);

        // Require at least brand + one more signal to override AI name
        if (parts.length >= 2) return parts.join(" ");
        return null;
      };

      const extractLikelyProductPhraseFromRawText = (rawText) => {
        const lines = String(rawText || "")
          .split(/[\n\r]+/)
          .map((line) => line.trim())
          .filter(Boolean);

        const blockedLine = /(\$|\bper\b|\bprice\b|\btotal\b|\bsave\b|\bcoupon\b|\bwww\.|\bhttp\b|\bbarcode\b|\bnutrition\b|\bserving\b|\bcalories\b)/i;

        // Shared marketing-claim patterns (mirrors MARKETING_CLAIM_BLOCKLIST above)
        const PHRASE_MARKETING_BLOCKLIST = [
          /KILLS\s+\d{1,3}\.?\d*%/i,
          /KILLS\s+GERMS/i,
          /\bGERMS\b/i,
          /BAD\s+BREATH/i,
          /\bBREATH\b/i,
          /\bPLAQUE\b/i,
          /\bGINGIVITIS\b/i,
          /FRESHER/i,
          /CLEANER\s+MOUTH/i,
          /FIGHT[S]?\s+(GERMS|PLAQUE|GINGIVITIS)/i,
          /BRUSHING\s+ALONE/i,
          /ADA\s+ACCEPTED/i,
          /AMERICAN\s+DENTAL\s+ASSOCIATION/i,
          /NO\s+BURN/i,
          /CLINICALLY\s+PROVEN/i,
        ];

        for (const line of lines) {
          const cleaned = line.replace(/[^\w\s&'\-]/g, " ").replace(/\s+/g, " ").trim();
          if (!cleaned || cleaned.length < 3 || cleaned.length > 80) continue;
          if (blockedLine.test(cleaned)) continue;
          if (PHRASE_MARKETING_BLOCKLIST.some((re) => re.test(cleaned))) continue;

          const words = cleaned.split(" ").filter(Boolean);
          if (words.length < 2 || words.length > 8) continue;
          return cleaned;
        }

        return "";
      };

      const inferProductNameFromAi = (payload, response) => {
        const raw = response?.data || {};
        const result = raw?.result || {};

        const candidates = [
          payload?.product_name,
          payload?.name,
          payload?.item_name,
          payload?.title,
          payload?.description,
          raw?.product_name,
          raw?.name,
          raw?.item_name,
          raw?.title,
          raw?.description,
          result?.product_name,
          result?.name,
          result?.item_name,
          result?.title,
          result?.description,
          result?.text,
          raw?.data?.product_name,
          raw?.output?.product_name,
          raw?.product?.name,
        ];

        const firstUseful = candidates
          .map((v) => String(v || "").trim())
          .find((v) => v && v.length >= 2);

        return firstUseful || "";
      };

      let normalizedProductName =
        String(aiPayload.product_name || "").trim() ||
        inferProductNameFromAi(aiPayload, aiResponse);
      let normalizedBrand = aiPayload.brand || "";
      let normalizedCategory = aiPayload.category || "";
      let normalizedSizeValue = aiPayload.size_value || "";
      let normalizedSizeUnit = aiPayload.size_unit || "";
      const normalizedQuantity = aiPayload.quantity || "1";
      let sizeConfidence = Number(aiPayload.size_confidence || 0);

      const visionData = visionContext || { text: "", labels: [], logos: [], objects: [] };

      const visionText = cleanVisionText(visionData?.text);
      if (visionText) {
        // Brand-priority pass first to avoid OCR nonsense names.
        const brandPriorityResult = extractBrandPriorityName(visionText);
        if (brandPriorityResult?.brand) {
          normalizedBrand = brandPriorityResult.brand;
        }
        if (brandPriorityResult?.category && !normalizedCategory) {
          normalizedCategory = brandPriorityResult.category;
        }
        if (brandPriorityResult?.product_name) {
          normalizedProductName = brandPriorityResult.product_name;
        } else if (!normalizedProductName) {
          // Try structured brand-signal extraction before generic raw OCR phrase fallback.
          const visionNormalized = normalizeProductNameFromVisionText(visionText, aiPayload, visionData);
          if (visionNormalized) {
            normalizedProductName = visionNormalized;
          } else {
            // Only fall back to raw text extraction when AI also returned nothing
            const visionProductName =
              extractLikelyProductPhraseFromRawText(visionText) ||
              visionText.split(/\n|\r/).map((s) => String(s || "").trim()).find(Boolean) ||
              "";
            if (visionProductName) {
              normalizedProductName = visionProductName;
            }
          }
        }
      }

      if (Array.isArray(visionData?.logos) && visionData.logos.length > 0) {
        const visionBrand = visionData.logos
          .map((logo) => String(logo?.description || logo?.name || logo || "").trim())
          .find(Boolean);
        if (visionBrand) {
          normalizedBrand = visionBrand;
        }
      }

      const ensureBrandFirstProductName = (name, brand) => {
        const cleanName = String(name || "").trim();
        const cleanBrand = String(brand || "").trim();
        if (!cleanBrand) return cleanName;
        if (!cleanName) return cleanBrand;

        const startsWithBrand = cleanName.toLowerCase().startsWith(cleanBrand.toLowerCase());
        if (startsWithBrand) return cleanName;

        // Remove duplicate brand mentions and force brand-first ordering.
        const escapedBrand = cleanBrand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const dedupedName = cleanName
          .replace(new RegExp(`\\b${escapedBrand}\\b`, "ig"), "")
          .replace(/\s+/g, " ")
          .trim();

        return dedupedName ? `${cleanBrand} ${dedupedName}` : cleanBrand;
      };

      // General rule: if we have a detected brand, product_name must be brand-first.
      if (normalizedBrand) {
        normalizedProductName = ensureBrandFirstProductName(normalizedProductName, normalizedBrand);
      }

      let normalizedDisplaySize = String(aiPayload.display_size || "").trim();
      let normalizedSecondarySizeValue = String(aiPayload.secondary_size_value || "").trim();
      let normalizedSecondarySizeUnit = String(aiPayload.secondary_size_unit || "").trim();

      const isSizeMissing = !String(normalizedSizeValue || "").trim() || !String(normalizedSizeUnit || "").trim();
      if (isSizeMissing) {
        const sizeFallback = extractFallbackSizeFromAiText(aiPayload, aiResponse);
        if (sizeFallback?.size_value && sizeFallback?.size_unit) {
          normalizedSizeValue = sizeFallback.size_value;
          normalizedSizeUnit = sizeFallback.size_unit;
          sizeConfidence = 0.75;
          if (sizeFallback.display_size) normalizedDisplaySize = sizeFallback.display_size;
          if (sizeFallback.secondary_size_value) normalizedSecondarySizeValue = sizeFallback.secondary_size_value;
          if (sizeFallback.secondary_size_unit) normalizedSecondarySizeUnit = sizeFallback.secondary_size_unit;
        }
      } else if (!normalizedDisplaySize) {
        // Build a display_size even when AI already provided size_value/size_unit
        const sizeFallback = extractFallbackSizeFromAiText(aiPayload, aiResponse);
        if (sizeFallback?.display_size) {
          normalizedDisplaySize = sizeFallback.display_size;
          if (!normalizedSecondarySizeValue && sizeFallback.secondary_size_value) {
            normalizedSecondarySizeValue = sizeFallback.secondary_size_value;
            normalizedSecondarySizeUnit = sizeFallback.secondary_size_unit;
          }
        } else {
          const unitLabel = normalizedSizeUnit === "liter" ? "L" : normalizedSizeUnit === "fl oz" ? "fl oz" : normalizedSizeUnit;
          normalizedDisplaySize = `${normalizedSizeValue} ${unitLabel}`.trim();
        }
      }

      const quantityConfidence = Number(aiPayload.quantity_confidence || 0);
      const shouldAutoLockSize = sizeConfidence >= 0.85 && normalizedSizeValue && normalizedSizeUnit;
      const normalizedQuantityForLock = String(aiPayload.quantity || "").trim() || "1";
      const shouldAutoLockQuantity = quantityConfidence >= 0.85;
      const lockedSizeValue = shouldAutoLockSize ? normalizedSizeValue : "";
      const lockedSizeUnit = shouldAutoLockSize ? normalizedSizeUnit : "";
      const lockedQuantity = shouldAutoLockQuantity ? normalizedQuantityForLock : "1";
      setAiFieldConfidence({
        size: sizeConfidence,
        quantity: quantityConfidence,
        price: Number(aiPayload.price_confidence || aiPayload.confidence || 0),
      });
      setAiAutoLockedFields({
        size: Boolean(shouldAutoLockSize),
        quantity: Boolean(shouldAutoLockQuantity),
      });
      setAiUserEditedFields({ size: false, quantity: false });
      setAiIdentityConfidence(Number(aiPayload.confidence || 0));
      const detectedPriceFromAi = extractDetectedPriceFromAi(aiPayload, aiResponse);

      const toCleanExternalImageUrl = (value) => {
        const candidate = String(value || "").trim();
        if (!candidate) return null;
        if (!/^https?:\/\//i.test(candidate)) return null;
        if (isRawUploadUrl(candidate)) return null;
        return candidate;
      };

      const safeExtractImage = (data) => {
        const candidates = [
          data?.imageUrl,
          data?.image_url,
          data?.url,
          data?.image,
          data?.link,
          data?.thumbnail,
          data?.data?.imageUrl,
          data?.data?.image_url,
          data?.data?.url,
          data?.data?.image,
          data?.result?.imageUrl,
          data?.result?.image_url,
          data?.result?.url,
          data?.result?.image,
          data?.results?.[0]?.imageUrl,
          data?.results?.[0]?.image_url,
          data?.results?.[0]?.url,
          data?.results?.[0]?.link,
          data?.items?.[0]?.imageUrl,
          data?.items?.[0]?.image_url,
          data?.items?.[0]?.url,
          data?.items?.[0]?.link,
          data?.images?.[0]?.imageUrl,
          data?.images?.[0]?.image_url,
          data?.images?.[0]?.url,
          data?.images?.[0]?.link,
        ];

        const firstValid = candidates.find(
          (candidate) =>
            typeof candidate === "string" &&
            candidate.trim().length > 0
        );

        return toCleanExternalImageUrl(firstValid);
      };

      let edgeImageUrl = null;

      try {
        console.log("IMAGE SEARCH REQUEST:", {
          productName: normalizedProductName,
          brand: normalizedBrand,
          category: normalizedCategory,
        });

        const response = await fetch(
          `${supabaseUrl}/functions/v1/search-product-image`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: supabaseAnonKey,
              Authorization: `Bearer ${supabaseAnonKey}`,
            },
            body: JSON.stringify({
              productName: normalizedProductName,
              product_name: normalizedProductName,
              brand: normalizedBrand,
              category: normalizedCategory,
              query: [normalizedBrand, normalizedProductName, normalizedCategory]
                .filter(Boolean)
                .join(" "),
            }),
          }
        );

        if (response.ok) {
          const imageResult = await response.json();

          setImageDebugResult({
            imageUrl: imageResult?.imageUrl,
            fallbackUsed: imageResult?.fallbackUsed,
            imageSearchQuery: imageResult?.imageSearchQuery,
            resultCount: imageResult?.debug?.resultCount,
            firstRawResult: imageResult?.debug?.firstRawResult,
            googleRaw: imageResult?.debug?.googleRaw,
          });

          console.log("IMAGE FUNCTION RESULT:", imageResult);

          edgeImageUrl = safeExtractImage(imageResult);
          console.log("IMAGE FUNCTION EXTRACTED URL:", edgeImageUrl);
        } else {
          console.warn("IMAGE SEARCH NON-OK:", response.status);
        }
      } catch (err) {
        console.warn("IMAGE SEARCH FAILED:", err);
      }

      const cleanVerifiedImageUrlCandidate =
        toCleanExternalImageUrl(savedRow?.verified_image_url) ||
        toCleanExternalImageUrl(aiPayload?.verified_image_url) ||
        toCleanExternalImageUrl(aiResponse?.data?.verified_image_url) ||
        toCleanExternalImageUrl(aiResponse?.data?.product_image_url) ||
        toCleanExternalImageUrl(aiResponse?.data?.image_url);

      const imageUrlToPersist =
        edgeImageUrl ||
        cleanVerifiedImageUrlCandidate ||
        null;

      let finalRow = savedRow;

      if (normalizedProductName) {
        setStatus("Updating product with AI result...");

        const baseUpdatePayload = {
          product_name: normalizedProductName,
          brand: normalizedBrand,
          size_value: normalizedSizeValue,
          size_unit: normalizedSizeUnit,
          quantity: normalizedQuantity,
          source: initialSourceValue,
        };

        const updatePayload = imageUrlToPersist
          ? { ...baseUpdatePayload, verified_image_url: imageUrlToPersist }
          : baseUpdatePayload;

        let updateResult = await supabase
          .from("catalog_products")
          .update(updatePayload)
          .eq("id", savedRow?.id)
          .select("id, barcode, product_name, image_url, verified_image_url, brand, source, size_value, size_unit, quantity")
          .single();

        if (updateResult.error && imageUrlToPersist) {
          const errorText = String(updateResult.error?.message || "").toLowerCase();
          const missingOptionalColumn =
            errorText.includes("column") ||
            errorText.includes("does not exist") ||
            errorText.includes("schema cache") ||
            errorText.includes("pgrst") ||
            errorText.includes("42703");

          if (missingOptionalColumn) {
            updateResult = await supabase
              .from("catalog_products")
              .update(baseUpdatePayload)
              .eq("id", savedRow?.id)
              .select("id, barcode, product_name, image_url, brand, source, size_value, size_unit, quantity")
              .single();
          }
        }

        const { data: updatedRow, error: updateError } = updateResult;

        if (updateError) throw new Error(`AI update failed: ${updateError.message}`);

        finalRow = {
          ...updatedRow,
          verified_image_url:
            toCleanExternalImageUrl(updatedRow?.verified_image_url) ||
            imageUrlToPersist ||
            null,
        };
        setStatus("AI identified product");
      } else {
        const rawTextCandidate = extractLikelyProductPhraseFromRawText(aiPayload.raw_text);
        normalizedProductName = rawTextCandidate
          ? "Review needed"
          : (correctionForm.product_name?.trim() || product?.name || "Unknown product");

        if (rawTextCandidate) {
          setStatus("AI found text but could not confidently name the item. Review the detected text and enter the product name.");
        } else {
          setStatus("AI could not identify the product name. Enter or correct the name below, then continue.");
        }
        setError("");
        setAwaitingProductConfirmation(true);
        setShowAiSummaryCard(false);
      }

      const persistedProductName = String(finalRow?.product_name || "").trim();
      const finalResolvedProductName =
        persistedProductName && persistedProductName.toLowerCase() !== "unknown product"
          ? persistedProductName
          : (String(normalizedProductName || "").trim() || persistedProductName || "Unknown product");

      const finalConsumerImageUrl =
        imageUrlToPersist ||
        toCleanExternalImageUrl(finalRow?.verified_image_url) ||
        toCleanExternalImageUrl(finalRow?.image_url) ||
        firstImageUrl ||
        MVP_PLACEHOLDER_IMAGE;

      const finalProduct = {
        catalog_id: finalRow?.id || savedRow?.id || null,
        name: finalResolvedProductName,
        raw_photo_url: firstImageUrl || finalRow?.image_url || null,
        image_url: firstImageUrl || finalRow?.image_url || null,
        verified_image_url: imageUrlToPersist || null,
        image: finalConsumerImageUrl,
        cart_image_url: finalConsumerImageUrl,
        barcode: normalizedBarcode || productKey,
        is_photo_only: isPhotoOnlyProduct,
        brand: finalRow?.brand || normalizedBrand || "",
        category: normalizedCategory || "",
        size_value: lockedSizeValue,
        size_unit: lockedSizeUnit,
        quantity: lockedQuantity,
        display_size: normalizedDisplaySize || "",
        secondary_size_value: normalizedSecondarySizeValue || "",
        secondary_size_unit: normalizedSecondarySizeUnit || "",
        source: finalRow?.source || initialSourceValue,
      };

      setCorrectionForm({
        product_name: finalProduct.name === "Unknown product" && aiPayload.raw_text ? "Review needed" : (finalProduct.name || ""),
        brand: finalProduct.brand || "",
        category: finalProduct.category || "",
      });
      setLocationForm((prev) => ({
        ...prev,
        size_value: lockedSizeValue,
        size_unit: lockedSizeUnit,
        quantity: lockedQuantity,
        price: detectedPriceFromAi?.cents || "",
        price_type: detectedPriceFromAi
          ? mapDetectedUnitToPriceType(detectedPriceFromAi.unit)
          : prev.price_type,
        detected_price_unit: detectedPriceFromAi?.unit || "unknown",
        price_source: detectedPriceFromAi ? "photo_sign" : "manual",
      }));

      setPriceConfirmed(Boolean(detectedPriceFromAi));
      setAiDetectedPrice(detectedPriceFromAi);
      setIsEditingDetectedPrice(false);
      setAiDetectedPriceEdited(false);

      console.log("FINAL PRODUCT IMAGE HANDOFF:", {
        edgeImageUrl,
        finalConsumerImageUrl,
      });

      console.log("IMAGE MISSION CHECK:", {
        firstImageUrl,
        savedRowImageUrl: savedRow?.image_url,
        edgeImageUrl,
        imageUrlToPersist,
        finalConsumerImageUrl,
        finalProductImage: finalProduct.image,
        finalProductCartImage: finalProduct.cart_image_url,
      });

      console.log("IMAGE PIPELINE FINAL CHECK:", {
        edgeImageUrl,
        cleanVerifiedImageUrlCandidate,
        imageUrlToPersist,
        finalRowVerifiedImage: finalRow?.verified_image_url,
        finalConsumerImageUrl,
        finalProductImage: finalProduct.image,
        finalProductCartImage: finalProduct.cart_image_url,
      });

      setProduct(finalProduct);
      if (!normalizedBarcode && finalProduct?.barcode) {
        setBarcode(finalProduct.barcode);
      }

      // Low-confidence review gate: if AI identity confidence is below 70%,
      // force the user to confirm or edit before proceeding to location entry.
      const aiConfidenceScore = Number(aiPayload.confidence || 0);
      const LOW_CONFIDENCE_THRESHOLD = 0.70;
      const isLowConfidence = aiConfidenceScore < LOW_CONFIDENCE_THRESHOLD;

      // Even at low confidence, check if strong brand signals exist in OCR —
      // the normalizeProductNameFromVisionText helper already ran, so if
      // normalizedProductName was overridden by a known brand signal we can
      // trust it, but we still surface the review UI so the user can confirm.
      if (isLowConfidence) {
        setCorrectionForm({
          product_name: finalProduct.name === "Unknown product" ? "" : (finalProduct.name || ""),
          brand: finalProduct.brand || "",
          category: finalProduct.category || "",
        });
        setAwaitingProductConfirmation(true);
        setShowAiSummaryCard(true);
        setLocationSaved(false);
        setStatus(
          `AI confidence is ${Math.round(aiConfidenceScore * 100)}%. Please review the product name, brand, and size before continuing.`
        );
        setToast({ message: "Low confidence — please review product details", type: "warning" });
        setPhotoAnalysisStatus("done");
        setAwaitingPhoto(false);
        await stopScanner();
        return;
      }

      openLocationPanel();
      setLocationPanelMode("quick");
      setLocationStep("aisle");
      setLocationSaved(false);
      setStatus("Product identified. Add item location.");
      const bestKnownLocationResult = await loadBestKnownLocation(productKey);
      if (bestKnownLocationResult) {
        setBestKnownLocation(bestKnownLocationResult);
      }
      aiAutoAddGuardRef.current = {
        fingerprint: "",
        timestamp: 0,
      };
      if (!detectedPriceFromAi) {
        setPriceConfirmed(false);
        setLocationForm((prev) => ({
          ...prev,
          price: "",
          price_source: "manual",
          detected_price_unit: "unknown",
        }));
      }
      setAwaitingProductConfirmation(false);
      setShowAiSummaryCard(false);
      setShowOptionalBarcodeInput(false);
      setOptionalBarcodeInput(normalizedBarcode || "");
      setPhotoAnalysisStatus('done');
      setToast({ message: "Product identified. Add location next.", type: "success" });

      setAwaitingPhoto(false);
      await stopScanner();
    } catch (err) {
      console.error("ANALYZE PHOTOS ERROR:", err);
      const rawMessage = String(err?.message || err || "");
      const schemaMismatchMessage =
        "Database schema mismatch: catalog_products does not have a category column. Category will remain local until schema is updated.";
      const isCategorySchemaMismatch = rawMessage.toLowerCase().includes("catalog_products.category does not exist");
      setError(isCategorySchemaMismatch ? schemaMismatchMessage : (err.message || "Something went wrong"));
      setStatus(
        isCategorySchemaMismatch
          ? "Database schema mismatch detected."
          : "Something went wrong while analyzing photos."
      );
      setPhotoAnalysisStatus('error');
    } finally {
      processingRef.current = false;
      // Revoke object URLs to free memory
      capturedPhotos.forEach((p) => {
        try { URL.revokeObjectURL(p.previewUrl); } catch {}
      });
    }
  };


  const handleUseBestKnownLocation = async () => {
    if (!barcode || !bestKnownLocation) {
      setError("No best known location is available");
      return;
    }

    if (!selectedStore) {
      setError("Select a store before confirming item location");
      return;
    }

    setIsConfirmingBestLocation(true);
    setError("");

    try {
      const aisle = normalizeOptionalText(bestKnownLocation.aisle);
      const section = normalizeOptionalText(bestKnownLocation.section);
      const shelf = normalizeOptionalText(bestKnownLocation.shelf);
      const nowIso = new Date().toISOString();

      const confirmationInsert = await tryInsertWithPayloads(
        "location_confirmations",
        [
          [
            {
              barcode,
              action_type: "confirm",
              aisle,
              section,
              shelf,
              source: "retrieval_confirmed",
              store_id: selectedStore.id,
              user_profile_id: currentUserProfile?.id || null,
              user_trust_score_at_time: currentUserProfile?.trust_score || 0,
            },
          ],
          [
            {
              barcode,
              action_type: "confirm",
              aisle,
              section,
              shelf,
              source: "retrieval_confirmed",
            },
          ],
          [
            {
              barcode,
              action_type: "confirm",
              aisle,
              section,
              shelf,
            },
          ],
        ]
      );

      if (!confirmationInsert.success) {
        throw new Error("Could not record confirmation for best known location");
      }

      let countQuery = supabase
        .from("location_confirmations")
        .select("id", { count: "exact", head: true })
        .eq("barcode", barcode)
        .eq("action_type", "confirm")
        .eq("aisle", aisle)
        .eq("store_id", selectedStore.id);

      if (section === null) {
        countQuery = countQuery.is("section", null);
      } else {
        countQuery = countQuery.eq("section", section);
      }

      if (shelf === null) {
        countQuery = countQuery.is("shelf", null);
      } else {
        countQuery = countQuery.eq("shelf", shelf);
      }

      const { count, error: countError } = await countQuery;

      if (countError) {
        throw new Error(`Could not count confirmations: ${countError.message}`);
      }

      const confirmationCount = Number(count || 0);
      const strongConfirmationCount = confirmationCount + 1;
      let confidenceScore = calculateConfidenceScore(strongConfirmationCount);

      // Apply trust weight to confidence gain, capped at 95
      const trustWeight = getTrustWeight(currentUserProfile?.trust_score || 0);
      if (trustWeight > 1) {
        const baseGain = confidenceScore - (confirmationCount > 0 ? calculateConfidenceScore(confirmationCount) : 0);
        const adjustedGain = Math.min(10, baseGain * trustWeight);
        confidenceScore = Math.min(95, (confirmationCount > 0 ? calculateConfidenceScore(confirmationCount) : 0) + adjustedGain);
      }

      let updateQuery = supabase
        .from("product_locations")
        .update({
          confidence_score: confidenceScore,
          last_confirmed_at: nowIso,
        })
        .eq("store_id", selectedStore.id);

      updateQuery = applyLocationFilters(
        updateQuery,
        barcode,
        aisle,
        section,
        shelf
      );

      const { error: updateError } = await updateQuery;

      if (updateError) {
        throw new Error(
          `Confirmation recorded but confidence update failed: ${updateError.message}`
        );
      }

      await tryInsertWithPayloads("point_events", [
        [
          {
            barcode,
            event_type: "location_confirmation",
            points: LOCATION_CONFIRMATION_POINTS,
            source: "app",
          },
        ],
        [
          {
            barcode,
            event_name: "location_confirmation",
            points: LOCATION_CONFIRMATION_POINTS,
          },
        ],
      ]);

      await fetchUserPoints();
      await updateUserTrustScore(1);

      const refreshedBestKnownLocation = {
        ...bestKnownLocation,
        confidence_score: confidenceScore,
        last_confirmed_at: nowIso,
        confirmation_count: strongConfirmationCount,
      };

      setBestKnownLocation(refreshedBestKnownLocation);
      setLocationConfirmationCount(strongConfirmationCount);
      setLocationConfidenceScore(confidenceScore);
      setLocationSaved(true);

      const locationMemory = {
        store_id: selectedStore.id,
        store_name: selectedStore.name,
        aisle,
        section,
        shelf,
        price: bestKnownLocation?.price ?? null,
        avg_price: bestKnownLocation?.avg_price ?? null,
        price_type: bestKnownLocation?.price_type || "each",
        notes: bestKnownLocation?.notes ?? "",
        updated_at: nowIso,
      };

      const locationMatchCandidate = {
        barcode,
        product_name: product?.product_name || product?.name || bestKnownLocation?.product_name || "Unknown product",
        brand: product?.brand || bestKnownLocation?.brand || "",
        size_value: product?.size_value || bestKnownLocation?.size_value || "",
        size_unit: product?.size_unit || bestKnownLocation?.size_unit || "",
        display_size: product?.display_size || bestKnownLocation?.display_size || "",
      };

      setShoppingListItems((prev) => {
        const existingIndex = prev.findIndex((item) =>
          doesCartItemMatchProduct(item, locationMatchCandidate)
        );

        if (existingIndex >= 0) {
          const next = [...prev];
          next[existingIndex] = {
            ...next[existingIndex],
            last_seen_location: locationMemory,
          };
          return next;
        }

        return [
          ...prev,
          {
            barcode,
            product_name: product?.name || "Unknown product",
            brand: product?.brand || "",
            size_value: product?.size_value || "",
            size_unit: product?.size_unit || "",
            display_size: product?.display_size || "",
            quantity: product?.quantity || "1",
            last_seen_location: locationMemory,
          },
        ];
      });

      // TODO: Future Google Maps directions hook.

      setStatus(
        `Location confirmed and added to your cart memory • ${strongConfirmationCount} ${
          strongConfirmationCount === 1 ? "confirmation" : "confirmations"
        } • confidence ${confidenceScore}%`
      );
      setToast({ message: 'Location confirmed and added to cart memory!', type: 'success' });
    } catch (err) {
      console.error("BEST LOCATION CONFIRM ERROR:", err);
      setError(err.message || "Failed to confirm best known location");
      setToast({ message: 'Failed to confirm location', type: 'error' });
    } finally {
      setIsConfirmingBestLocation(false);
    }
  };

  // ============================================================================
  // CORRECTION LOGIC - Handle Product Corrections & Updates
  // ============================================================================

  const handleSaveCorrection = async () => {
    if (!product?.barcode) {
      setError("No product available to correct");
      return;
    }

    if (!correctionForm.product_name.trim()) {
      setError("Product name is required");
      return;
    }

    setIsSavingCorrection(true);
    setError("");

    try {
      const correctedName = correctionForm.product_name.trim();
      const correctedBrand = correctionForm.brand.trim();

      const originalName = product.name || "";
      const originalBrand = product.brand || "";

      const { data: updatedRow, error: updateError } = await supabase
        .from("catalog_products")
        .update({
          product_name: correctedName,
          brand: correctedBrand,
          corrected_by_user: true,
          source: "user_corrected",
        })
        .eq("barcode", product.barcode)
        .select(
          "barcode, product_name, image_url, brand, source, corrected_by_user"
        )
        .single();

      if (updateError) {
        throw new Error(`Failed to save correction: ${updateError.message}`);
      }

      await tryInsertWithPayloads("product_corrections", [
        [
          {
            barcode: product.barcode,
            original_product_name: originalName,
            corrected_product_name: correctedName,
            original_brand: originalBrand,
            corrected_brand: correctedBrand,
            source: "user",
          },
        ],
        [
          {
            barcode: product.barcode,
            previous_product_name: originalName,
            new_product_name: correctedName,
            previous_brand: originalBrand,
            new_brand: correctedBrand,
            source: "user",
          },
        ],
        [
          {
            barcode: product.barcode,
            product_name: correctedName,
            brand: correctedBrand,
            source: "user",
          },
        ],
      ]);

      await tryInsertWithPayloads("point_events", [
        [
          {
            barcode: product.barcode,
            event_type: "product_correction",
            points: CORRECTION_SUBMISSION_POINTS,
            source: "app",
          },
        ],
        [
          {
            barcode: product.barcode,
            event_name: "product_correction",
            points: CORRECTION_SUBMISSION_POINTS,
          },
        ],
      ]);

      await fetchUserPoints();
      await updateUserTrustScore(1);

      const _correctedImage = getCleanCartImageForProduct({
        verifiedImageUrl: updatedRow?.verified_image_url || product.verified_image_url,
        existingImageUrl: updatedRow.image_url || product.image_url,
        category: updatedRow.category || product.category || "",
        productName: updatedRow.product_name || correctedName,
        brand: updatedRow.brand || correctedBrand,
      });
      const updatedProduct = {
        name: updatedRow.product_name || correctedName,
        raw_photo_url: product.raw_photo_url || updatedRow.image_url || null,
        image_url: updatedRow.image_url || product.image_url || null,
        image: _correctedImage,
        cart_image_url: _correctedImage,
        verified_image_url: updatedRow?.verified_image_url || product.verified_image_url || null,
        barcode: updatedRow.barcode || product.barcode,
        brand: updatedRow.brand || correctedBrand,
        source: updatedRow.source || "user_corrected",
      };

      setProduct(updatedProduct);
      setCorrectionSaved(true);
      setActivePanel(null);
      setStatus("Product correction saved. Review or update location.");
      setToast({ message: 'Product correction saved!', type: 'success' });
    } catch (err) {
      console.error("CORRECTION SAVE ERROR:", err);
      setError(err.message || "Failed to save correction");
      setToast({ message: 'Failed to save correction', type: 'error' });
    } finally {
      setIsSavingCorrection(false);
    }
  };

  const handleSaveLocation = async () => {
    if (!selectedStore) {
      setError("Select a store before saving item location");
      return;
    }

    if (!isUuid(selectedStore.id)) {
      setError("Store must be re-selected before saving. Tap Change Store, then select the store again.");
      setIsSavingLocation(false);
      return;
    }

    if (!locationForm.aisle.trim()) {
      setError("Enter an aisle/area or choose a quick area.");
      return;
    }

    setIsSavingLocation(true);
    setError("");

    const guideToPriceConfirmation = () => {
      openLocationPanel();
      setLocationStep("price");

      setTimeout(() => {
        if (priceConfirmationCardRef.current?.scrollIntoView) {
          priceConfirmationCardRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        if (priceInputRef.current?.focus) {
          priceInputRef.current.focus();
        }
      }, 30);
    };

    try {
      const barcodeValue =
        String(barcode || product?.barcode || "").trim() || null;
      const applyBarcodeFilter = (query) =>
        barcodeValue ? query.eq("barcode", barcodeValue) : query.is("barcode", null);

      const aisle = locationForm.aisle.trim();
      const section = normalizeOptionalText(locationForm.section);
      const shelf = normalizeOptionalText(locationForm.shelf);
      const notes = locationForm.notes.trim();
      const sizeValue = locationForm.size_value.trim();
      const sizeUnit = locationForm.size_unit.trim();
      const quantity = locationForm.quantity.trim();
      const selectedPriceSource = String(locationForm.price_source || "").trim();
      const enteredPrice = locationForm.price.trim();
      const price = enteredPrice ? Number(locationForm.price) / 100 : null;

      if (!enteredPrice && selectedPriceSource !== "missing") {
        setError("Enter a price or tap Skip price for now.");
        setIsSavingLocation(false);
        return;
      }

      if (price !== null && Number.isNaN(price)) {
        setError("Enter a valid price");
        setIsSavingLocation(false);
        return;
      }

      if (aiDetectedPrice && price !== null && !priceConfirmed) {
        setError("Confirm or edit the AI-detected price before saving.");
        guideToPriceConfirmation();
        setIsSavingLocation(false);
        return;
      }
      const selectedPriceType = locationForm.price_type || "each";
      const selectedDetectedUnit = String(locationForm.detected_price_unit || "unknown").trim();
      const weightedAreas = ["produce", "meat", "meat / poultry"];
      const aisleLower = String(aisle || "").toLowerCase();

      const finalPriceType =
        price !== null &&
        selectedPriceType === "each" &&
        weightedAreas.some((area) => aisleLower.includes(area))
          ? "per_lb"
          : selectedPriceType;
      console.info("PRICE TYPE SAVE CHECK:", {
        locationFormPriceType: locationForm.price_type,
        selectedPriceType,
        finalPriceType,
      });
      if (!["each", "per_lb", "per_oz", "per_kg"].includes(selectedPriceType)) {
        setError("Select a valid price type before saving");
        setIsSavingLocation(false);
        return;
      }
      const nowIso = new Date().toISOString();

      const { data: existingPriceRow } = await applyBarcodeFilter(
        supabase
          .from("product_locations")
          .select("avg_price, price_count")
          .eq("store_id", selectedStore.id)
      ).maybeSingle();

      const existingPriceCount = Number(existingPriceRow?.price_count || 0);
      const existingAvgPriceRaw = existingPriceRow?.avg_price;
      const existingAvgPrice = Number(existingAvgPriceRaw || 0);
      const hasPriceValue = price !== null;
      const nextPriceCount = hasPriceValue ? existingPriceCount + 1 : existingPriceCount;
      const nextAvgPrice =
        hasPriceValue
          ? existingPriceCount > 0
          ? ((existingAvgPrice * existingPriceCount) + price) / nextPriceCount
          : price
          : existingAvgPriceRaw ?? null;

      const aiConfidenceForWeight = Number(aiIdentityConfidence || 0);
      const hasPhotoEvidence =
        submissionMethod === "photo-first" || submissionMethod === "camera" || Boolean(product?.image);
      const userEditedKeyFields = Boolean(
        aiDetectedPriceEdited ||
        aiUserEditedFields?.size ||
        aiUserEditedFields?.quantity
      );

      let confirmationCountForWeight = 0;
      if (barcodeValue) {
        let preloadCountQuery = supabase
          .from("location_confirmations")
          .select("id", { count: "exact", head: true })
          .eq("barcode", barcodeValue)
          .eq("action_type", "confirm")
          .eq("aisle", aisle)
          .eq("store_id", selectedStore.id);

        if (section === null) {
          preloadCountQuery = preloadCountQuery.is("section", null);
        } else {
          preloadCountQuery = preloadCountQuery.eq("section", section);
        }

        if (shelf === null) {
          preloadCountQuery = preloadCountQuery.is("shelf", null);
        } else {
          preloadCountQuery = preloadCountQuery.eq("shelf", shelf);
        }

        const { count: preloadCount, error: preloadCountError } = await preloadCountQuery;
        if (!preloadCountError) {
          confirmationCountForWeight = Number(preloadCount || 0);
        }
      }

      const projectedConfirmationCount = barcodeValue
        ? confirmationCountForWeight + 1
        : 1;

      const weightedConfidenceScore = calculateCrowdConfidence({
        confirmationCount: projectedConfirmationCount,
        priceCount: nextPriceCount,
        source: submissionMethod || "manual",
        hasPhoto: hasPhotoEvidence,
        priceSource: selectedPriceSource,
        userEdited: userEditedKeyFields,
        aiConfidence: aiConfidenceForWeight,
        userTrustScore: currentUserProfile?.trust_score || 0,
      });

      const weightedPriceConfidence = hasPriceValue
        ? calculateCrowdConfidence({
            confirmationCount: projectedConfirmationCount,
            priceCount: nextPriceCount,
            source: submissionMethod || "manual",
            hasPhoto: hasPhotoEvidence,
            priceSource: selectedPriceSource,
            userEdited: Boolean(aiDetectedPriceEdited),
            aiConfidence: Number(aiFieldConfidence?.price || aiConfidenceForWeight || 0),
            userTrustScore: currentUserProfile?.trust_score || 0,
          })
        : 0;

      console.info("LOCATION SAVE: saving store-specific product location", {
        barcode: barcodeValue,
        store_id: selectedStore.id,
        store_name: selectedStore.name,
        aisle: locationForm.aisle.trim(),
        section: locationForm.section,
        shelf: locationForm.shelf,
      });

      let productUpdateError = null;
      if (barcodeValue || product?.catalog_id) {
        let productUpdateQuery = supabase
          .from("catalog_products")
          .update({
            size_value: sizeValue || null,
            size_unit: sizeUnit || null,
            quantity: quantity || null,
          });

        if (barcodeValue) {
          productUpdateQuery = productUpdateQuery.eq("barcode", barcodeValue);
        } else {
          productUpdateQuery = productUpdateQuery.eq("id", product?.catalog_id);
        }

        const productUpdateResult = await productUpdateQuery;
        productUpdateError = productUpdateResult.error;
      }

      if (productUpdateError) {
        throw new Error(`Could not save product size details: ${productUpdateError.message}`);
      }

      const finalizedProductForLocation = buildFinalProductObject({
        product,
        correctionForm,
        locationForm: {
          ...locationForm,
          size_value: sizeValue,
          size_unit: sizeUnit,
          quantity,
          price: enteredPrice,
          price_type: finalPriceType,
          price_source: selectedPriceSource,
          detected_price_unit: selectedDetectedUnit,
        },
        savedLocation: {
          price,
          price_type: finalPriceType,
          price_source: selectedPriceSource || null,
          price_unit_detected: selectedDetectedUnit || "unknown",
          avg_price: nextAvgPrice,
          price_count: nextPriceCount,
          price_confidence: weightedPriceConfidence,
          confidence_score: weightedConfidenceScore,
          notes: notes || null,
          source: submissionMethod || "manual",
          ai_confidence: aiConfidenceForWeight,
          photo_evidence_count: hasPhotoEvidence ? 1 : 0,
        },
        submissionMethod,
        barcodeValue,
      });
      const finalizedLocationProductKey =
        buildComparableProductKey(finalizedProductForLocation) ||
        buildComparableProductKey({
          barcode: barcodeValue,
          product_name: finalizedProductForLocation?.product_name || finalizedProductForLocation?.name || product?.name || "",
          brand: finalizedProductForLocation?.brand || product?.brand || "",
          size_value: sizeValue || finalizedProductForLocation?.size_value || "",
          size_unit: sizeUnit || finalizedProductForLocation?.size_unit || "",
          display_size: finalizedProductForLocation?.display_size || "",
        });

      console.info("LOCATION PRODUCT KEY", {
        productName: finalizedProductForLocation?.product_name || finalizedProductForLocation?.name || null,
        barcode: barcodeValue,
        productKey: finalizedLocationProductKey || null,
      });

      const locationPayload = {
        barcode: barcodeValue,
        product_name: finalizedProductForLocation?.product_name || finalizedProductForLocation?.name || product?.name || null,
        brand: finalizedProductForLocation?.brand || product?.brand || null,
        category: finalizedProductForLocation?.category || correctionForm?.category || null,
        size_value: sizeValue || finalizedProductForLocation?.size_value || null,
        size_unit: sizeUnit || finalizedProductForLocation?.size_unit || null,
        display_size: finalizedProductForLocation?.display_size || null,
        canonical_product_key: finalizedLocationProductKey || null,
        aisle,
        section,
        shelf,
        notes: notes || null,
        price,
        price_type: finalPriceType,
        avg_price: nextAvgPrice,
        price_count: nextPriceCount,
        price_confidence: weightedPriceConfidence,
        confidence_score: weightedConfidenceScore,
        source: submissionMethod || "manual",
        last_confirmed_at: nowIso,
        store_id: selectedStore.id,
        store_name: selectedStore.name,
      };

      if (selectedPriceSource) {
        locationPayload.price_source = selectedPriceSource;
      }

      if (selectedDetectedUnit && selectedDetectedUnit !== "unknown") {
        locationPayload.price_unit_detected = selectedDetectedUnit;
      }

      if (Number.isFinite(aiConfidenceForWeight)) {
        locationPayload.ai_confidence = Number(aiConfidenceForWeight.toFixed(4));
      }

      if (hasPhotoEvidence) {
        locationPayload.photo_evidence_count = 1;
      }

      let locationUpsertResult = await supabase
        .from("product_locations")
        .upsert([locationPayload], {
          onConflict: "store_id,barcode",
        })
        .select(
          "barcode, aisle, section, shelf, notes, price, price_type, source, last_confirmed_at, avg_price, price_count, price_confidence"
        )
        .single();

      const hasOptionalPriceFieldError = /price_source|price_unit_detected|ai_confidence|photo_evidence_count|last_user_trust_score|last_user|trust_score|canonical_product_key|product_name|brand|category|size_value|size_unit|display_size|store_name|column|schema cache/i.test(
        String(locationUpsertResult.error?.message || "")
      );

      if (locationUpsertResult.error && hasOptionalPriceFieldError) {
        const fallbackPayload = {
          barcode: barcodeValue,
          aisle,
          section,
          shelf,
          notes: notes || null,
          price,
          price_type: finalPriceType,
          avg_price: nextAvgPrice,
          price_count: nextPriceCount,
          price_confidence: weightedPriceConfidence,
          confidence_score: weightedConfidenceScore,
          source: submissionMethod || "manual",
          last_confirmed_at: nowIso,
          store_id: selectedStore.id,
        };

        locationUpsertResult = await supabase
          .from("product_locations")
          .upsert([fallbackPayload], {
            onConflict: "store_id,barcode",
          })
          .select(
            "barcode, aisle, section, shelf, notes, price, price_type, source, last_confirmed_at, avg_price, price_count, price_confidence"
          )
          .single();
      }

      const { data: savedLocationRow, error: locationError } = locationUpsertResult;

      if (locationError) {
        throw new Error(`Could not save location: ${locationError.message}`);
      }

      let verifyQuery = supabase
        .from("product_locations")
        .select("barcode, aisle, section, shelf, notes, price, price_type, source, last_confirmed_at, avg_price, price_count, price_confidence")
        .eq("store_id", selectedStore.id)
        .eq("barcode", barcodeValue)
        .eq("aisle", aisle)
        .order("last_confirmed_at", { ascending: false })
        .limit(1);

      if (section === null) {
        verifyQuery = verifyQuery.is("section", null);
      } else {
        verifyQuery = verifyQuery.eq("section", section);
      }

      if (shelf === null) {
        verifyQuery = verifyQuery.is("shelf", null);
      } else {
        verifyQuery = verifyQuery.eq("shelf", shelf);
      }

      const { data: verifiedRows, error: verifyError } = await verifyQuery;

      const verifiedLocationRow = Array.isArray(verifiedRows) && verifiedRows.length > 0
        ? verifiedRows[0]
        : null;

      if (verifyError) {
        console.warn("VERIFY SAVED LOCATION WARNING:", verifyError);
      }

      let confirmationCount = 0;
      let confidenceScore = weightedConfidenceScore;

      if (barcodeValue) {
        try {
          const confirmationInsert = await tryInsertWithPayloads(
            "location_confirmations",
            [
              [
                {
                  barcode: barcodeValue,
                  action_type: "confirm",
                  aisle,
                  section,
                  shelf,
                  source: submissionMethod || "manual",
                  store_id: selectedStore.id,
                  user_profile_id: currentUserProfile?.id || null,
                  user_trust_score_at_time: currentUserProfile?.trust_score || 0,
                },
              ],
              [
                {
                  barcode: barcodeValue,
                  action_type: "confirm",
                  aisle,
                  section,
                  shelf,
                  source: submissionMethod || "manual",
                },
              ],
              [
                {
                  barcode: barcodeValue,
                  action_type: "confirm",
                  aisle,
                  section,
                  shelf,
                },
              ],
            ]
          );

          if (!confirmationInsert.success) {
            console.warn("LOCATION_CONFIRMATION_INSERT_FAILED", {
              barcode: barcodeValue,
              store_id: selectedStore.id,
              aisle,
              section,
              shelf,
            });
          } else {
            let countQuery = supabase
              .from("location_confirmations")
              .select("id", { count: "exact", head: true })
              .eq("barcode", barcodeValue)
              .eq("action_type", "confirm")
              .eq("aisle", aisle)
              .eq("store_id", selectedStore.id);

            if (section === null) {
              countQuery = countQuery.is("section", null);
            } else {
              countQuery = countQuery.eq("section", section);
            }

            if (shelf === null) {
              countQuery = countQuery.is("shelf", null);
            } else {
              countQuery = countQuery.eq("shelf", shelf);
            }

            const { count, error: countError } = await countQuery;

            if (countError) {
              console.warn("LOCATION_CONFIRMATION_COUNT_FAILED", countError);
            } else {
              confirmationCount = Number(count || 0);
              confidenceScore = calculateCrowdConfidence({
                confirmationCount,
                priceCount: nextPriceCount,
                source: submissionMethod || "manual",
                hasPhoto: hasPhotoEvidence,
                priceSource: selectedPriceSource,
                userEdited: userEditedKeyFields,
                aiConfidence: aiConfidenceForWeight,
                userTrustScore: currentUserProfile?.trust_score || 0,
              });

              let updateQuery = supabase
                .from("product_locations")
                .update({
                  confidence_score: confidenceScore,
                  price_confidence: weightedPriceConfidence,
                  last_confirmed_at: nowIso,
                })
                .eq("store_id", selectedStore.id);

              updateQuery = applyLocationFilters(
                updateQuery,
                barcodeValue,
                aisle,
                section,
                shelf
              );

              const { error: updateError } = await updateQuery;

              if (updateError) {
                console.warn("LOCATION_CONFIRMATION_COUNT_FAILED", updateError);
              }
            }
          }

          await tryInsertWithPayloads("point_events", [
            [
              {
                barcode: barcodeValue,
                event_type: "location_submission",
                points: LOCATION_SUBMISSION_POINTS,
                source: "app",
              },
            ],
            [
              {
                barcode: barcodeValue,
                event_name: "location_submission",
                points: LOCATION_SUBMISSION_POINTS,
              },
            ],
          ]);
        } catch (confirmationException) {
          console.warn("LOCATION_CONFIRMATION_EXCEPTION", {
            barcode: barcodeValue,
            store_id: selectedStore.id,
            error: confirmationException?.message || confirmationException,
          });
        }
      }

      await fetchUserPoints();
      await updateUserTrustScore(2);

      const savedLocation = {
        barcode: barcodeValue,
        product_name: finalizedProductForLocation?.product_name || finalizedProductForLocation?.name || product?.name || null,
        brand: finalizedProductForLocation?.brand || product?.brand || null,
        category: finalizedProductForLocation?.category || correctionForm?.category || null,
        size_value: sizeValue || finalizedProductForLocation?.size_value || null,
        size_unit: sizeUnit || finalizedProductForLocation?.size_unit || null,
        display_size: finalizedProductForLocation?.display_size || null,
        canonical_product_key: finalizedLocationProductKey || null,
        aisle,
        section,
        shelf,
        notes: savedLocationRow?.notes ?? (notes || null),
        price: verifiedLocationRow?.price ?? savedLocationRow?.price ?? price,
        price_type: verifiedLocationRow?.price_type ?? savedLocationRow?.price_type ?? finalPriceType,
        price_source: selectedPriceSource || null,
        price_unit_detected: selectedDetectedUnit || "unknown",
        source: savedLocationRow?.source ?? (submissionMethod || "manual"),
        avg_price: verifiedLocationRow?.avg_price ?? savedLocationRow?.avg_price ?? nextAvgPrice,
        price_count: verifiedLocationRow?.price_count ?? savedLocationRow?.price_count ?? nextPriceCount,
        price_confidence: verifiedLocationRow?.price_confidence ?? savedLocationRow?.price_confidence ?? weightedPriceConfidence,
        confidence_score: confidenceScore,
        last_confirmed_at: savedLocationRow?.last_confirmed_at ?? nowIso,
        confirmation_count: confirmationCount,
        ai_confidence: aiConfidenceForWeight,
        photo_evidence_count: hasPhotoEvidence ? 1 : 0,
      };

      setBestKnownLocation(savedLocation);
      setLocationSaved(true);
      setLocationConfirmationCount(confirmationCount);
      setLocationConfidenceScore(confidenceScore);
      setActivePanel(null);

      // Use the single authoritative resolver so cart always gets cleaned data.
      const finalizedProductForCartBase = buildFinalProductObject({
        product,
        correctionForm,
        locationForm: {
          ...locationForm,
          size_value: sizeValue,
          size_unit: sizeUnit,
          quantity,
          price: enteredPrice,
          price_type: finalPriceType,
          price_source: selectedPriceSource,
          detected_price_unit: selectedDetectedUnit,
        },
        savedLocation,
        submissionMethod,
        barcodeValue,
      });
      const finalizedProductForCart = {
        ...finalizedProductForCartBase,
        cart_image_url:
          finalizedProductForCartBase?.cart_image_url ||
          product?.cart_image_url ||
          product?.image ||
          product?.image_url ||
          product?.raw_photo_url ||
          finalizedProductForLocation?.image_url ||
          null,
        image:
          finalizedProductForCartBase?.image ||
          product?.image ||
          product?.cart_image_url ||
          product?.image_url ||
          product?.raw_photo_url ||
          finalizedProductForLocation?.image_url ||
          null,
        image_url:
          finalizedProductForCartBase?.image_url ||
          product?.image_url ||
          finalizedProductForLocation?.image_url ||
          null,
        raw_photo_url:
          finalizedProductForCartBase?.raw_photo_url ||
          product?.raw_photo_url ||
          null,
        verified_image_url:
          finalizedProductForCartBase?.verified_image_url ||
          product?.verified_image_url ||
          null,
        canonical_product_key:
          savedLocation?.canonical_product_key ||
          finalizedLocationProductKey ||
          buildComparableProductKey(finalizedProductForCartBase) ||
          null,
      };

      const rawAiIdentityScore = Number(aiIdentityConfidence ?? 0);
      const normalizedAiIdentityScore = rawAiIdentityScore > 1 ? (rawAiIdentityScore / 100) : rawAiIdentityScore;
      const shouldBlockForLowAiIdentity =
        !Boolean(finalizedProductForCart?.product_identity_confirmed) &&
        normalizedAiIdentityScore < 0.7;
      if (shouldBlockForLowAiIdentity) {
        const reviewProduct = {
          ...finalizedProductForCart,
          name: "Review needed",
          product_name: "Review needed",
          needs_review: true,
          status: "needs_review",
        };

        setProduct(reviewProduct);
        setCorrectionForm((prev) => ({
          ...prev,
          product_name: String(finalizedProductForCart?.product_name || finalizedProductForCart?.name || "").trim() || "Review needed",
          brand: String(finalizedProductForCart?.brand || "").trim(),
          category: String(finalizedProductForCart?.category || "").trim(),
        }));
        setAwaitingProductConfirmation(true);
        setShowAiSummaryCard(true);
        setStatus(`AI identity confidence ${Math.round(normalizedAiIdentityScore * 100)}% is below threshold. Confirm details before cart insertion.`);
        setError("");
        setToast({ message: "Low-confidence result requires confirmation", type: "warning" });
        return;
      }

      const finalNameCandidate = String(finalizedProductForCart?.product_name || finalizedProductForCart?.name || "").trim();
      if (!isValidProductName(finalNameCandidate)) {
        const reviewProduct = {
          ...finalizedProductForCart,
          name: "Review needed",
          product_name: "Review needed",
          needs_review: true,
          status: "needs_review",
        };

        setProduct(reviewProduct);
        setCorrectionForm((prev) => ({
          ...prev,
          product_name: finalNameCandidate || "Review needed",
          brand: String(finalizedProductForCart?.brand || "").trim(),
          category: String(finalizedProductForCart?.category || "").trim(),
        }));
        setAwaitingProductConfirmation(true);
        setShowAiSummaryCard(false);
        setStatus("Review needed before adding item to cart.");
        setError("Detected product name looks invalid. Please confirm or edit before adding.");
        setToast({ message: "Review needed before cart insertion", type: "warning" });
        return;
      }

      setProduct(finalizedProductForCart);
      console.log("CART INSERT IMAGE CHECK:", {
        image: finalizedProductForCart.image,
        verified: finalizedProductForCart.verified_image_url,
        cart: finalizedProductForCart.cart_image_url,
      });
      const contributionLocation = {
        ...locationForm,
        ...savedLocation,
        store_id: selectedStore.id,
        store_name: selectedStore.name,
      };
      handleAddToContributionItems(finalizedProductForCart, contributionLocation);
      resolveUnresolvedDesiredListItemFromContribution(finalizedProductForCart, contributionLocation);

      setAwaitingProductConfirmation(false);
      setShowAiSummaryCard(false);
      setStatus("Contribution saved to shared product intelligence");
      setToast({ message: "Location saved. Confirmation will sync later.", type: "info" });
      setAppScreen("cart");
      setShowNextItemPrompt(true);
    } catch (err) {
      console.error("LOCATION SAVE ERROR:", err);
      const rawMessage = String(err?.message || err || "");
      const schemaMismatchMessage =
        "Database schema mismatch: catalog_products does not have a category column. Category will remain local until schema is updated.";
      const isCategorySchemaMismatch = rawMessage.toLowerCase().includes("catalog_products.category does not exist");
      setError(isCategorySchemaMismatch ? schemaMismatchMessage : (err.message || "Failed to save location"));
      setToast({ message: 'Failed to save location', type: 'error' });
    } finally {
      setIsSavingLocation(false);
    }
  };

  const handleStoreSearch = async (query) => {
    if (!query || query.length < 3) {
      setSearchResults([]);
      return;
    }

    try {
      console.info("STORE SEARCH: querying Google Places", query);

      const { data, error } = await supabase.functions.invoke("nearby-stores", {
        body: {
          query,
          latitude: userLocation?.latitude,
          longitude: userLocation?.longitude,
        },
      });

      if (error) {
        console.error("STORE SEARCH ERROR:", error);
        return;
      }

      if (data?.stores) {
        setSearchResults(data.stores);
      }
    } catch (err) {
      console.error("STORE SEARCH EXCEPTION:", err);
    }
  };

  const searchSharedCatalogItems = async (term) => {
    const trimmedTerm = String(term || "").trim();
    if (trimmedTerm.length < 2) {
      setCatalogSearchResults([]);
      setCatalogSearchMessage("");
      setIsSearchingCatalog(false);
      return;
    }

    setIsSearchingCatalog(true);
    setCatalogSearchMessage("");

    try {
      const safeTerm = trimmedTerm.replace(/,/g, " ").trim();
      const wildcardTerm = `%${safeTerm}%`;
      const debugEnabled = window.localStorage.getItem("mvpDebug") === "true";
      if (debugEnabled) {
        console.debug("CATALOG_SEARCH_START", { term: safeTerm });
      }

      const isMissingOptionalColumnError = (err) => {
        const message = String(err?.message || "").toLowerCase();
        const details = String(err?.details || "").toLowerCase();
        const hint = String(err?.hint || "").toLowerCase();
        const code = String(err?.code || "").toLowerCase();
        const combined = `${message} ${details} ${hint} ${code}`;
        return (
          combined.includes("column") ||
          combined.includes("schema cache") ||
          combined.includes("does not exist") ||
          combined.includes("could not find") ||
          combined.includes("pgrst") ||
          combined.includes("42703")
        );
      };

      const logCatalogSearchError = (label, errorObj) => {
        if (!errorObj) return;
        console.warn("CATALOG_SEARCH_ERROR", { label, error: errorObj });
      };

      const safeIdentityKey = (row) => {
        const barcodeKey = String(row?.barcode || "").trim();
        const canonicalKey = normalizeComparableKey(row?.canonical_product_key);
        const nameBrandKey = `${normalizeComparableText(row?.product_name)}|${normalizeComparableText(row?.brand)}`;
        return canonicalKey || (barcodeKey ? `barcode|${barcodeKey}` : nameBrandKey);
      };

      const hasPositivePrice = (row) => {
        const p = Number(row?.avg_price ?? row?.price);
        return Number.isFinite(p) && p > 0;
      };

      const buildRowMatchFallbackKey = (row) => {
        const productName = normalizeComparableText(row?.product_name);
        const brand = normalizeComparableText(row?.brand);
        const sizeValue = normalizeComparableText(row?.size_value);
        const sizeUnit = normalizeComparableText(row?.size_unit);
        const sizePair = [sizeValue, sizeUnit].filter(Boolean).join(" ").trim();
        return [productName, brand, sizePair].filter(Boolean).join("|");
      };

      const productLocationsBaseSelect = "barcode, canonical_product_key, product_name, brand, category, size_value, size_unit, display_size, store_id, store_name, aisle, section, shelf, price, avg_price, price_type, confidence_score, last_confirmed_at";

      // 1) catalog_products query FIRST (source of truth for typed search)
      const catalogMinSelect = "id, barcode, product_name, brand, image_url, source";
      const catalogEnhancedSelect = "id, barcode, product_name, brand, image_url, source, category, size_value, size_unit, quantity, display_size, verified_image_url, canonical_product_key";

      let catalogMinRows = [];
      let catalogEnhancedRows = [];

      const catalogMinQuery = await supabase
        .from("catalog_products")
        .select(catalogMinSelect)
        .or(`product_name.ilike.${wildcardTerm},brand.ilike.${wildcardTerm},barcode.ilike.${wildcardTerm}`)
        .limit(250);

      if (catalogMinQuery.error) {
        logCatalogSearchError("catalog_products_min", catalogMinQuery.error);
      } else {
        catalogMinRows = Array.isArray(catalogMinQuery.data) ? catalogMinQuery.data : [];
      }
      console.log("CATALOG_PRODUCTS_MIN_QUERY_COUNT", catalogMinRows.length);

      if (!catalogMinQuery.error) {
        const catalogEnhancedQuery = await supabase
          .from("catalog_products")
          .select(catalogEnhancedSelect)
          .or(`product_name.ilike.${wildcardTerm},brand.ilike.${wildcardTerm},barcode.ilike.${wildcardTerm},category.ilike.${wildcardTerm}`)
          .limit(250);

        if (catalogEnhancedQuery.error) {
          if (!isMissingOptionalColumnError(catalogEnhancedQuery.error)) {
            logCatalogSearchError("catalog_products_enhanced", catalogEnhancedQuery.error);
          }
          catalogEnhancedRows = [...catalogMinRows];
        } else {
          catalogEnhancedRows = Array.isArray(catalogEnhancedQuery.data)
            ? catalogEnhancedQuery.data
            : [];
        }
      } else {
        catalogEnhancedRows = [...catalogMinRows];
      }
      if (debugEnabled) {
        console.debug("CATALOG_PRODUCTS_FOUND", {
          term: safeTerm,
          count: catalogEnhancedRows.length,
          examples: catalogEnhancedRows.slice(0, 5).map((row) => ({
            product_name: row?.product_name || null,
            brand: row?.brand || null,
            barcode: row?.barcode || null,
            canonical_product_key: row?.canonical_product_key || null,
          })),
        });
      }

      // 2) product_locations lookups driven by catalog barcodes + canonical keys
      const catalogBarcodes = [...new Set(catalogEnhancedRows.map((row) => String(row?.barcode || "").trim()).filter(Boolean))];
      const catalogCanonicalKeys = [...new Set(catalogEnhancedRows.map((row) => normalizeComparableKey(row?.canonical_product_key)).filter(Boolean))];

      let locationRowsByBarcode = [];
      let productLocationsQuerySucceeded = false;
      if (catalogBarcodes.length > 0) {
        const queryByBarcode = await supabase
          .from("product_locations")
          .select(productLocationsBaseSelect)
          .in("barcode", catalogBarcodes)
          .limit(1000);
        if (queryByBarcode.error) {
          logCatalogSearchError("product_locations_by_barcode", queryByBarcode.error);
        } else {
          locationRowsByBarcode = Array.isArray(queryByBarcode.data) ? queryByBarcode.data : [];
          productLocationsQuerySucceeded = true;
        }
      }
      if (debugEnabled) {
        console.debug("PRODUCT_LOCATIONS_BY_BARCODE_FOUND", {
          barcodeCount: catalogBarcodes.length,
          rowCount: locationRowsByBarcode.length,
        });
      }

      let locationRowsByCanonical = [];
      if (catalogCanonicalKeys.length > 0) {
        const queryByCanonical = await supabase
          .from("product_locations")
          .select(productLocationsBaseSelect)
          .in("canonical_product_key", catalogCanonicalKeys)
          .limit(1000);
        if (queryByCanonical.error) {
          if (!isMissingOptionalColumnError(queryByCanonical.error)) {
            logCatalogSearchError("product_locations_by_canonical", queryByCanonical.error);
          }
        } else {
          locationRowsByCanonical = Array.isArray(queryByCanonical.data) ? queryByCanonical.data : [];
          productLocationsQuerySucceeded = true;
        }
      }
      if (debugEnabled) {
        console.debug("PRODUCT_LOCATIONS_BY_CANONICAL_FOUND", {
          canonicalKeyCount: catalogCanonicalKeys.length,
          rowCount: locationRowsByCanonical.length,
        });
      }

      // 3) existing text search fallback on product_locations
      let locationRowsByTerm = [];
      const queryByTerm = await supabase
        .from("product_locations")
        .select(productLocationsBaseSelect)
        .or(`product_name.ilike.${wildcardTerm},brand.ilike.${wildcardTerm},barcode.ilike.${wildcardTerm},category.ilike.${wildcardTerm}`)
        .limit(500);
      if (queryByTerm.error) {
        if (!isMissingOptionalColumnError(queryByTerm.error)) {
          logCatalogSearchError("product_locations_by_term", queryByTerm.error);
        }
        const fallbackTermQuery = await supabase
          .from("product_locations")
          .select("barcode, product_name, brand, store_id, store_name, aisle, section, shelf, price, avg_price, price_type, confidence_score, last_confirmed_at")
          .or(`product_name.ilike.${wildcardTerm},brand.ilike.${wildcardTerm},barcode.ilike.${wildcardTerm}`)
          .limit(500);
        if (!fallbackTermQuery.error) {
          locationRowsByTerm = Array.isArray(fallbackTermQuery.data) ? fallbackTermQuery.data : [];
          productLocationsQuerySucceeded = true;
        }
      } else {
        locationRowsByTerm = Array.isArray(queryByTerm.data) ? queryByTerm.data : [];
        productLocationsQuerySucceeded = true;
      }

      // Merge location rows (dedupe by store + identity + price)
      const mergedLocationMap = new Map();
      [...locationRowsByBarcode, ...locationRowsByCanonical, ...locationRowsByTerm].forEach((row) => {
        const rowKey = [
          String(row?.store_id || "").trim(),
          String(row?.barcode || "").trim(),
          normalizeComparableKey(row?.canonical_product_key) || "",
          normalizeComparableText(row?.product_name) || "",
          normalizeComparableText(row?.brand) || "",
          String(row?.avg_price ?? row?.price ?? "").trim(),
        ].join("|");
        if (!mergedLocationMap.has(rowKey)) {
          mergedLocationMap.set(rowKey, row);
        }
      });
      const locationRows = Array.from(mergedLocationMap.values());

      if (productLocationsQuerySucceeded && locationRows.length === 0) {
        console.warn("PRODUCT_LOCATIONS_NO_ROWS", {
          term: safeTerm,
          barcodeCount: catalogBarcodes.length,
          canonicalKeyCount: catalogCanonicalKeys.length,
        });
      }

      const catalogByBarcode = new Map();
      catalogEnhancedRows.forEach((row) => {
        const barcodeValue = String(row?.barcode || "").trim();
        if (barcodeValue) catalogByBarcode.set(barcodeValue, row);
      });

      const mergedMap = new Map();

      const findRowsForCatalogItem = (catalogRow) => {
        const targetBarcode = String(catalogRow?.barcode || "").trim();
        const targetCanonical = normalizeComparableKey(catalogRow?.canonical_product_key);
        const fallbackKey = buildRowMatchFallbackKey(catalogRow);
        const catalogCommodityKey = buildCommodityMatchKey(catalogRow);

        const barcodeMatches = targetBarcode
          ? locationRows.filter((row) => String(row?.barcode || "").trim() === targetBarcode)
          : [];
        if (barcodeMatches.length > 0) {
          return barcodeMatches;
        }

        const canonicalMatches = targetCanonical
          ? locationRows.filter((row) => normalizeComparableKey(row?.canonical_product_key) === targetCanonical)
          : [];
        if (canonicalMatches.length > 0) {
          return canonicalMatches;
        }

        const strictFallbackMatches = locationRows.filter((row) => buildRowMatchFallbackKey(row) === fallbackKey && Boolean(fallbackKey));
        if (strictFallbackMatches.length > 0) {
          return strictFallbackMatches;
        }

        if (catalogCommodityKey) {
          const commodityMatches = locationRows.filter((row) => {
            const rowCommodityKey = buildCommodityMatchKey(row);
            return rowCommodityKey && rowCommodityKey === catalogCommodityKey;
          });
          if (commodityMatches.length > 0) {
            return commodityMatches;
          }
        }

        return locationRows.filter((row) => Boolean(getProductMatchMethod(catalogRow, row)));
      };

      const buildResultFromRows = (baseRow, locationGroup = [], source = "catalog_products") => {
        const rowsByStore = {};
        locationGroup.forEach((locRow) => {
          const storeId = String(locRow?.store_id || "").trim();
          if (!storeId) return;
          if (!hasPositivePrice(locRow) && !(locRow?.aisle || locRow?.section || locRow?.shelf)) return;
          const existing = rowsByStore[storeId];
          if (!existing || isBetterPriceObservation(locRow, existing)) {
            rowsByStore[storeId] = locRow;
          }
        });

        const bestRows = Object.values(rowsByStore);
        const selectedStoreId = String(selectedStore?.id || "").trim();
        const selectedLocation = selectedStoreId ? (rowsByStore[selectedStoreId] || null) : null;

        const cheapestLocation = bestRows.reduce((current, candidate) => {
          if (!current) return candidate;
          return isBetterPriceObservation(candidate, current) ? candidate : current;
        }, null);

        const allKnownStorePrices = bestRows
          .map((storeRow) => ({
            store_id: storeRow?.store_id || null,
            store_name: storeRow?.store_name || "Unknown store",
            price: Number(storeRow?.avg_price ?? storeRow?.price ?? 0) || null,
            price_type: storeRow?.price_type || "each",
            aisle: storeRow?.aisle || "",
            section: storeRow?.section || "",
            shelf: storeRow?.shelf || "",
            confidence_score: Number(storeRow?.confidence_score || 0),
          }))
          .filter((entry) => entry.price != null && entry.price > 0)
          .sort((a, b) => {
            if (a.price !== b.price) return a.price - b.price;
            return Number(b.confidence_score || 0) - Number(a.confidence_score || 0);
          });

        const rowBarcode = String(baseRow?.barcode || "").trim();
        const catalogImageSource = rowBarcode ? catalogByBarcode.get(rowBarcode) : null;
        const imageUrl =
          baseRow?.image_url ||
          catalogImageSource?.image_url ||
          null;
        const verifiedImageUrl =
          baseRow?.verified_image_url ||
          catalogImageSource?.verified_image_url ||
          null;
        const resolvedImage =
          baseRow?.cart_image_url ||
          baseRow?.image ||
          verifiedImageUrl ||
          imageUrl ||
          baseRow?.raw_photo_url ||
          MVP_PLACEHOLDER_IMAGE;

        const cheapestKnownPrice = Number(cheapestLocation?.avg_price ?? cheapestLocation?.price ?? 0) || null;
        const knownStoreCount = new Set(allKnownStorePrices.map((entry) => String(entry?.store_id || "").trim()).filter(Boolean)).size;
        const hasSelectedStoreLocation = Boolean(
          selectedLocation?.aisle ||
          selectedLocation?.section ||
          selectedLocation?.shelf ||
          (Number(selectedLocation?.avg_price ?? selectedLocation?.price) > 0)
        );
        const hasKnownPriceAtAnotherStore = Boolean((!hasSelectedStoreLocation || Number(selectedLocation?.avg_price ?? selectedLocation?.price) <= 0) && allKnownStorePrices.length > 0);

        return {
          id: baseRow?.id || null,
          catalog_id: baseRow?.id || null,
          product_name: baseRow?.product_name || "",
          brand: baseRow?.brand || "",
          barcode: rowBarcode,
          canonical_product_key: baseRow?.canonical_product_key || null,
          category: baseRow?.category || "",
          size_value: baseRow?.size_value || "",
          size_unit: baseRow?.size_unit || "",
          display_size: baseRow?.display_size || "",
          quantity: baseRow?.quantity || "1",
          image_url: imageUrl,
          verified_image_url: verifiedImageUrl,
          cart_image_url: resolvedImage,
          raw_photo_url: baseRow?.raw_photo_url || null,
          cheapest_known_price: cheapestKnownPrice,
          cheapest_known_store_name: cheapestLocation?.store_name || null,
          cheapest_location: cheapestLocation,
          selected_store_location: selectedLocation,
          all_known_store_prices: allKnownStorePrices,
          known_store_prices: allKnownStorePrices,
          offers: allKnownStorePrices.map((entry) => ({
            store_id: entry.store_id || null,
            store_name: entry.store_name || "Unknown store",
            price: entry.price,
            avg_price: entry.price,
            price_type: entry.price_type || "each",
            aisle: entry.aisle || "",
            section: entry.section || "",
            shelf: entry.shelf || "",
            confidence_score: Number(entry.confidence_score || 0),
            updated_at: null,
            last_confirmed_at: null,
            canonical_product_key: baseRow?.canonical_product_key || null,
            barcode: rowBarcode || null,
            product_name: baseRow?.product_name || "",
            brand: baseRow?.brand || "",
            size_value: baseRow?.size_value || "",
            size_unit: baseRow?.size_unit || "",
            display_size: baseRow?.display_size || "",
          })),
          known_store_count: knownStoreCount,
          source,
          hasSelectedStoreLocation,
          hasKnownPriceAtAnotherStore,
          price: cheapestKnownPrice,
          avg_price: cheapestKnownPrice,
          price_type: cheapestLocation?.price_type || baseRow?.price_type || "each",
          confidence_score: Number(selectedLocation?.confidence_score || baseRow?.confidence_score || 0),
          aisle: selectedLocation?.aisle || baseRow?.aisle || cheapestLocation?.aisle || "",
          section: selectedLocation?.section || baseRow?.section || cheapestLocation?.section || "",
          shelf: selectedLocation?.shelf || baseRow?.shelf || cheapestLocation?.shelf || "",
        };
      };

      // Build results from catalog rows first, then enrich with matching location rows.
      catalogEnhancedRows.forEach((row) => {
        const groupKey = safeIdentityKey(row);
        const linkedLocationRows = findRowsForCatalogItem(row);
        const nextResult = buildResultFromRows(row, linkedLocationRows, "catalog_products");
        mergedMap.set(groupKey, nextResult);

        if (debugEnabled) {
          console.debug("CATALOG_RESULT_ENRICHED", {
            product_name: nextResult?.product_name || null,
            barcode: nextResult?.barcode || null,
            catalog_id: nextResult?.catalog_id || null,
            locationRowCount: linkedLocationRows.length,
            cheapest_known_price: nextResult?.cheapest_known_price ?? null,
            cheapest_known_store_name: nextResult?.cheapest_known_store_name || null,
            selected_store_location: nextResult?.selected_store_location || null,
            cheapest_location: nextResult?.cheapest_location || null,
          });
        }
      });

      // Keep location-only results as fallback so existing behavior remains intact.
      locationRows.forEach((locRow) => {
        const locKey = safeIdentityKey(locRow);
        if (mergedMap.has(locKey)) return;
        const fallbackResult = buildResultFromRows(locRow, [locRow], "product_locations");
        mergedMap.set(locKey, fallbackResult);
      });

      const mergedResults = Array.from(mergedMap.values()).sort((a, b) => {
        if (a.hasSelectedStoreLocation !== b.hasSelectedStoreLocation) {
          return a.hasSelectedStoreLocation ? -1 : 1;
        }
        if (a.cheapest_known_price != null && b.cheapest_known_price != null && a.cheapest_known_price !== b.cheapest_known_price) {
          return a.cheapest_known_price - b.cheapest_known_price;
        }
        return String(a?.product_name || "").localeCompare(String(b?.product_name || ""), undefined, {
          sensitivity: "base",
          numeric: true,
        });
      });

      if (window.localStorage.getItem("mvpDebug") === "true") {
        console.debug("CATALOG_SEARCH_WITH_LOCATION_INTELLIGENCE", {
          searchTerm: safeTerm,
          catalogRows: catalogEnhancedRows.length,
          productLocationRows: locationRows.length,
          enrichedResults: mergedResults.map((r) => ({
            product_name: r.product_name,
            brand: r.brand,
            known_store_count: r.known_store_count,
            cheapest_known_price: r.cheapest_known_price,
            cheapest_known_store_name: r.cheapest_known_store_name,
            hasSelectedStoreLocation: r.hasSelectedStoreLocation,
            hasKnownPriceAtAnotherStore: r.hasKnownPriceAtAnotherStore,
          })),
        });
      }

      setCatalogSearchResults(mergedResults);
      setCatalogSearchMessage(
        mergedResults.length > 0
          ? ""
          : (locationRows.length === 0 && catalogMinRows.length === 0 ? "No catalog matches yet." : "")
      );
    } catch (err) {
      console.warn("CATALOG_SEARCH_ERROR", { label: "searchSharedCatalogItems.catch", error: err });
      setCatalogSearchResults([]);
      setCatalogSearchMessage("No catalog matches yet.");
    } finally {
      setIsSearchingCatalog(false);
    }
  };

  const canUseSavedShoppingList = () => {
    return Boolean(
      authUser?.id &&
      currentUserProfile?.id &&
      !currentUserProfile?.is_guest &&
      String(authUser.id) === String(currentUserProfile.id)
    );
  };

  const isAuthDebugBannerEnabled = Boolean(
    import.meta.env.DEV || window.localStorage.getItem("mvpDebug") === "true"
  );

  const renderAuthDebugBanner = () => {
    if (!isAuthDebugBannerEnabled) return null;

    const hasAuthUser = Boolean(authUser?.id);
    const hasProfile = Boolean(currentUserProfile?.id);
    const isGuest = Boolean(currentUserProfile?.is_guest);
    const idsMatch = String(authUser?.id || "") === String(currentUserProfile?.id || "");
    const canUseCloudList = canUseSavedShoppingList();

    return (
      <div style={{
        marginBottom: 12,
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid #cbd5e1",
        background: "#f8fafc",
        color: "#0f172a",
        fontSize: 12,
        lineHeight: 1.5,
      }}>
        <div style={{ fontWeight: 900, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4 }}>Auth Debug</div>
        <div>authUser present: {hasAuthUser ? "yes" : "no"}</div>
        <div>profile present: {hasProfile ? "yes" : "no"}</div>
        <div>guest: {isGuest ? "yes" : "no"}</div>
        <div>cloud eligible: {canUseCloudList ? "yes" : "no"}</div>
        <div>ids match: {idsMatch ? "yes" : "no"}</div>
        <div>activeScreen: {activeScreen}</div>
      </div>
    );
  };

  const normalizeCartItemForStoreNeutral = (item) => {
    if (!item || typeof item !== "object") return null;

    const existingLastSeen = item.last_seen_location && typeof item.last_seen_location === "object"
      ? { ...item.last_seen_location }
      : null;
    const hadStoreSpecificFields = Boolean(
      item.store_id ||
      item.store_name ||
      item.aisle ||
      item.section ||
      item.shelf ||
      item.price != null ||
      item.avg_price != null ||
      item.price_type ||
      item.price_source ||
      item.price_unit_detected ||
      item.confidence_score != null
    );

    const lastSeen = existingLastSeen ? { ...existingLastSeen } : null;
    if (hadStoreSpecificFields) {
      const nextLastSeen = lastSeen || {};
      if (item.store_id != null && nextLastSeen.store_id == null) nextLastSeen.store_id = item.store_id;
      if (item.store_name != null && nextLastSeen.store_name == null) nextLastSeen.store_name = item.store_name;
      if (item.aisle != null && nextLastSeen.aisle == null) nextLastSeen.aisle = item.aisle;
      if (item.section != null && nextLastSeen.section == null) nextLastSeen.section = item.section;
      if (item.shelf != null && nextLastSeen.shelf == null) nextLastSeen.shelf = item.shelf;
      if (item.price != null && nextLastSeen.price == null) nextLastSeen.price = item.price;
      if (item.avg_price != null && nextLastSeen.avg_price == null) nextLastSeen.avg_price = item.avg_price;
      if (item.price_type != null && nextLastSeen.price_type == null) nextLastSeen.price_type = item.price_type;
      if (item.price_source != null && nextLastSeen.price_source == null) nextLastSeen.price_source = item.price_source;
      if (item.price_unit_detected != null && nextLastSeen.price_unit_detected == null) nextLastSeen.price_unit_detected = item.price_unit_detected;
      if (item.confidence_score != null && nextLastSeen.confidence_score == null) nextLastSeen.confidence_score = Number(item.confidence_score || 0);
      if (item.notes && !nextLastSeen.notes) nextLastSeen.notes = item.notes;
      if (!nextLastSeen.updated_at) nextLastSeen.updated_at = new Date().toISOString();
    }

    const normalized = {
      cart_item_id: item.cart_item_id || null,
      id: item.id || null,
      catalog_id: item.catalog_id || null,
      barcode: item.barcode || "",
      product_name: item.product_name || "",
      name: item.name || item.product_name || "",
      brand: item.brand || "",
      category: item.category || "",
      size_value: item.size_value || "",
      size_unit: item.size_unit || "",
      quantity: item.quantity || "1",
      display_size: item.display_size || "",
      secondary_size_value: item.secondary_size_value || "",
      secondary_size_unit: item.secondary_size_unit || "",
      image: item.image || null,
      cart_image_url: item.cart_image_url || item.image || null,
      verified_image_url: item.verified_image_url || null,
      image_url: item.image_url || null,
      source: item.source || "manual",
      notes: item.notes || "",
      needs_review: Boolean(item.needs_review),
      brand_lock: Boolean(item.brand_lock),
      found_in_trip: Boolean(item.found_in_trip),
      found_at: item.found_at || null,
      price_badge_source: item.price_badge_source || null,
    };

    if (lastSeen && Object.keys(lastSeen).length > 0) {
      normalized.last_seen_location = lastSeen;
    }

    // Preserve price/store intelligence fields so they survive save/reload/restore
    normalized.canonical_product_key = item.canonical_product_key || null;
    if (item.selected_store_location && typeof item.selected_store_location === "object") {
      normalized.selected_store_location = item.selected_store_location;
    }
    if (item.cheapest_location && typeof item.cheapest_location === "object") {
      normalized.cheapest_location = item.cheapest_location;
    }
    normalized.known_store_prices = Array.isArray(item.known_store_prices) ? item.known_store_prices : [];
    normalized.all_known_store_prices = Array.isArray(item.all_known_store_prices) ? item.all_known_store_prices : [];
    normalized.other_known_prices = Array.isArray(item.other_known_prices) ? item.other_known_prices : [];
    normalized.offers = Array.isArray(item.offers) ? item.offers : [];
    if (item.price_insights && typeof item.price_insights === "object") {
      normalized.price_insights = item.price_insights;
    }
    normalized.cheapest_known_price = item.cheapest_known_price ?? null;
    normalized.cheapest_known_store_name = item.cheapest_known_store_name || null;
    normalized.price = item.price ?? null;
    normalized.avg_price = item.avg_price ?? null;
    normalized.price_type = item.price_type || null;

    return normalized;
  };

  const rehydrateShoppingListPriceIntelligence = async (items) => {
    if (!Array.isArray(items) || items.length === 0) return Array.isArray(items) ? items : [];

    const debugEnabled = window.localStorage.getItem("mvpDebug") === "true";
    const selectedStoreId = String(selectedStore?.id || "").trim();

    const hasPositivePrice = (value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric > 0;
    };

    const toDebugPayload = (item, extras = {}) => ({
      product_name: item?.product_name || item?.name || null,
      brand: item?.brand || null,
      barcode: String(item?.barcode || "").trim() || null,
      catalog_id: item?.catalog_id || item?.id || null,
      canonical_product_key: item?.canonical_product_key || null,
      commodity_key: buildCommodityMatchKey(item) || null,
      locationRowCount: extras.locationRowCount || 0,
      offersCount: extras.offersCount || 0,
      cheapest_known_price: extras.cheapest_known_price ?? item?.cheapest_known_price ?? null,
      cheapest_known_store_name: extras.cheapest_known_store_name || item?.cheapest_known_store_name || null,
      selectedStoreId: selectedStoreId || null,
      selected_store_location: extras.selected_store_location || item?.selected_store_location || null,
      cheapest_location: extras.cheapest_location || item?.cheapest_location || null,
    });

    if (debugEnabled) {
      console.debug("SHOPPING_LIST_REHYDRATE_START", {
        itemCount: items.length,
        selectedStoreId: selectedStoreId || null,
      });
    }

    const catalogSelect = "id, barcode, product_name, brand, category, size_value, size_unit, display_size, quantity, canonical_product_key, image_url, verified_image_url, source";
    const rehydratedItems = [];

    for (const item of items) {
      const safeItem = item && typeof item === "object" ? item : {};

      if (debugEnabled) {
        console.debug("SHOPPING_LIST_REHYDRATE_ITEM_INPUT", toDebugPayload(safeItem));
      }

      const itemBarcode = String(safeItem?.barcode || "").trim();
      const itemCatalogId = safeItem?.catalog_id || safeItem?.id || null;
      const itemProductName = String(safeItem?.product_name || safeItem?.name || "").trim();
      const itemBrand = String(safeItem?.brand || "").trim();
      const itemCanonicalKey = normalizeComparableKey(
        safeItem?.canonical_product_key || safeItem?.last_seen_location?.canonical_product_key || buildComparableProductKey(safeItem)
      ) || null;

      let catalogProduct = null;

      if (itemCatalogId != null) {
        const byId = await supabase
          .from("catalog_products")
          .select(catalogSelect)
          .eq("id", itemCatalogId)
          .limit(1)
          .maybeSingle();
        if (!byId.error && byId.data) {
          catalogProduct = byId.data;
        }
      }

      if (!catalogProduct && itemBarcode) {
        const byBarcode = await supabase
          .from("catalog_products")
          .select(catalogSelect)
          .eq("barcode", itemBarcode)
          .limit(1)
          .maybeSingle();
        if (!byBarcode.error && byBarcode.data) {
          catalogProduct = byBarcode.data;
        }
      }

      if (!catalogProduct && itemProductName) {
        let nameBrandQuery = supabase
          .from("catalog_products")
          .select(catalogSelect)
          .ilike("product_name", `%${itemProductName}%`)
          .limit(5);
        if (itemBrand) {
          nameBrandQuery = nameBrandQuery.ilike("brand", `%${itemBrand}%`);
        }

        const byNameBrand = await nameBrandQuery;
        if (!byNameBrand.error) {
          const candidates = Array.isArray(byNameBrand.data) ? byNameBrand.data : [];
          catalogProduct = candidates.find((candidate) => {
            const candidateName = normalizeComparableText(candidate?.product_name);
            const candidateBrand = normalizeComparableText(candidate?.brand);
            const targetName = normalizeComparableText(itemProductName);
            const targetBrand = normalizeComparableText(itemBrand);
            if (!targetName) return false;
            if (candidateName !== targetName) return false;
            if (targetBrand && candidateBrand) {
              return candidateBrand === targetBrand;
            }
            return true;
          }) || candidates[0] || null;
        }
      }

      const resolvedCatalogProduct = catalogProduct
        ? {
            ...catalogProduct,
            product_name: catalogProduct?.product_name || itemProductName || safeItem?.name || "",
            brand: catalogProduct?.brand || itemBrand || "",
            barcode: String(catalogProduct?.barcode || itemBarcode).trim() || "",
            canonical_product_key: catalogProduct?.canonical_product_key || itemCanonicalKey || null,
          }
        : {
            ...safeItem,
            product_name: itemProductName || safeItem?.name || "",
            brand: itemBrand,
            barcode: itemBarcode,
            canonical_product_key: itemCanonicalKey,
          };

      if (debugEnabled) {
        console.debug("SHOPPING_LIST_REHYDRATE_CATALOG_MATCH", toDebugPayload({
          ...safeItem,
          barcode: resolvedCatalogProduct?.barcode || itemBarcode,
          catalog_id: resolvedCatalogProduct?.id || itemCatalogId,
          canonical_product_key: resolvedCatalogProduct?.canonical_product_key || itemCanonicalKey,
          product_name: resolvedCatalogProduct?.product_name || itemProductName,
          brand: resolvedCatalogProduct?.brand || itemBrand,
        }));
      }

      const { offers: hydratedOffers, bestOffer } = await hydratePriceOffers(resolvedCatalogProduct);

      const resolvedBarcode = String(resolvedCatalogProduct?.barcode || itemBarcode).trim();
      const resolvedCanonicalKey = normalizeComparableKey(
        resolvedCatalogProduct?.canonical_product_key || itemCanonicalKey
      ) || null;

      const rowsByBarcode = resolvedBarcode
        ? await fetchComparableProductLocationRows({
            barcodes: [resolvedBarcode],
            canonicalKeys: [],
            terms: [],
            lookupTerms: [],
          })
        : [];

      const rowsByCanonical = resolvedCanonicalKey
        ? await fetchComparableProductLocationRows({
            barcodes: [],
            canonicalKeys: [resolvedCanonicalKey],
            terms: [],
            lookupTerms: [],
          })
        : [];

      const rowsByFallback = await fetchComparableProductLocationRows({
        barcodes: [],
        canonicalKeys: [],
        terms: [resolvedCatalogProduct?.product_name, resolvedCatalogProduct?.brand, resolvedCatalogProduct?.size_value].filter(Boolean),
        lookupTerms: [resolvedCatalogProduct?.product_name, resolvedCatalogProduct?.brand, resolvedCatalogProduct?.size_value, resolvedCatalogProduct?.size_unit].filter(Boolean),
      });

      const dedupedRowsByKey = new Map();
      [...rowsByBarcode, ...rowsByCanonical, ...rowsByFallback].forEach((row) => {
        const dedupeKey = [
          String(row?.store_id || "").trim(),
          String(row?.barcode || "").trim(),
          normalizeComparableKey(row?.canonical_product_key) || "",
          String(row?.avg_price ?? row?.price ?? "").trim(),
        ].join("|");
        if (!dedupedRowsByKey.has(dedupeKey)) {
          dedupedRowsByKey.set(dedupeKey, row);
        }
      });

      const locationRows = Array.from(dedupedRowsByKey.values());
      const exactBarcodeRows = resolvedBarcode
        ? locationRows.filter((row) => String(row?.barcode || "").trim() === resolvedBarcode)
        : [];
      const exactCanonicalRows = resolvedCanonicalKey
        ? locationRows.filter((row) => normalizeComparableKey(row?.canonical_product_key) === resolvedCanonicalKey)
        : [];
      const fallbackMatchedRows = locationRows.filter((row) => Boolean(getProductMatchMethod(resolvedCatalogProduct, row)));
      const matchedRows = exactBarcodeRows.length > 0
        ? exactBarcodeRows
        : (exactCanonicalRows.length > 0 ? exactCanonicalRows : fallbackMatchedRows);
      const validPriceRows = matchedRows.filter((row) => hasPositivePrice(row?.avg_price ?? row?.price));

      if (debugEnabled && buildCommodityMatchKey(safeItem)) {
        console.debug("REHYDRATE_COMMODITY_ROWS", {
          ...toDebugPayload(safeItem, {
            locationRowCount: matchedRows.length,
            offersCount: Array.isArray(hydratedOffers) ? hydratedOffers.length : 0,
          }),
          matchedRowMethods: matchedRows.slice(0, 8).map((row) => getProductMatchMethod(resolvedCatalogProduct, row)),
        });
      }

      if (debugEnabled) {
        console.debug("SHOPPING_LIST_REHYDRATE_LOCATION_ROWS", toDebugPayload(safeItem, {
          locationRowCount: matchedRows.length,
          offersCount: Array.isArray(hydratedOffers) ? hydratedOffers.length : 0,
        }));
      }

      const offersByStore = {};
      validPriceRows.forEach((row) => {
        const storeId = String(row?.store_id || "").trim();
        if (!storeId) return;

        const rowPrice = Number(row?.avg_price ?? row?.price);
        if (!Number.isFinite(rowPrice) || rowPrice <= 0) return;

        const candidateOffer = {
          store_id: storeId,
          store_name: row?.store_name || row?.stores?.name || "Unknown store",
          price: rowPrice,
          avg_price: Number(row?.avg_price ?? rowPrice) || rowPrice,
          price_type: row?.price_type || "each",
          aisle: row?.aisle || "",
          section: row?.section || "",
          shelf: row?.shelf || "",
          confidence_score: Number(row?.confidence_score || 0),
          updated_at: row?.last_confirmed_at || null,
          last_confirmed_at: row?.last_confirmed_at || null,
          canonical_product_key: row?.canonical_product_key || resolvedCanonicalKey || null,
          barcode: String(row?.barcode || "").trim() || resolvedBarcode || null,
          product_name: row?.product_name || resolvedCatalogProduct?.product_name || null,
          brand: row?.brand || resolvedCatalogProduct?.brand || null,
          size_value: row?.size_value || resolvedCatalogProduct?.size_value || null,
          size_unit: row?.size_unit || resolvedCatalogProduct?.size_unit || null,
          display_size: row?.display_size || resolvedCatalogProduct?.display_size || null,
        };

        const existingOffer = offersByStore[storeId];
        if (!existingOffer || candidateOffer.price < existingOffer.price) {
          offersByStore[storeId] = candidateOffer;
        }
      });

      const hydratedOfferList = Array.isArray(hydratedOffers) ? hydratedOffers : [];
      hydratedOfferList.forEach((offer) => {
        const storeId = String(offer?.store_id || "").trim();
        const offerPrice = Number(offer?.price ?? offer?.avg_price ?? 0);
        if (!storeId || !Number.isFinite(offerPrice) || offerPrice <= 0) return;

        const existingOffer = offersByStore[storeId];
        if (!existingOffer || offerPrice < Number(existingOffer?.price || 0)) {
          offersByStore[storeId] = {
            ...offer,
            store_id: storeId,
            price: offerPrice,
            avg_price: Number(offer?.avg_price ?? offerPrice) || offerPrice,
            barcode: String(offer?.barcode || resolvedBarcode).trim() || null,
            canonical_product_key: offer?.canonical_product_key || resolvedCanonicalKey || null,
          };
        }
      });

      const mergedOffers = Object.values(offersByStore).sort((a, b) => Number(a?.price || 0) - Number(b?.price || 0));
      const resolvedBestOffer = mergedOffers[0] || bestOffer || null;

      const selectedStoreLocation = selectedStoreId
        ? validPriceRows
            .filter((row) => String(row?.store_id || "").trim() === selectedStoreId)
            .sort((a, b) => {
              const aPrice = Number(a?.avg_price ?? a?.price ?? Infinity);
              const bPrice = Number(b?.avg_price ?? b?.price ?? Infinity);
              if (aPrice !== bPrice) return aPrice - bPrice;
              return Number(b?.confidence_score || 0) - Number(a?.confidence_score || 0);
            })[0] || null
        : null;

      const cheapestLocation = validPriceRows.reduce((current, row) => {
        if (!current) return row;
        const currentPrice = Number(current?.avg_price ?? current?.price ?? Infinity);
        const rowPrice = Number(row?.avg_price ?? row?.price ?? Infinity);
        if (rowPrice < currentPrice) return row;
        if (rowPrice === currentPrice && Number(row?.confidence_score || 0) > Number(current?.confidence_score || 0)) {
          return row;
        }
        return current;
      }, null);

      const cheapestKnownPrice = Number(
        resolvedBestOffer?.price ??
        cheapestLocation?.avg_price ??
        cheapestLocation?.price ??
        selectedStoreLocation?.avg_price ??
        selectedStoreLocation?.price ??
        0
      ) || null;
      const cheapestKnownStoreName = resolvedBestOffer?.store_name || cheapestLocation?.store_name || null;

      const knownStorePrices = mergedOffers
        .map((offer) => ({
          store_id: offer?.store_id || null,
          store_name: offer?.store_name || "Unknown store",
          price: Number(offer?.price ?? offer?.avg_price ?? 0) || null,
          price_type: offer?.price_type || "each",
          aisle: offer?.aisle || "",
          section: offer?.section || "",
          shelf: offer?.shelf || "",
          confidence_score: Number(offer?.confidence_score || 0),
        }))
        .filter((entry) => hasPositivePrice(entry?.price));

      const bestLocationCandidate = selectedStoreLocation || cheapestLocation || (resolvedBestOffer
        ? {
            store_id: resolvedBestOffer?.store_id || null,
            store_name: resolvedBestOffer?.store_name || "",
            aisle: resolvedBestOffer?.aisle || "",
            section: resolvedBestOffer?.section || "",
            shelf: resolvedBestOffer?.shelf || "",
            price: resolvedBestOffer?.price ?? null,
            avg_price: resolvedBestOffer?.avg_price ?? resolvedBestOffer?.price ?? null,
            price_type: resolvedBestOffer?.price_type || "each",
            confidence_score: Number(resolvedBestOffer?.confidence_score || 0),
            canonical_product_key: resolvedCanonicalKey,
          }
        : null);

      const nextItem = {
        ...safeItem,
        barcode: resolvedBarcode || safeItem?.barcode || "",
        catalog_id: safeItem?.catalog_id || resolvedCatalogProduct?.id || null,
        canonical_product_key: safeItem?.canonical_product_key || resolvedCanonicalKey || null,
      };

      if (Array.isArray(mergedOffers) && mergedOffers.length > 0) {
        nextItem.offers = mergedOffers;
      }
      if (Array.isArray(knownStorePrices) && knownStorePrices.length > 0) {
        nextItem.known_store_prices = knownStorePrices;
        nextItem.all_known_store_prices = knownStorePrices;
      }
      if (hasPositivePrice(cheapestKnownPrice)) {
        nextItem.cheapest_known_price = cheapestKnownPrice;
        nextItem.cheapest_known_store_name = cheapestKnownStoreName || safeItem?.cheapest_known_store_name || null;
        nextItem.price = cheapestKnownPrice;
        nextItem.avg_price = cheapestKnownPrice;
        nextItem.price_type = resolvedBestOffer?.price_type || cheapestLocation?.price_type || selectedStoreLocation?.price_type || safeItem?.price_type || "each";
      }
      if (selectedStoreLocation && typeof selectedStoreLocation === "object") {
        nextItem.selected_store_location = selectedStoreLocation;
      }
      if (cheapestLocation && typeof cheapestLocation === "object") {
        nextItem.cheapest_location = cheapestLocation;
      }
      if (bestLocationCandidate && typeof bestLocationCandidate === "object") {
        nextItem.last_seen_location = bestLocationCandidate;
      }

      nextItem.price_insights = {
        ...(safeItem?.price_insights && typeof safeItem.price_insights === "object" ? safeItem.price_insights : {}),
        selected_store_location: nextItem.selected_store_location || safeItem?.selected_store_location || null,
        cheapest_location: nextItem.cheapest_location || safeItem?.cheapest_location || null,
        all_known_store_prices: Array.isArray(nextItem.all_known_store_prices)
          ? nextItem.all_known_store_prices
          : (Array.isArray(safeItem?.all_known_store_prices) ? safeItem.all_known_store_prices : []),
        cheapest_known_price: nextItem.cheapest_known_price ?? safeItem?.cheapest_known_price ?? null,
        cheapest_known_store_name: nextItem.cheapest_known_store_name || safeItem?.cheapest_known_store_name || null,
      };

      if (debugEnabled) {
        console.debug("SHOPPING_LIST_REHYDRATE_ITEM_OUTPUT", toDebugPayload(nextItem, {
          locationRowCount: matchedRows.length,
          offersCount: Array.isArray(nextItem?.offers) ? nextItem.offers.length : 0,
          cheapest_known_price: nextItem?.cheapest_known_price ?? null,
          cheapest_known_store_name: nextItem?.cheapest_known_store_name || null,
          selected_store_location: nextItem?.selected_store_location || null,
          cheapest_location: nextItem?.cheapest_location || null,
        }));
      }

      rehydratedItems.push(nextItem);
    }

    if (debugEnabled) {
      console.debug("SHOPPING_LIST_REHYDRATE_COMPLETE", {
        itemCount: rehydratedItems.length,
        selectedStoreId: selectedStoreId || null,
      });
    }

    return rehydratedItems;
  };

  const sanitizeShoppingListForSave = (items) => {
    if (!Array.isArray(items)) return [];

    return items.map(normalizeCartItemForStoreNeutral).filter(Boolean);
  };

  const isRlsOrTableAccessError = (err) => {
    const message = String(err?.message || "").toLowerCase();
    const details = String(err?.details || "").toLowerCase();
    const hint = String(err?.hint || "").toLowerCase();
    const code = String(err?.code || "").toLowerCase();
    const combined = `${message} ${details} ${hint} ${code}`;

    return (
      combined.includes("row-level security") ||
      combined.includes("permission denied") ||
      combined.includes("42501") ||
      combined.includes("42p01") ||
      combined.includes("relation \"user_shopping_lists\"") ||
      combined.includes("does not exist")
    );
  };

  const saveShoppingListToCloud = async (nextItems, { allowEmptySave = false } = {}) => {
    if (!canUseSavedShoppingList()) return;

    try {
      const sanitizedItems = sanitizeShoppingListForSave(nextItems);
      if (sanitizedItems.length === 0 && !allowEmptySave) {
        console.info("CLOUD LIST SKIPPED EMPTY INITIAL SAVE");
        return;
      }

      console.info("CLOUD LIST SAVE START", { itemCount: sanitizedItems.length });
      const { data, error } = await supabase
        .from("user_shopping_lists")
        .upsert(
          {
            user_profile_id: currentUserProfile.id,
            list_name: "My Shopping List",
            list_items: sanitizedItems,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_profile_id,list_name" }
        )
        .select("id, user_profile_id, list_name, updated_at")
        .single();

      if (error) {
        throw error;
      }

      console.info("CLOUD LIST SAVE SUCCESS", {
        itemCount: sanitizedItems.length,
        savedRow: data,
      });
    } catch (err) {
      const warningLabel = isRlsOrTableAccessError(err)
        ? "CLOUD LIST RLS OR TABLE ACCESS WARNING"
        : "SHOPPING LIST CLOUD SAVE WARNING";
      console.warn(`${warningLabel}:`, err?.message || err);
    }
  };

  const handleManualCloudListTest = async () => {
    console.info("MANUAL CLOUD TEST START");
    console.info("MANUAL CLOUD TEST ELIGIBILITY", {
      canUseCloudList: canUseSavedShoppingList(),
      authUserId: authUser?.id || null,
      profileId: currentUserProfile?.id || null,
      cartCount: shoppingListItems.length,
    });

    if (!canUseSavedShoppingList()) {
      setToast({ message: "Cloud list unavailable: sign in first.", type: "error" });
      return;
    }

    await saveShoppingListToCloud(shoppingListItems, { allowEmptySave: shoppingListItems.length === 0 });
    await loadShoppingListFromCloud();
    console.info("MANUAL CLOUD TEST COMPLETE");
  };

  const handleManualCloudListSave = async () => {
    if (!canUseSavedShoppingList()) {
      setManualCloudSaveStatus("Could not save list");
      return;
    }

    setIsManualCloudSaveInProgress(true);
    setManualCloudSaveStatus("Saving...");

    try {
      const normalizedItems = (shoppingListItems || []).map((item) => {
        const existingKey = normalizeComparableKey(item?.canonical_product_key || item?.last_seen_location?.canonical_product_key);
        if (existingKey) return item;

        const derivedKey = buildComparableProductKey(item);
        if (!derivedKey) return item;

        return {
          ...item,
          canonical_product_key: derivedKey,
        };
      });

      setShoppingListItems(normalizedItems);
      await saveShoppingListToCloud(normalizedItems, { allowEmptySave: true });
      setManualCloudSaveStatus("Saved to your profile");
      setToast({ message: "Saved to your profile", type: "success" });
    } catch (err) {
      console.warn("MANUAL CLOUD LIST SAVE WARNING:", err?.message || err);
      setManualCloudSaveStatus("Could not save list");
      setToast({ message: "Could not save list", type: "error" });
    } finally {
      setIsManualCloudSaveInProgress(false);
    }
  };

  const loadShoppingListFromCloud = async () => {
    if (!canUseSavedShoppingList()) return;

    try {
      console.info("CLOUD LIST LOAD START", { userProfileId: currentUserProfile.id });
      const { data, error } = await supabase
        .from("user_shopping_lists")
        .select("list_items")
        .eq("user_profile_id", currentUserProfile.id)
        .eq("list_name", "My Shopping List")
        .maybeSingle();

      if (error) {
        const warningLabel = isRlsOrTableAccessError(error)
          ? "CLOUD LIST RLS OR TABLE ACCESS WARNING"
          : "SHOPPING LIST CLOUD LOAD WARNING";
        console.warn(`${warningLabel}:`, error.message);
        return;
      }

      const cloudItems = Array.isArray(data?.list_items) ? data.list_items : [];
      const normalizedCloudItems = cloudItems.map(normalizeCartItemForStoreNeutral).filter(Boolean);
      const localItemsAtLoad = latestShoppingListItemsRef.current || [];

      if (normalizedCloudItems.length > 0 && localItemsAtLoad.length === 0) {
        setShoppingListItems(normalizedCloudItems);
        localStorage.setItem("shoppingListItems", JSON.stringify(normalizedCloudItems));
      } else if (normalizedCloudItems.length === 0 && localItemsAtLoad.length > 0) {
        await saveShoppingListToCloud(localItemsAtLoad, { allowEmptySave: false });
      } else if (normalizedCloudItems.length > 0 && localItemsAtLoad.length > 0) {
        console.info("CLOUD LIST BOTH LOCAL AND CLOUD EXIST - KEEPING LOCAL");
      }

      console.info("CLOUD LIST LOAD SUCCESS", {
        cloudCount: normalizedCloudItems.length,
        localCount: localItemsAtLoad.length,
      });
    } catch (err) {
      const warningLabel = isRlsOrTableAccessError(err)
        ? "CLOUD LIST RLS OR TABLE ACCESS WARNING"
        : "SHOPPING LIST CLOUD LOAD WARNING";
      console.warn(`${warningLabel}:`, err?.message || err);
    }
  };

  const addSharedCatalogResultToCart = async (result) => {
    console.log("ADD_KNOWN_DATABASE_ITEM_TO_DESIRED_LIST", {
      product_name: result?.product_name || null,
      brand: result?.brand || null,
      barcode: result?.barcode || null,
      canonical_product_key: result?.canonical_product_key || null,
    });

    const productName = String(result?.product_name || "").trim();
    const barcode = String(result?.barcode || "").trim();
    const selectedLocation = result?.selected_store_location && typeof result.selected_store_location === "object"
      ? result.selected_store_location
      : null;
    const cheapestLocation = result?.cheapest_location && typeof result.cheapest_location === "object"
      ? result.cheapest_location
      : null;
    const canonicalProductKey = normalizeComparableKey(
      result?.canonical_product_key || selectedLocation?.canonical_product_key || cheapestLocation?.canonical_product_key || buildComparableProductKey(result)
    ) || null;
    const cheapestKnownPrice = Number(result?.cheapest_known_price ?? cheapestLocation?.avg_price ?? cheapestLocation?.price ?? selectedLocation?.avg_price ?? selectedLocation?.price ?? 0) || null;
    const cheapestKnownStoreName = result?.cheapest_known_store_name || cheapestLocation?.store_name || selectedLocation?.store_name || null;

    if (!productName && !barcode) {
      setError("Could not add this item.");
      setToast({ message: "Could not add this item.", type: "error" });
      return;
    }

    // Hydrate with store-specific price offers
    const { offers: priceOffers, bestOffer } = await hydratePriceOffers(result);
    const bestOfferPrice = bestOffer?.price || cheapestKnownPrice;
    const bestOfferStore = bestOffer?.store_name || cheapestKnownStoreName;

    const productToAdd = {
      catalog_id: result?.catalog_id || result?.id || null,
      id: result?.id || Date.now(),
      barcode,
      name: productName,
      product_name: productName,
      brand: result?.brand || "",
      category: result?.category || "",
      size_value: result?.size_value || "",
      size_unit: result?.size_unit || "",
      display_size: result?.display_size || "",
      canonical_product_key: canonicalProductKey,
      quantity: result?.quantity || "1",
      image: result?.cart_image_url || result?.verified_image_url || result?.image_url || null,
      cart_image_url: result?.cart_image_url || result?.verified_image_url || result?.image_url || null,
      verified_image_url: result?.verified_image_url || null,
      image_url: result?.image_url || null,
      cheapest_known_price: bestOfferPrice,
      cheapest_known_store_name: bestOfferStore,
      known_store_prices: Array.isArray(result?.known_store_prices)
        ? result.known_store_prices
        : (Array.isArray(result?.all_known_store_prices) ? result.all_known_store_prices : []),
      all_known_store_prices: Array.isArray(result?.all_known_store_prices) ? result.all_known_store_prices : [],
      other_known_prices: Array.isArray(result?.other_known_prices) ? result.other_known_prices : [],
      offers: priceOffers,
      price: bestOfferPrice,
      avg_price: bestOfferPrice,
      price_type: bestOffer?.price_type || cheapestLocation?.price_type || selectedLocation?.price_type || result?.price_type || "each",
      price_insights: {
        selected_store_location: result?.selected_store_location || null,
        cheapest_location: result?.cheapest_location || null,
        all_known_store_prices: Array.isArray(result?.all_known_store_prices) ? result.all_known_store_prices : [],
        cheapest_known_price: bestOfferPrice,
        cheapest_known_store_name: bestOfferStore,
      },
      selected_store_location: selectedLocation || null,
      cheapest_location: cheapestLocation || null,
      source: "shared_catalog",
    };

    const hasSelectedStoreLocation = Boolean(
      selectedLocation?.aisle ||
      selectedLocation?.section ||
      selectedLocation?.shelf ||
      selectedLocation?.price != null ||
      selectedLocation?.avg_price != null
    );

    const fallbackLocation = hasSelectedStoreLocation ? selectedLocation : cheapestLocation;
    // If neither selectedLocation nor cheapestLocation from search carry location info,
    // fall back to the best hydrated offer so last_seen_location is always populated
    // with real database intelligence even when the selected store has no mapping yet.
    const bestOfferAsLocation = bestOffer
        ? {
          store_id: bestOffer.store_id || null,
          store_name: bestOffer.store_name || "",
          aisle: bestOffer.aisle || "",
          section: bestOffer.section || "",
          shelf: bestOffer.shelf || "",
          price: bestOffer.price ?? null,
          avg_price: bestOffer.avg_price ?? bestOffer.price ?? null,
          price_type: bestOffer.price_type || "each",
          confidence_score: Number(bestOffer.confidence_score || 0),
          canonical_product_key: canonicalProductKey,
        }
      : null;
    const resolvedFallback = (fallbackLocation && Object.keys(fallbackLocation).length > 0)
      ? fallbackLocation
      : bestOfferAsLocation;
    const lastSeenLocation = resolvedFallback
      ? {
          store_id: resolvedFallback?.store_id || null,
          store_name: resolvedFallback?.store_name || resolvedFallback?.stores?.name || "",
          aisle: resolvedFallback?.aisle || "",
          section: resolvedFallback?.section || "",
          shelf: resolvedFallback?.shelf || "",
          price: resolvedFallback?.price ?? result?.price ?? bestOfferPrice ?? null,
          avg_price: resolvedFallback?.avg_price ?? result?.avg_price ?? bestOfferPrice ?? null,
          price_type: resolvedFallback?.price_type || result?.price_type || "each",
          confidence_score: Number(result?.confidence_score ?? resolvedFallback?.confidence_score ?? 0),
          canonical_product_key: canonicalProductKey,
        }
      : null;

    const addResult = await handleAddToShoppingList(productToAdd, lastSeenLocation);
    if (addResult?.added || addResult?.updated) {
      if (window.localStorage.getItem("mvpDebug") === "true") {
        console.debug("KNOWN_DB_ITEM_ADDED_TO_LIST", {
          product_name: productToAdd.product_name,
          barcode: productToAdd.barcode,
          canonical_product_key: productToAdd.canonical_product_key,
          offers: productToAdd.offers,
          last_seen_location: lastSeenLocation,
          cheapest_known_price: productToAdd.cheapest_known_price,
          cheapest_known_store_name: productToAdd.cheapest_known_store_name,
        });
      }
      setManualListItemName("");
      setCatalogSearchTerm("");
      setCatalogSearchResults([]);
      setCatalogSearchMessage("");
      setToast({ message: "Added to shopping list", type: "success" });
    }
  };

  // ============================================================================
  // PROFILE LOGIC - Create & Save User Profile
  // ============================================================================

  const handleStartShoppingSmarter = async () => {
    const isGuestMode = Boolean(currentUserProfile?.is_guest);
    if (authUser) {
      localStorage.removeItem("currentUserProfile");
      setCurrentUserProfile(null);
      try {
        const profile = await withTimeout(
          loadOrCreateSupabaseProfile(authUser),
          8000,
          "Profile load"
        );

        if (profile) {
          const normalizedProfile = { ...profile, is_guest: false };
          setCurrentUserProfile(normalizedProfile);
          localStorage.setItem("currentUserProfile", JSON.stringify(normalizedProfile));
          setAppScreen("store");
          setShowOnboarding(false);
          setShowLoginModal(false);
          return;
        }
      } catch (err) {
        console.error("START SHOPPING PROFILE LOAD ERROR:", err);
      }

      const temporaryProfile = createTemporarySupabaseProfile(authUser);
      setCurrentUserProfile(temporaryProfile);
      localStorage.setItem("currentUserProfile", JSON.stringify(temporaryProfile));
      setAppScreen("store");
      setShowOnboarding(false);
      setShowLoginModal(false);
      setToast({
        message: "Signed in. Profile is still syncing.",
        type: "success",
      });
      return;
    }

    if (currentUserProfile && !isGuestMode) {
      setAppScreen("store");
      setShowOnboarding(false);
      setShowLoginModal(false);
      return;
    }

    if (currentUserProfile && isGuestMode) {
      setAppScreen("store");
      setShowOnboarding(false);
      setShowLoginModal(false);
      return;
    }

    const guestId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const guestProfile = {
      id: guestId,
      display_name: "Guest Shopper",
      email: null,
      trust_score: 0,
      points: 0,
      total_points: 0,
      is_guest: true,
      created_at: new Date().toISOString(),
    };
    localStorage.setItem("currentUserProfile", JSON.stringify(guestProfile));
    setCurrentUserProfile(guestProfile);
    setAppScreen("store");
    setShowLoginModal(false);
    setShowOnboarding(false);
  };

  const handleCreateProfile = () => {
    if (!profileForm.display_name.trim()) return;

    const newProfile = {
      id: Date.now(),
      display_name: profileForm.display_name,
      email: profileForm.email || null,
      trust_score: 0,
      points: 0,
      total_points: 0,
      created_at: new Date().toISOString(),
    };

    localStorage.setItem("currentUserProfile", JSON.stringify(newProfile));
    setCurrentUserProfile(newProfile);
  };

  const handleSubmitItemRequest = async () => {
    const productName = itemRequestForm.product_name.trim();
    if (!productName) {
      setError("Enter the item you want help finding.");
      return;
    }

    setIsSavingItemRequest(true);
    setError("");

    try {
      const payload = {
        user_profile_id: currentUserProfile?.id || null,
        product_name: productName,
        brand: itemRequestForm.brand.trim() || null,
        notes: itemRequestForm.notes.trim() || null,
        store_id: selectedStore?.id || null,
        store_name: selectedStore?.name || null,
        status: "open",
        source: "community_request",
        created_at: new Date().toISOString(),
      };

      const { error: requestError } = await supabase
        .from("item_requests")
        .insert(payload);

      if (requestError) throw requestError;

      setShowItemRequestModal(false);
      setItemRequestForm({ product_name: "", brand: "", notes: "" });
      setItemRequestSuggestions([]);
      setToast({ message: "Request posted. The community can help locate this item.", type: "success" });
    } catch (err) {
      console.error("ITEM REQUEST SAVE ERROR:", err);
      setError("Request could not be saved yet.");
      setToast({ message: "Request could not be saved yet.", type: "error" });
    } finally {
      setIsSavingItemRequest(false);
    }
  };

  const handleResetProfile = async () => {
    try {
      if (authUser) {
        await supabase.auth.signOut();
      }
    } catch (err) {
      console.error("AUTH SIGN OUT ERROR:", err);
    } finally {
      localStorage.removeItem("currentUserProfile");
      setCurrentUserProfile(null);
      setAuthUser(null);
      setShowLoginModal(false);
      setShowOnboarding(false);
    }
  };

  function setAppScreen(screen) {
    setActiveScreen(screen);
    setActivePanel(null);
    setError("");

    try {
      window.history.pushState({ screen, protected: true }, "", `#${screen}`);
    } catch (err) {
      console.warn("NAVIGATION STATE WARNING:", err);
    }
  }

  const openLocationPanel = () => {
    setActiveScreen("identify");
    setActivePanel("location");
    setError("");

    try {
      window.history.pushState({ screen: "location", protected: true }, "", "#location");
    } catch (err) {
      console.warn("NAVIGATION STATE WARNING:", err);
    }
  };

  const handleBackToHome = async (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();

    setShowLoginModal(false);
    setShowOnboarding(false);
    setShowItemRequestModal(false);
    setShowNextItemPrompt(false);

    setActivePanel(null);
    setAppScreen("landing");

    setShoppingMode(false);
    setActiveAisleView(null);
    setError(null);
    setStatus("Ready");

    try {
      if (isScanning || scanningRef.current) {
        await stopScanner();
      }
    } catch (err) {
      console.warn("HOME STOP SCANNER WARNING:", err);
    }
  };

  const navigateToScreen = (screen) => {
    if (screen === "identify" && !selectedStore) {
      setError("Select a store first.");
      setAppScreen("store");
      return;
    }

    setAppScreen(screen);
  };

  const handleUpdateProfilePoints = async (earnedPoints) => {
    if (!currentUserProfile || earnedPoints <= 0) return;

    try {
      const newTotal = currentUserProfile.total_points + earnedPoints;
      const { data, error } = await supabase
        .from("profiles")
        .update({ total_points: newTotal })
        .eq("id", currentUserProfile.id)
        .select()
        .single();

      if (error) throw error;

      // Update local state
      setCurrentUserProfile(data);
      localStorage.setItem("currentUserProfile", JSON.stringify(data));
    } catch (err) {
      console.error("PROFILE UPDATE ERROR:", err);
    }
  };

  const updateUserTrustScore = async (increment = 1) => {
    if (!currentUserProfile?.id) return;

    const applyLocalTrustScoreFallback = () => {
      setCurrentUserProfile((prev) => {
        if (!prev) return prev;
        const nextProfile = {
          ...prev,
          trust_score: Number(prev?.trust_score || 0) + increment,
        };
        localStorage.setItem("currentUserProfile", JSON.stringify(nextProfile));
        return nextProfile;
      });
    };

    if (currentUserProfile?.is_guest) {
      applyLocalTrustScoreFallback();
      return;
    }

    if (!authUser?.id) {
      applyLocalTrustScoreFallback();
      return;
    }

    if (String(currentUserProfile.id) !== String(authUser.id)) {
      applyLocalTrustScoreFallback();
      return;
    }

    try {
      // Fetch current trust_score to avoid race conditions
      const { data, error } = await supabase
        .from("profiles")
        .select("trust_score")
        .eq("id", currentUserProfile.id)
        .maybeSingle();

      if (error) {
        console.warn("TRUST SCORE LOOKUP SKIPPED:", error.message);
        return;
      }

      if (!data) {
        console.warn("TRUST SCORE PROFILE ROW NOT FOUND; using local fallback");
        applyLocalTrustScoreFallback();
        return;
      }

      const newTrustScore = Number(data?.trust_score || 0) + increment;

      const { data: updatedProfile, error: updateError } = await supabase
        .from("profiles")
        .update({
          trust_score: newTrustScore,
          updated_at: new Date().toISOString()
        })
        .eq("id", currentUserProfile.id)
        .select()
        .maybeSingle();

      if (updateError) {
        console.warn("TRUST SCORE UPDATE SKIPPED:", updateError.message);
        return;
      }

      if (updatedProfile) {
        setCurrentUserProfile(updatedProfile);
        localStorage.setItem("currentUserProfile", JSON.stringify(updatedProfile));
      } else {
        console.warn("TRUST SCORE UPDATE RETURNED NO ROW; using local fallback");
        applyLocalTrustScoreFallback();
      }

    } catch (err) {
      console.warn("TRUST SCORE UPDATE SKIPPED:", err?.message || err);
    }
  };

  const handleAddToShoppingList = async (productToAdd = product, locationToUse = bestKnownLocation) => {
    if (!productToAdd) {
      setError("No product available to add");
      return { added: false, updated: false, hasLocation: false };
    }

    const CART_BAD_NAMES = ["unknown product", "review needed", ""];
    const isCartBadName = (n) => CART_BAD_NAMES.includes(String(n || "").trim().toLowerCase());
    // Pick the best non-placeholder name available, preferring product_name (DB field) over name
    const resolveBestCartName = (incoming, existing) => {
      const candidates = [
        String(incoming?.product_name || "").trim(),
        String(incoming?.name || "").trim(),
        String(existing?.product_name || "").trim(),
        String(existing?.name || "").trim(),
      ];
      return candidates.find((c) => c && !isCartBadName(c)) || "Unknown product";
    };

    const itemBarcode = productToAdd.barcode || barcode || null;
    const itemProductName = resolveBestCartName(productToAdd, null);
    const itemBrand = String(productToAdd.brand || "").trim();
    const itemComparableKey = buildComparableProductKey(productToAdd);
    const knownStorePrices = Array.isArray(productToAdd?.known_store_prices)
      ? productToAdd.known_store_prices
      : (Array.isArray(productToAdd?.all_known_store_prices) ? productToAdd.all_known_store_prices : []);

    console.info("CART PRODUCT KEY", {
      productName: itemProductName,
      barcode: itemBarcode || null,
      productKey: itemComparableKey || null,
    });

    const hasLocation = Boolean(locationToUse?.aisle || locationToUse?.section || locationToUse?.shelf);

    const buildLastSeenLocation = () => {
      if (!locationToUse) return null;

      const lastSeen = {
        store_id: locationToUse?.store_id || selectedStore?.id || null,
        store_name: locationToUse?.store_name || selectedStore?.name || "",
        aisle: locationToUse?.aisle || "",
        section: locationToUse?.section || "",
        shelf: locationToUse?.shelf || "",
        confidence_score: locationToUse?.confidence_score ?? null,
        price: locationToUse?.price ?? null,
        avg_price: locationToUse?.avg_price ?? null,
        price_type: locationToUse?.price_type ?? "each",
        product_name: itemProductName,
        brand: itemBrand || null,
        category: productToAdd?.category || null,
        size_value: productToAdd?.size_value || "",
        size_unit: productToAdd?.size_unit || "",
        display_size: productToAdd?.display_size || "",
        canonical_product_key: itemComparableKey || null,
        notes: locationToUse?.notes ?? "",
        updated_at: new Date().toISOString(),
      };

      const hasMetadata =
        Boolean(lastSeen.store_id) ||
        Boolean(lastSeen.aisle) ||
        Boolean(lastSeen.section) ||
        Boolean(lastSeen.shelf) ||
        lastSeen.price !== null ||
        lastSeen.avg_price !== null;

      return hasMetadata ? lastSeen : null;
    };

    const latestLastSeenLocation = buildLastSeenLocation();

    const getMatchStrategy = (item) => {
      const existingKey = buildComparableProductKey(item);
      const targetBarcode = String(itemBarcode || "").trim();

      if (itemComparableKey && existingKey && itemComparableKey === existingKey) {
        return "canonical_product_key";
      }

      if (targetBarcode && String(item?.barcode || "").trim() === targetBarcode) {
        return "barcode";
      }

      const targetFallback = normalizeComparableText([
        itemProductName,
        itemBrand,
        productToAdd?.size_value || "",
        productToAdd?.size_unit || "",
      ].filter(Boolean).join(" "));
      const existingFallback = normalizeComparableText([
        item?.product_name || item?.name || "",
        item?.brand || "",
        item?.size_value || "",
        item?.size_unit || "",
      ].filter(Boolean).join(" "));

      if (targetFallback && targetFallback === existingFallback) {
        return "fallback_identity";
      }

      return null;
    };

    const existingMatchIndex = shoppingListItems.findIndex((item) => Boolean(getMatchStrategy(item)));

    if (existingMatchIndex >= 0) {
      setShoppingListItems((prev) =>
        prev.map((item) => {
          const isMatch = Boolean(getMatchStrategy(item));

          if (!isMatch) return item;

          const updatedName = resolveBestCartName(productToAdd, item);
          const resolvedImage = resolveProductImage(productToAdd);
          const nextImage = item.image || resolvedImage;
          const nextCartImage = item.cart_image_url || nextImage;

          return {
            ...item,
            id: item.id || productToAdd.id || item.cart_item_id,
            catalog_id: productToAdd.catalog_id || item.catalog_id || null,
            name: updatedName,
            product_name: updatedName,
            canonical_product_key: itemComparableKey || item.canonical_product_key || buildComparableProductKey(item) || null,
            brand: itemBrand || item.brand || "",
            category: productToAdd.category || item.category || "",
            source: productToAdd.source || item.source || "manual",
            size_value: productToAdd.size_value || item.size_value || "",
            size_unit: productToAdd.size_unit || item.size_unit || "",
            display_size: productToAdd.display_size || item.display_size || "",
            secondary_size_value: productToAdd.secondary_size_value || item.secondary_size_value || "",
            secondary_size_unit: productToAdd.secondary_size_unit || item.secondary_size_unit || "",
            quantity: item.quantity || productToAdd.quantity || "1",
            notes: locationToUse ? (item.notes || "") : (productToAdd.notes ?? item.notes ?? ""),
            last_seen_location: latestLastSeenLocation || item.last_seen_location || null,
            selected_store_location: productToAdd.selected_store_location || item.selected_store_location || null,
            cheapest_location: productToAdd.cheapest_location || item.cheapest_location || null,
            known_store_prices: knownStorePrices.length > 0 ? knownStorePrices : (item.known_store_prices || []),
            cheapest_known_price: productToAdd.cheapest_known_price ?? item.cheapest_known_price ?? null,
            cheapest_known_store_name: productToAdd.cheapest_known_store_name || item.cheapest_known_store_name || null,
            other_known_prices: Array.isArray(productToAdd.other_known_prices) ? productToAdd.other_known_prices : (item.other_known_prices || []),
            all_known_store_prices: Array.isArray(productToAdd.all_known_store_prices) ? productToAdd.all_known_store_prices : (item.all_known_store_prices || []),
            offers: (
              Array.isArray(productToAdd?.offers) && productToAdd.offers.length > 0
                ? productToAdd.offers
                : (Array.isArray(item?.offers) && item.offers.length > 0 ? item.offers : [])
            ),
            price_insights: productToAdd.price_insights || item.price_insights || null,
            price: productToAdd.price ?? item.price ?? null,
            avg_price: productToAdd.avg_price ?? item.avg_price ?? null,
            price_type: productToAdd.price_type || item.price_type || "each",
            image: nextImage,
            cart_image_url: nextCartImage,
            image_url: productToAdd.image_url || item.image_url || null,
            verified_image_url: productToAdd.verified_image_url || item.verified_image_url || null,
            needs_review: Boolean(productToAdd.needs_review || item.needs_review),
          };
        })
      );
      console.info("CART DEDUPE MERGE RESULT", {
        productKey: itemComparableKey || null,
        barcode: itemBarcode || null,
        matchedIndex: existingMatchIndex,
        strategy: getMatchStrategy(shoppingListItems[existingMatchIndex]),
        cartCount: shoppingListItems.length,
      });
      setToast({ message: "Updated shopping list", type: "success" });
      return { added: false, updated: true, hasLocation };
    }

    const resolvedImage = resolveProductImage(productToAdd);

    const cartItem = {
      cart_item_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      id: productToAdd.id || Date.now(),
      catalog_id: productToAdd.catalog_id || null,
      name: itemProductName,
      barcode: itemBarcode,
      product_name: itemProductName,
      canonical_product_key: itemComparableKey || null,
      brand: itemBrand,
      category: productToAdd.category || "",
      source: productToAdd.source || "manual",
      size_value: productToAdd.size_value || "",
      size_unit: productToAdd.size_unit || "",
      display_size: productToAdd.display_size || "",
      secondary_size_value: productToAdd.secondary_size_value || "",
      secondary_size_unit: productToAdd.secondary_size_unit || "",
      quantity: productToAdd.quantity || "1",
      notes: locationToUse ? "" : (productToAdd.notes ?? ""),
      last_seen_location: latestLastSeenLocation,
      selected_store_location: productToAdd.selected_store_location || null,
      cheapest_location: productToAdd.cheapest_location || null,
      known_store_prices: knownStorePrices,
      cheapest_known_price: productToAdd.cheapest_known_price ?? null,
      cheapest_known_store_name: productToAdd.cheapest_known_store_name || null,
      other_known_prices: Array.isArray(productToAdd.other_known_prices) ? productToAdd.other_known_prices : [],
      all_known_store_prices: Array.isArray(productToAdd.all_known_store_prices) ? productToAdd.all_known_store_prices : knownStorePrices,
      offers: Array.isArray(productToAdd.offers) ? productToAdd.offers : [],
      price_insights: productToAdd.price_insights || null,
      price: productToAdd.price ?? null,
      avg_price: productToAdd.avg_price ?? null,
      price_type: productToAdd.price_type || "each",
      needs_review: productToAdd.needs_review || false,
      image: resolvedImage,
      cart_image_url: resolvedImage,
      image_url: productToAdd.image_url || null,
      verified_image_url: productToAdd.verified_image_url || null,
    };

    console.log("CART IMAGE RESOLUTION:", {
      resolvedImage,
    });

    setShoppingListItems((prev) => [...prev, cartItem]);
    setToast({ message: "Added to shopping list", type: "success" });
    return { added: true, updated: false, hasLocation };
  };

  const handleAddToContributionItems = (productToRecord = product, locationToUse = bestKnownLocation) => {
    if (!productToRecord) return;

    const itemName = String(productToRecord?.product_name || productToRecord?.name || "").trim();
    const itemBrand = String(productToRecord?.brand || "").trim();
    const itemBarcode = String(productToRecord?.barcode || "").trim();
    const itemCanonicalKey = normalizeComparableKey(
      productToRecord?.canonical_product_key || buildComparableProductKey(productToRecord)
    ) || "";

    const storeScopedLocation = locationToUse || null;
    const storeId = String(storeScopedLocation?.store_id || selectedStore?.id || "").trim();
    const resolvedContributionImage = resolveProductImage(productToRecord);

    console.log("CONTRIBUTION_IMAGE_INPUT", {
      product_name: itemName || null,
      image: productToRecord?.image || null,
      cart_image_url: productToRecord?.cart_image_url || null,
      image_url: productToRecord?.image_url || null,
      raw_photo_url: productToRecord?.raw_photo_url || null,
      verified_image_url: productToRecord?.verified_image_url || null,
      resolvedImage: resolvedContributionImage,
    });

    console.log("CONTRIBUTION_IMAGE_RESOLVED", {
      product_name: itemName || null,
      image: productToRecord?.image || null,
      cart_image_url: productToRecord?.cart_image_url || null,
      image_url: productToRecord?.image_url || null,
      raw_photo_url: productToRecord?.raw_photo_url || null,
      verified_image_url: productToRecord?.verified_image_url || null,
      resolvedImage: resolvedContributionImage,
    });

    const contributionKey = normalizeComparableKey([
      itemCanonicalKey || itemBarcode || itemName,
      storeId,
      String(storeScopedLocation?.aisle || "").trim(),
      String(storeScopedLocation?.section || "").trim(),
      String(storeScopedLocation?.shelf || "").trim(),
    ].join("|")) || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const contributionItem = {
      contribution_key: contributionKey,
      created_at: new Date().toISOString(),
      source: productToRecord?.source || submissionMethod || "scan",
      store_id: storeId || null,
      store_name: storeScopedLocation?.store_name || selectedStore?.name || "",
      barcode: itemBarcode || null,
      catalog_id: productToRecord?.catalog_id || null,
      canonical_product_key: itemCanonicalKey || null,
      product_name: itemName || "Unknown product",
      brand: itemBrand,
      category: String(productToRecord?.category || "").trim(),
      size_value: String(productToRecord?.size_value || "").trim(),
      size_unit: String(productToRecord?.size_unit || "").trim(),
      display_size: String(productToRecord?.display_size || "").trim(),
      quantity: String(productToRecord?.quantity || "1").trim() || "1",
      location: storeScopedLocation,
      image: productToRecord?.image || resolvedContributionImage,
      cart_image_url: productToRecord?.cart_image_url || resolvedContributionImage,
      image_url: productToRecord?.image_url || null,
      raw_photo_url: productToRecord?.raw_photo_url || null,
      verified_image_url: productToRecord?.verified_image_url || null,
      price: productToRecord?.price ?? storeScopedLocation?.price ?? null,
      avg_price: productToRecord?.avg_price ?? storeScopedLocation?.avg_price ?? null,
      price_type: productToRecord?.price_type || storeScopedLocation?.price_type || "each",
    };

    setContributionItems((prev) => {
      const existingIndex = prev.findIndex((item) => item?.contribution_key === contributionKey);
      if (existingIndex >= 0) {
        return prev.map((item, index) => (index === existingIndex ? { ...item, ...contributionItem } : item));
      }
      return [...prev, contributionItem];
    });
  };

  const handleRemoveFromContributionItems = (contributionKey) => {
    setContributionItems((prev) =>
      prev.filter((item) => String(item?.contribution_key || "") !== String(contributionKey || ""))
    );
  };

  const resolveUnresolvedDesiredListItemFromContribution = (productToResolve, locationToUse = null) => {
    if (!productToResolve) return;

    const targetName = normalizeComparableText(productToResolve?.product_name || productToResolve?.name);
    const targetBrand = normalizeComparableText(productToResolve?.brand);
    const targetCanonicalKey = normalizeComparableKey(
      productToResolve?.canonical_product_key || buildComparableProductKey(productToResolve)
    );
    const targetBarcode = String(productToResolve?.barcode || "").trim();
    const knownStorePrices = Array.isArray(productToResolve?.known_store_prices)
      ? productToResolve.known_store_prices
      : (Array.isArray(productToResolve?.all_known_store_prices) ? productToResolve.all_known_store_prices : []);

    let resolvedAny = false;

    setDesiredShoppingListItems((prev) =>
      prev.map((item) => {
        if (resolvedAny) return item;

        const isAlreadyResolved = Boolean(
          String(item?.barcode || "").trim() ||
          normalizeComparableKey(item?.canonical_product_key) ||
          item?.catalog_id
        );
        if (isAlreadyResolved) return item;

        const itemName = normalizeComparableText(item?.product_name || item?.name);
        const itemBrand = normalizeComparableText(item?.brand);
        const nameMatches = Boolean(targetName && itemName && targetName === itemName);
        const brandCompatible = !targetBrand || !itemBrand || targetBrand === itemBrand;

        if (!nameMatches || !brandCompatible) return item;

        resolvedAny = true;
        return {
          ...item,
          is_unresolved_desired: false,
          catalog_id: productToResolve?.catalog_id || item?.catalog_id || null,
          barcode: targetBarcode || item?.barcode || "",
          canonical_product_key: targetCanonicalKey || item?.canonical_product_key || null,
          product_name: String(productToResolve?.product_name || productToResolve?.name || item?.product_name || item?.name || "").trim(),
          name: String(productToResolve?.product_name || productToResolve?.name || item?.product_name || item?.name || "").trim(),
          brand: String(productToResolve?.brand || item?.brand || "").trim(),
          size_value: String(productToResolve?.size_value || item?.size_value || "").trim(),
          size_unit: String(productToResolve?.size_unit || item?.size_unit || "").trim(),
          display_size: String(productToResolve?.display_size || item?.display_size || "").trim(),
          quantity: String(item?.quantity || productToResolve?.quantity || "1").trim() || "1",
          selected_store_location: productToResolve?.selected_store_location || locationToUse || item?.selected_store_location || null,
          cheapest_location: productToResolve?.cheapest_location || item?.cheapest_location || null,
          known_store_prices: knownStorePrices.length > 0 ? knownStorePrices : (item?.known_store_prices || []),
          all_known_store_prices: Array.isArray(productToResolve?.all_known_store_prices)
            ? productToResolve.all_known_store_prices
            : (item?.all_known_store_prices || knownStorePrices),
          cheapest_known_price: productToResolve?.cheapest_known_price ?? item?.cheapest_known_price ?? null,
          cheapest_known_store_name: productToResolve?.cheapest_known_store_name || item?.cheapest_known_store_name || null,
          price: productToResolve?.price ?? item?.price ?? null,
          avg_price: productToResolve?.avg_price ?? item?.avg_price ?? null,
          price_type: productToResolve?.price_type || item?.price_type || "each",
          last_seen_location: locationToUse || item?.last_seen_location || null,
          source: item?.source === "manual" ? "manual_resolved" : (item?.source || "manual"),
        };
      })
    );

    if (resolvedAny) {
      setToast({ message: "Resolved a shopping-list item using new scan data", type: "success" });
    }
  };

  const handleRemoveProductFromCart = () => {

    setShoppingListItems((prev) =>
      prev.filter((item) => {
        return !doesCartItemMatchProduct(item, {
          barcode: currentProductBarcode,
          product_name: currentProductName,
          brand: currentProductBrand,
        });
      })
    );
  };

  const handleAddManualListItem = () => {
    const trimmed = manualListItemName.trim();
    if (!trimmed) return;

    const manualImage = getCleanCartImageForProduct({
      productName: trimmed,
      category: "",
      brand: "",
    });

    setShoppingListItems((prev) => [
      ...prev,
      {
        id: Date.now(),
        catalog_id: null,
        name: trimmed,
        barcode: "",
        product_name: trimmed,
        canonical_product_key: null,
        brand: "",
        source: "manual",
        is_unresolved_desired: true,
        size: null,
        unit: null,
        size_value: "",
        size_unit: "",
        display_size: "",
        quantity: "1",
        notes: "",
        known_store_prices: [],
        all_known_store_prices: [],
        selected_store_location: null,
        cheapest_location: null,
        cheapest_known_price: null,
        cheapest_known_store_name: null,
        image: manualImage,
        cart_image_url: manualImage,
        price_badge_source: "manual",
        brand_lock: false,
      },
    ]);

    setManualListItemName("");
    setCatalogSearchTerm("");
    setCatalogSearchResults([]);
    setCatalogSearchMessage("");
    setToast({ message: "Item added to shopping list", type: "success" });
  };

  const handleRemoveShoppingListItem = (indexToRemove) => {
    setShoppingListItems((prev) =>
      prev.filter((_, index) => index !== indexToRemove)
    );

    setEditingCartItemIndex((prev) => {
      if (prev === null) return null;
      if (prev === indexToRemove) {
        setCartEditForm(null);
        setCartEditError("");
        return null;
      }
      return prev > indexToRemove ? prev - 1 : prev;
    });

    setToast({ message: "Item removed", type: "success" });
  };

  const handleNavigateCartItem = (item) => {
    const name = item?.product_name || "item";
    setToast({ message: `Navigation for ${name} coming soon`, type: "success" });
  };

  const handleMarkCartItemFound = (indexToMark) => {
    setShoppingListItems((prev) =>
      prev.map((item, index) =>
        index === indexToMark
          ? {
              ...item,
              found_in_trip: true,
              found_at: new Date().toISOString(),
            }
          : item
      )
    );
    setToast({ message: "Marked as found", type: "success" });
  };

  const handleUpdateCartItemLocation = (item) => {
    if (!item) return;

    const parsedPrice = Number(item?.last_seen_location?.avg_price ?? item?.last_seen_location?.price ?? item?.avg_price ?? item?.price);
    const priceInCents = Number.isFinite(parsedPrice) && parsedPrice > 0
      ? String(Math.round(parsedPrice * 100))
      : "";

    setError("");
    openLocationPanel();
    setLocationPanelMode("quick");
    setLocationStep("aisle");
    setShowAiSummaryCard(false);
    setAwaitingProductConfirmation(false);
    setBestKnownLocation(null);
    setBarcode(item?.barcode || "");
    setProduct({
      name: item?.product_name || "Unknown product",
      brand: item?.brand || "",
      barcode: item?.barcode || "",
      size_value: item?.size_value || "",
      size_unit: item?.size_unit || "",
      quantity: item?.quantity || "1",
      source: item?.source || "cart",
    });
    setCorrectionForm((prev) => ({
      ...prev,
      product_name: item?.product_name || "",
      brand: item?.brand || "",
    }));
    setLocationForm((prev) => ({
      ...prev,
      aisle: item?.last_seen_location?.aisle || item?.aisle || "",
      section: item?.last_seen_location?.section || item?.section || "",
      shelf: item?.last_seen_location?.shelf || item?.shelf || "",
      notes: item?.notes || item?.last_seen_location?.notes || "",
      size_value: item?.size_value || prev.size_value || "",
      size_unit: item?.size_unit || prev.size_unit || "",
      quantity: item?.quantity || prev.quantity || "1",
      price: priceInCents || prev.price || "",
      price_type: item?.last_seen_location?.price_type || item?.price_type || prev.price_type || "each",
      price_source: item?.last_seen_location?.price_source || item?.price_source || prev.price_source || "",
      detected_price_unit: item?.last_seen_location?.price_unit_detected || item?.price_unit_detected || prev.detected_price_unit || "unknown",
    }));

    setToast({ message: `Update location for ${item?.product_name || "item"}`, type: "success" });
  };

  const handleSmartCartUpdateLocation = (smartItem) => {
    const item = smartItem.item;
    // Use the selected-store's route location fields for route entry (aisle/section/shelf/price).
    const routeLoc = smartItem.routeLocation || null;
    const routePrice = Number(routeLoc?.avg_price ?? routeLoc?.price);

    setProduct({
      name: item.product_name,
      brand: item.brand,
      barcode: item.barcode || "",
      size_value: item.size_value || "",
      size_unit: item.size_unit || "",
      quantity: item.quantity || "",
    });

    setBarcode(item.barcode || "");
    setError("");
    openLocationPanel();
    setLocationPanelMode("quick");
    setLocationStep("aisle");
    setShowAiSummaryCard(false);
    setAwaitingProductConfirmation(false);
    setBestKnownLocation(null);
    setLocationForm((prev) => ({
      ...prev,
      // Route location fields — selected-store DB row only.
      aisle: smartItem.aisle || "",
      section: smartItem.section || "",
      shelf: smartItem.shelf || "",
      notes: routeLoc?.notes ?? item?.last_seen_location?.notes ?? item.notes ?? "",
      // Product identity fields — always from cart item.
      size_value: item.size_value || item.size || "",
      size_unit: item.size_unit || item.unit || "",
      quantity: item.quantity || "1",
      price: Number.isFinite(routePrice) && routePrice > 0 ? String(Math.round(routePrice * 100)) : "",
      price_type: routeLoc?.price_type || item?.last_seen_location?.price_type || item.price_type || prev.price_type || "each",
      price_source: routeLoc?.price_source || item?.last_seen_location?.price_source || item.price_source || prev.price_source || "",
      detected_price_unit: routeLoc?.price_unit_detected || item?.last_seen_location?.price_unit_detected || item.price_unit_detected || prev.detected_price_unit || "unknown",
    }));

    setToast({ message: `Update location for ${item?.product_name || "item"}`, type: "success" });
  };

  const startEditingCartItem = (item, indexToEdit) => {
    const parsedPrice = Number(item?.last_seen_location?.avg_price ?? item?.last_seen_location?.price ?? item?.avg_price ?? item?.price);
    setEditingCartItemIndex(indexToEdit);
    setCartEditError("");
    setCartEditForm({
      product_name: item?.product_name || "",
      quantity: item?.quantity || "1",
      size_value: item?.size_value || item?.size || "",
      size_unit: item?.size_unit || item?.unit || "",
      notes: item?.notes || item?.last_seen_location?.notes || "",
      price: Number.isFinite(parsedPrice) && parsedPrice >= 0 ? parsedPrice.toFixed(2) : "",
    });
  };

  const cancelEditingCartItem = () => {
    setEditingCartItemIndex(null);
    setCartEditForm(null);
    setCartEditError("");
  };

  const saveEditedCartItem = (indexToSave) => {
    if (!cartEditForm) return;

    const name = (cartEditForm.product_name || "").trim();
    const quantity = (cartEditForm.quantity || "").trim();
    const sizeValue = (cartEditForm.size_value || "").trim();
    const sizeUnit = (cartEditForm.size_unit || "").trim();
    const notes = (cartEditForm.notes || "").trim();
    const priceText = (cartEditForm.price || "").trim();

    if (!name) {
      setCartEditError("Product name is required");
      return;
    }

    let parsedPrice = null;
    if (priceText) {
      parsedPrice = Number(priceText);
      if (Number.isNaN(parsedPrice) || parsedPrice < 0) {
        setCartEditError("Enter a valid price");
        return;
      }
    }

    setShoppingListItems((prev) =>
      prev.map((item, index) =>
        index === indexToSave
          ? {
              ...item,
              product_name: name,
              name,
              quantity: quantity || "1",
              size: sizeValue || null,
              unit: sizeUnit || null,
              size_value: sizeValue,
              size_unit: sizeUnit,
              notes,
              last_seen_location: parsedPrice != null
                ? {
                    ...(item?.last_seen_location || {}),
                    price: parsedPrice,
                    avg_price: parsedPrice,
                    price_type: item?.last_seen_location?.price_type || "each",
                    updated_at: new Date().toISOString(),
                  }
                : item?.last_seen_location || null,
            }
          : item
      )
    );

    setToast({ message: "Cart item updated", type: "success" });
    cancelEditingCartItem();
  };

  const handleStartPhotoFirst = async () => {
    setError("");
    setSubmissionMethod("photo-first");
    setBarcode("");
    resetAiPhotoState();
    setPriceConfirmed(false);
    setLocationForm((prev) => ({
      ...prev,
      price: "",
      price_type: "each",
      price_source: "",
      detected_price_unit: "unknown",
    }));
    setProduct(null);
    setBestKnownLocation(null);
    setAwaitingPhoto(true);
    await startLivePreview();
  };

  const handleAttachOptionalBarcode = () => {
    const candidate = optionalBarcodeInput.trim();
    if (!candidate) {
      setError("Enter a barcode or keep it blank");
      return;
    }

    setBarcode(candidate);
    setProduct((prev) => (prev ? { ...prev, barcode: candidate } : prev));
    setError("");
    setToast({ message: "Barcode attached", type: "success" });
  };

  const handleConfirmProductFromPhoto = () => {
    const productName = (
      correctionForm.product_name ||
      product?.name ||
      aiDebug?.data?.product_name ||
      ""
    ).trim();

    console.info("CONFIRM PRODUCT CONTINUE CLICKED:", {
      productName,
      correctionProductName: correctionForm.product_name,
      productNameFromState: product?.name,
    });

    if (!productName) {
      setError("Product name is required");
      return;
    }

    const confirmedBarcode = optionalBarcodeInput.trim() || product?.barcode || null;

    const confirmedProduct = {
      ...product,
      name: productName,
      brand: correctionForm.brand.trim() || product?.brand || "",
      category: correctionForm.category?.trim() || "",
      size_value: locationForm.size_value,
      size_unit: locationForm.size_unit,
      quantity: locationForm.quantity,
      barcode: confirmedBarcode,
      needs_review: false,
      product_identity_confirmed: true,
    };

    setCorrectionForm((prev) => ({
      ...prev,
      product_name: productName,
      brand: prev.brand || product?.brand || "",
    }));
    setProduct(confirmedProduct);
    setBarcode(confirmedBarcode || "");
    setAwaitingProductConfirmation(false);
    setShowAiSummaryCard(false);
    setError("");

    openLocationPanel();
    setLocationPanelMode("quick");
    setLocationStep("aisle");
    setLocationSaved(false);
    setLocationForm((prev) => ({
      ...prev,
      aisle: "",
      section: "",
      shelf: "",
      notes: "",
    }));
    setStatus("Product confirmed. Add location and price.");
  };

  const handleConfirmAiSummary = () => {
    const confirmedBarcode = optionalBarcodeInput.trim() || product?.barcode || null;

    const confirmedProduct = {
      ...product,
      name: correctionForm.product_name?.trim() || product?.name || "Unknown product",
      brand: correctionForm.brand?.trim() || product?.brand || "",
      category: correctionForm.category?.trim() || product?.category || "",
      size_value: locationForm.size_value,
      size_unit: locationForm.size_unit,
      quantity: locationForm.quantity || "1",
      barcode: confirmedBarcode,
      needs_review: false,
      product_identity_confirmed: true,
    };

    setProduct(confirmedProduct);
    setBarcode(confirmedBarcode || "");
    setAwaitingProductConfirmation(false);
    setShowAiSummaryCard(false);
    setError("");

    openLocationPanel();
    setLocationPanelMode("quick");
    setLocationStep("aisle");
    setLocationSaved(false);
    setStatus("AI summary confirmed. Add location and price.");
  };

  const handleRetakePhotosFromSummary = async () => {
    setError("");
    setStatus("Retaking photos...");
    try {
      await handleStartPhotoFirst();
    } catch (err) {
      setError(err?.message || "Unable to restart photo flow");
    }
  };

  const unlockAiField = (field) => {
    setAiAutoLockedFields((prev) => ({ ...prev, [field]: false }));
  };

  const markAiFieldEdited = (field) => {
    setAiAutoLockedFields((prev) => ({ ...prev, [field]: false }));
    setAiUserEditedFields((prev) => ({ ...prev, [field]: true }));
    setAiFieldConfidence((prev) => ({ ...prev, [field]: 0 }));
  };

  const getUserLevelTitle = () => {
    const points = Number(userPoints || currentUserProfile?.total_points || 0);
    if (points >= 500) return "Store Mapping Pro";
    if (points >= 250) return "Aisle Expert";
    if (points >= 100) return "Location Scout";
    if (points >= 25) return "Helpful Shopper";
    return "New Contributor";
  };

  const getUserLevelEmoji = () => {
    const points = Number(userPoints || currentUserProfile?.total_points || 0);
    if (points >= 500) return "🏆";
    if (points >= 250) return "🥇";
    if (points >= 100) return "🗺️";
    if (points >= 25) return "🛒";
    return "🌱";
  };

  const getNextLevelProgress = () => {
    const points = Number(userPoints || currentUserProfile?.total_points || 0);
    const thresholds = [25, 100, 250, 500];
    const next = thresholds.find((t) => points < t) || 500;
    const previous = points >= 500 ? 500 : [...thresholds].reverse().find((t) => points >= t) || 0;
    const progress = next === previous ? 100 : Math.min(100, Math.round(((points - previous) / (next - previous)) * 100));
    return { points, next, progress };
  };

  const getProfileInitials = () => {
    const authEmail = String(authUser?.email || "").trim();
    if (authEmail) return authEmail.slice(0, 2).toUpperCase();

    const isRealProfile = Boolean(currentUserProfile && !currentUserProfile?.is_guest);
    const profileDisplayName = String(currentUserProfile?.display_name || "").trim();
    if (isRealProfile && profileDisplayName) {
      const nameParts = profileDisplayName
        .split(/\s+/)
        .map((part) => String(part || "").trim())
        .filter(Boolean);

      const initials = nameParts
        .map((part) => part.charAt(0))
        .filter(Boolean)
        .slice(0, 2)
        .join("")
        .toUpperCase();

      if (initials.length >= 2) return initials;
      if (initials.length === 1) {
        return (initials + profileDisplayName.slice(1, 2)).toUpperCase();
      }

      return profileDisplayName.slice(0, 2).toUpperCase();
    }

    const profileEmail = String(currentUserProfile?.email || "").trim();
    if (isRealProfile && profileEmail) return profileEmail.slice(0, 2).toUpperCase();

    return "Profile";
  };

  const isSignedInProfile = Boolean(authUser?.id && currentUserProfile && !currentUserProfile?.is_guest);

  const handleAccountButtonClick = () => {
    if (isSignedInProfile) {
      setAppScreen("profile");
      return;
    }

    setLoginMode("signIn");
    setAuthError("");
    setShowLoginModal(true);
  };

  const getAccountButtonLabel = () => {
    if (isSignedInProfile) return getProfileInitials();
    return "Profile";
  };

  const getAiFieldIndicator = (field, hasValue) => {
    if (aiUserEditedFields[field]) {
      return {
        text: "User edited",
        style: styles.fieldConfidenceBadgeEdited,
      };
    }

    if (aiAutoLockedFields[field] && Number(aiFieldConfidence[field] || 0) >= 0.85 && hasValue) {
      return {
        text: "Auto-detected",
        style: styles.fieldConfidenceBadgeHigh,
      };
    }

    return {
      text: "Review or enter manually",
      style: null,
    };
  };

  const formatPriceType = (priceType) => {
    if (priceType === "per_lb") return "per lb";
    if (priceType === "per_oz") return "per oz";
    if (priceType === "per_kg") return "per kg";
    return "each";
  };

  const formatCentsToDollars = (centsValue) => {
    const digits = String(centsValue ?? "").replace(/\D/g, "");
    if (!digits) return "0.00";
    return (Number(digits) / 100).toFixed(2);
  };

  const normalizeUnitPrice = (row, cartItem) => {
    const price = Number(row.avg_price || row.price);
    if (Number.isNaN(price) || price <= 0) return null;

    const priceType = row.price_type || "each";
    const sizeValue = parseFloat(cartItem?.size_value || row.size_value || "");
    const sizeUnit = (cartItem?.size_unit || row.size_unit || "").toLowerCase().trim();
    const qty = parseFloat(cartItem?.quantity || row.quantity || "1") || 1;

    if (priceType === "per_lb") return price;
    if (priceType === "per_oz") return price * 16;
    if (priceType === "per_kg") return price / 2.20462;

    // price_type = "each" ? try to normalize by size
    if (!Number.isNaN(sizeValue) && sizeValue > 0) {
      if (sizeUnit === "oz") return price / sizeValue;
      if (sizeUnit === "lb") return price / sizeValue;
      if (sizeUnit === "gallon") return price;
      if (sizeUnit === "half gallon") return price * 2;
      if (sizeUnit === "liter") return price / sizeValue;
      if (["count", "pack", "box", "case"].includes(sizeUnit)) return price / qty;
    }

    return price; // fallback: raw price, lower confidence
  };

  const calculateBestStore = (shoppingList, product_locations, brandMode = "flexible") => {
    const cartItems = Array.isArray(shoppingList) ? shoppingList : [];
    const totalItems = cartItems.length;
    const priceIndex = buildPriceObservationIndex(product_locations || []);
    const storeGroups = {};
    let matchedItemCount = 0;

    cartItems.forEach((cartItem) => {
      const itemKeys = buildComparableProductKeyCandidates(cartItem);
      const priceBucket = getComparablePriceBucket(priceIndex, cartItem);
      const itemKey =
        itemKeys[0] ||
        buildComparableProductKey(cartItem) ||
        String(cartItem?.cart_item_id || cartItem?.id || cartItem?.barcode || cartItem?.product_name || "cart-item");

      console.info("CART ITEM BEING COMPARED", {
        product_name: cartItem?.product_name || cartItem?.name || null,
        barcode: cartItem?.barcode || null,
        comparableKeys: itemKeys,
      });

      if (!priceBucket) return;

      matchedItemCount += 1;

      Object.entries(priceBucket.rowsByStore || {}).forEach(([storeId, row]) => {
        if (!storeId) return;

        // Token lookups can fetch candidate rows broadly; final store comparison must pass strict identity checks.
        const matchMethod = getProductMatchMethod(cartItem, row);
        if (!matchMethod) return;

        if (brandMode === "brand_match" || brandMode === "match exact brand") {
          const cartBrand = normalizeComparableText(cartItem?.brand);
          const rowBrand = normalizeComparableText(row?.brand);
          if (matchMethod !== "barcode" && (!cartBrand || !rowBrand || cartBrand !== rowBrand)) {
            return;
          }
        }

        if (!storeGroups[storeId]) {
          storeGroups[storeId] = {
            store_id: storeId,
            store: row?.stores || (row?.store_name ? { name: row.store_name } : null),
            itemsByKey: {},
          };
        }

        const current = storeGroups[storeId].itemsByKey[itemKey];
        if (!current || isBetterPriceObservation(row, current.row)) {
          storeGroups[storeId].itemsByKey[itemKey] = {
            row: { ...row, match_method: matchMethod },
            cartItem,
          };
        }
      });
    });

    return Object.values(storeGroups)
      .map((storeGroup) => {
        const matches = Object.values(storeGroup.itemsByKey || {});
        const matched = matches.length;
        const totalPrice = matches.reduce((sum, match) => {
          const price = Number(match?.row?.avg_price ?? match?.row?.price);
          return Number.isFinite(price) && price > 0 ? sum + price : sum;
        }, 0);
        const totalConfidence = matches.reduce((sum, match) => sum + Number(match?.row?.confidence_score || 0), 0);
        const exactBrandMatches = matches.reduce((sum, match) => {
          const cartBrand = normalizeComparableText(match?.cartItem?.brand);
          const rowBrand = normalizeComparableText(match?.row?.brand);
          return cartBrand && rowBrand && cartBrand === rowBrand ? sum + 1 : sum;
        }, 0);
        const brandMatchPct = matched > 0 ? Math.round((exactBrandMatches / matched) * 100) : 0;
        const avgConfidence = matched > 0 ? Math.round(totalConfidence / matched) : 0;
        const hasEstimate = matches.some((match) => !Number.isFinite(Number(match?.row?.avg_price ?? match?.row?.price)));

        return {
          store_id: storeGroup.store_id,
          store: storeGroup.store,
          matched_count: matched,
          total_price: totalPrice,
          coverage: totalItems > 0 ? Math.round((matched / totalItems) * 100) : 0,
          avg_confidence: avgConfidence,
          brand_match_pct: brandMatchPct,
          is_estimate: hasEstimate,
          itemsByKey: storeGroup.itemsByKey,
          total_items: totalItems,
        };
      })
      .sort((a, b) => {
        if (b.coverage !== a.coverage) return b.coverage - a.coverage;
        if (a.total_price !== b.total_price) return a.total_price - b.total_price;
        return b.avg_confidence - a.avg_confidence;
      });
  };

  const handleCompareCart = async () => {
    if (shoppingListItems.length === 0) {
      setError("Add items to your shopping list first");
      return;
    }

    setIsComparingCart(true);
    setError("");

    try {
      const rpcCartItems = shoppingListItems.map((item) => ({
        barcode: String(item?.barcode || "").trim() || null,
        canonical_product_key: normalizeComparableKey(
          item?.canonical_product_key || item?.last_seen_location?.canonical_product_key || buildComparableProductKey(item)
        ) || null,
        product_name: String(item?.product_name || item?.name || "").trim() || null,
        brand: String(item?.brand || "").trim() || null,
        category: String(item?.category || "").trim() || null,
        size_value: String(item?.size_value || "").trim() || null,
        size_unit: String(item?.size_unit || "").trim() || null,
        display_size: String(item?.display_size || "").trim() || null,
        quantity: String(item?.quantity || "1").trim() || "1",
      }));

      console.info("RPC CART ITEM COUNT", rpcCartItems.length);

      const runLocalFallbackComparison = async () => {
        const cartBarcodes = [...new Set(shoppingListItems.map((item) => String(item?.barcode || "").trim()).filter(Boolean))];
        const cartKeys = [...new Set(shoppingListItems.flatMap((item) => buildComparableProductKeyCandidates(item)).filter(Boolean))];
        const cartTerms = [...new Set(shoppingListItems.flatMap((item) => [item?.product_name, item?.name, item?.brand, item?.category, item?.size_value, item?.size_unit, item?.display_size]).map(normalizeComparableText).filter(Boolean))];
        const cartLookupTerms = [...new Set(shoppingListItems.flatMap((item) => buildComparableLookupTerms(item)))];

        console.info("CART ITEMS BEING COMPARED", shoppingListItems.map((item) => ({
          product_name: item?.product_name || item?.name || null,
          brand: item?.brand || null,
          barcode: item?.barcode || null,
        })));
        console.info("CART COMPARABLE KEYS", cartKeys);

        const priceRows = await fetchComparableProductLocationRows({
          barcodes: cartBarcodes,
          canonicalKeys: cartKeys,
          terms: cartTerms,
          lookupTerms: cartLookupTerms,
        });

        console.info("FETCHED PRODUCT_LOCATIONS ROWS", priceRows.map((row) => ({
          store_id: row?.store_id || null,
          store_name: row?.store_name || row?.stores?.name || null,
          barcode: row?.barcode || null,
          canonical_product_key: row?.canonical_product_key || null,
          product_name: row?.product_name || null,
          brand: row?.brand || null,
          price: row?.avg_price ?? row?.price ?? null,
        })));

        console.info("PRICE MATCH ROWS", {
          cartItemCount: shoppingListItems.length,
          rowCount: priceRows.length,
        });

        const priceIndex = buildPriceObservationIndex(priceRows);
        console.info("PRICE INDEX KEYS", Object.keys(priceIndex || {}));

        const sortedResults = calculateBestStore(shoppingListItems, priceRows || [], brandComparisonMode);
        const localBest = sortedResults?.[0] || null;

        console.info("LOCAL_FALLBACK_RESULT_SUMMARY", {
          storeCount: sortedResults.length,
          bestStore: localBest?.store?.name || null,
          matchedCount: localBest?.matched_count || 0,
          totalPrice: localBest?.total_price || 0,
          coverage: localBest?.coverage || 0,
          hasItemBreakdown: Object.keys(localBest?.itemsByKey || {}).length > 0,
        });

        if ((!sortedResults || sortedResults.length === 0) && (import.meta.env.DEV || window.localStorage.getItem("mvpDebug") === "true")) {
          console.warn("CART COMPARISON NO MATCHES", {
            cartComparableKeys: cartKeys,
            fetchedRowCount: priceRows.length,
            cartItemCount: shoppingListItems.length,
          });
        }

        // Return data only — caller decides whether to commit to state
        return { sortedResults, priceIndex };
      };

      // Step 1: attempt RPC
      let rpcMappedResults = null;
      let rpcUsable = false;
      try {
        const { data: rpcRows, error: rpcError } = await supabase.rpc("find_cheapest_store_for_cart_v1", {
          cart_items: rpcCartItems,
          brand_mode: brandComparisonMode,
        });

        if (rpcError) throw rpcError;

        const safeRpcRows = Array.isArray(rpcRows) ? rpcRows : [];
        const rpcBestRow = safeRpcRows[0] || null;
        const rpcMatchedCount = Number(rpcBestRow?.matched_count || 0);
        const rpcTotalPrice = Number(rpcBestRow?.total_price || 0);
        const rpcCoverage = Number(rpcBestRow?.coverage_pct || 0);
        const rpcHasBreakdown = Array.isArray(rpcBestRow?.item_breakdown) && rpcBestRow.item_breakdown.length > 0;

        rpcUsable = safeRpcRows.length > 0 && rpcMatchedCount > 0 && rpcTotalPrice > 0 && rpcHasBreakdown && rpcCoverage > 0;

        console.info("RPC_RESULT_SUMMARY", {
          rowCount: safeRpcRows.length,
          bestStore: rpcBestRow?.store_name || null,
          matchedCount: rpcMatchedCount,
          totalPrice: rpcTotalPrice,
          coverage: rpcCoverage,
          hasItemBreakdown: rpcHasBreakdown,
          isUsable: rpcUsable,
        });

        if (safeRpcRows.length > 0) {
          rpcMappedResults = safeRpcRows.map((row) => {
            const breakdown = Array.isArray(row?.item_breakdown) ? row.item_breakdown : [];
            const itemsByKey = {};

            breakdown.forEach((entry, index) => {
              const key = normalizeComparableKey(
                `${entry?.cart_product_name || "item"}|${entry?.matched_product_name || ""}|${index}`
              ) || `item-${index}`;
              itemsByKey[key] = {
                row: {
                  store_id: row?.store_id || null,
                  store_name: row?.store_name || null,
                  product_name: entry?.matched_product_name || entry?.cart_product_name || "Unknown product",
                  brand: entry?.brand || null,
                  size_value: null,
                  size_unit: null,
                  display_size: entry?.size || null,
                  avg_price: entry?.price_used ?? null,
                  price: entry?.price_used ?? null,
                  price_type: entry?.price_type || "each",
                  aisle: entry?.aisle || "",
                  section: entry?.section || "",
                  shelf: entry?.shelf || "",
                  confidence_score: Number(entry?.confidence_score || 0),
                  match_method: entry?.match_method || null,
                },
                cartItem: {
                  product_name: entry?.cart_product_name || entry?.matched_product_name || "Unknown product",
                },
              };
            });

            return {
              store_id: row?.store_id || null,
              store: { name: row?.store_name || "Unknown store" },
              matched_count: Number(row?.matched_count || 0),
              total_items: Number(row?.total_item_count || shoppingListItems.length),
              total_price: Number(row?.total_price || 0),
              coverage: Number(row?.coverage_pct || 0),
              avg_confidence: Number(row?.avg_confidence || 0),
              brand_match_pct: null,
              is_estimate: false,
              decision_reason: row?.decision_reason || "",
              itemsByKey,
            };
          });
        }
      } catch (rpcErr) {
        console.warn("CART COMPARISON RPC WARNING:", rpcErr?.message || rpcErr);
      }

      // Step 2: always run local fallback so we can compare
      const { sortedResults: localResults, priceIndex: localPriceIndex } = await runLocalFallbackComparison();
      const localBest = localResults?.[0] || null;
      const localUsable = Array.isArray(localResults) && localResults.length > 0 && Number(localBest?.matched_count || 0) > 0;
      const localCoverage = Number(localBest?.coverage || 0);
      const rpcBestCoverage = Number(rpcMappedResults?.[0]?.coverage || 0);
      const localHasEqualOrBetterCoverage = localUsable && rpcUsable && localCoverage >= rpcBestCoverage;

      // Step 3: pick the best source
      let useSource;
      let finalResults;

      if (!rpcUsable && localUsable) {
        useSource = "local_fallback";
        finalResults = localResults;
      } else if (rpcUsable && !localUsable) {
        useSource = "rpc";
        finalResults = rpcMappedResults;
      } else if (rpcUsable && localUsable && localHasEqualOrBetterCoverage) {
        useSource = "local_fallback";
        finalResults = localResults;
      } else if (rpcUsable) {
        useSource = "rpc";
        finalResults = rpcMappedResults;
      } else {
        useSource = "local_fallback";
        finalResults = localResults || [];
      }

      console.info("COMPARISON_SOURCE_USED", useSource);
      console.info("FINAL STORE COMPARISON RESULTS", finalResults || []);
      console.info("CHEAPEST STORE RESULT", finalResults?.[0] || null);

      setCartPriceInsightsByKey(localPriceIndex);
      setCartComparison(finalResults);

      if (!finalResults || finalResults.length === 0) {
        console.warn("NO COMPARABLE PRICE RECORDS AFTER RPC AND FALLBACK");
        setError("No comparable price records found yet for these cart items.");
      } else {
        setToast({ message: "Cart comparison complete", type: "success" });
      }
    } catch (err) {
      setError(err.message || "Failed to compare cart");
      setToast({ message: "Failed to compare cart", type: "error" });
    } finally {
      setIsComparingCart(false);
    }
  };

  const handleManualBarcodeSubmit = async () => {
    const trimmed = manualBarcode.trim();
    if (!trimmed) {
      setError("Enter a barcode first");
      return;
    }

    if (awaitingProductConfirmation) {
      setOptionalBarcodeInput(trimmed);
      setManualBarcode("");
      setError("");
      setShowOptionalBarcodeInput(true);
      setStatus("Optional barcode captured. Attach it to this item if correct.");
      return;
    }

    setBarcode(trimmed);
    setManualBarcode("");
    setStatus("Manual barcode entered. Checking product...");

    const [knownProduct, knownLocation] = await Promise.all([
      loadKnownProduct(trimmed),
      loadBestKnownLocation(trimmed),
    ]);

    if (knownProduct) {
      setProduct(knownProduct);
      setCorrectionForm({
        product_name: knownProduct.name || "",
        brand: knownProduct.brand || "",
        category: knownProduct.category || "",
      });
      setBestKnownLocation(knownLocation || null);
      setAwaitingPhoto(false);
      setSubmissionMethod("manual barcode");
      if (knownLocation) {
        setLocationSaved(true);
        handleAddToContributionItems(knownProduct, {
          ...knownLocation,
          store_id: knownLocation?.store_id || selectedStore?.id || null,
          store_name: knownLocation?.store_name || selectedStore?.name || "",
        });
        resolveUnresolvedDesiredListItemFromContribution(knownProduct, knownLocation);
      } else {
        setLocationSaved(false);
      }

      if (!knownLocation) {
        openLocationPanel();
        setLocationPanelMode("quick");
        setLocationStep("aisle");
      }

      setStatus(
        knownLocation
          ? "Known product found from barcode. Added to scan contributions. Add to your shopping list if needed."
          : "Known product found from barcode. Add location to contribute store intelligence."
      );
      return;
    }

    setAwaitingPhoto(true);
    setStatus("New barcode entered. Capture product photo.");
    await startLivePreview();
  };

  const handleOpenLocationFromStatus = () => {
    if (!product || locationSaved) return;

    setError("");
    openLocationPanel();
    setLocationPanelMode("quick");
    setLocationStep("aisle");
  };

  const statusOpensLocationPanel =
    Boolean(product) &&
    !locationSaved &&
    [
      "Add the location for this item",
      "Add item location.",
      "Product identified. Add item location.",
      "Add this item location in the store.",
    ].includes(String(status || "").trim());

  const renderLocationWizardStep = () => {
    const handleSectionSelect = (value) => {
      setLocationForm((prev) => ({ ...prev, section: prev.section === value ? null : value }));
    };

    const handleShelfSelect = (value) => {
      setLocationForm((prev) => ({ ...prev, shelf: prev.shelf === value ? null : value }));
    };

    if (locationStep === "aisle") {
      return (
        <div>
          <div style={styles.stepLabel}>Step 1 of 3</div>
          <h3 style={styles.stepTitle}>Enter aisle or area</h3>

          <label style={styles.label}>Aisle / Area</label>
          <input
            ref={aisleInputRef}
            style={styles.input}
            value={locationForm.aisle}
            onChange={(e) =>
              setLocationForm((prev) => ({ ...prev, aisle: e.target.value }))
            }
            placeholder="Example: Aisle 7, Produce, Meat, Dairy, Bakery"
          />

          <div style={styles.rewardDescription}>
            Use whatever the store uses: aisle number, produce, bakery, dairy, meat, freezer, checkout, etc.
          </div>

          <div style={styles.quickButtonRow}>
            {[
              { label: "🔢 Numbered Aisle", aisle: null, manual: true },
              { label: "🥦 Produce Area", aisle: "Produce Area" },
              { label: "🥩 Meat & Poultry", aisle: "Meat / Poultry Area" },
              { label: "🥛 Dairy", aisle: "Dairy Area" },
              { label: "🍞 Bakery", aisle: "Bakery Area" },
              { label: "🧀 Deli", aisle: "Deli Area" },
              { label: "🧊 Frozen", aisle: "Open Freezer Area" },
              { label: "📍 Other", aisle: null, manual: true },
            ].map((option) => (
              <button
                key={`wizard-quick-area-${option.label}`}
                type="button"
                style={{
                  ...styles.quickButton,
                  ...(locationForm.aisle === option.aisle && option.aisle ? styles.quickButtonActive : {}),
                }}
                onClick={() => {
                  if (option.aisle) {
                    setLocationForm((prev) => ({ ...prev, aisle: option.aisle }));
                    setError("");
                    setLocationStep("details");
                    return;
                  }

                  setError("");
                  setLocationStep("aisle");
                  setTimeout(() => {
                    aisleInputRef.current?.focus?.();
                  }, 0);
                }}
              >
                <span style={{ fontSize: 18, lineHeight: 1 }}>{option.label.split(" ")[0]}</span>
                <span>{option.label.split(" ").slice(1).join(" ")}</span>
              </button>
            ))}
          </div>

          <div style={styles.buttonRow}>
            <button
              type="button"
              style={styles.primaryButton}
              onClick={() => {
                const aisleValue = String(locationForm.aisle || "").trim();

                if (!aisleValue) {
                  setError("Enter an aisle or area first.");
                  return;
                }
                setError("");
                setLocationStep("details");
              }}
            >
              Next
            </button>
          </div>
        </div>
      );
    }

    if (locationStep === "details") {
      return (
        <div>
          <div style={styles.stepLabel}>Step 2 of 3</div>
          <h3 style={styles.stepTitle}>Choose section and shelf</h3>

          <div style={styles.rewardDescription}>
            Tap what you see. Skip if you are not sure.
          </div>

          <label style={styles.label}>Section</label>
          <div style={styles.quickButtonRow}>
            {["Left side", "Middle", "Right side"].map((option) => (
              <button
                key={option}
                type="button"
                style={{
                  ...styles.quickButton,
                  ...(locationForm.section === option ? styles.quickButtonActive : {}),
                }}
                onClick={() => handleSectionSelect(option)}
              >
                {option}
              </button>
            ))}
          </div>

          <label style={styles.label}>Shelf</label>
          <div style={styles.quickButtonRow}>
            {["Top shelf", "Middle shelf", "Bottom shelf"].map((option) => (
              <button
                key={option}
                type="button"
                style={{
                  ...styles.quickButton,
                  ...(locationForm.shelf === option ? styles.quickButtonActive : {}),
                }}
                onClick={() => handleShelfSelect(option)}
              >
                {option}
              </button>
            ))}
          </div>

          {locationPanelMode === "full" ? (
            <>
              <label style={styles.label}>Notes (optional)</label>
              <textarea
                style={styles.textarea}
                value={locationForm.notes}
                onChange={(e) =>
                  setLocationForm((prev) => ({ ...prev, notes: e.target.value }))
                }
                placeholder="Optional details, e.g. near endcap or by freezer door"
              />
            </>
          ) : null}

          <div style={styles.buttonRow}>
            <button
              type="button"
              style={styles.secondaryButton}
              onClick={() => setLocationStep("aisle")}
            >
              Back
            </button>
            <button
              type="button"
              style={styles.primaryButton}
              onClick={() => {
                setError("");
                setLocationStep("price");
              }}
            >
              Next
            </button>
          </div>
        </div>
      );
    }

    if (locationStep === "price") {
      const aisleLower = String(locationForm.aisle || "").toLowerCase();
      const isWeightedArea =
        aisleLower.includes("produce") ||
        aisleLower.includes("meat") ||
        aisleLower.includes("poultry");
      const shouldShowEggQuantities = isEggItem(product, correctionForm);
      const priceSourceMeta = getPriceSourceMeta(locationForm.price_source);
      const detectedUnitLabel = formatDetectedUnitLabel(locationForm.detected_price_unit);
      const sizeIndicator = getAiFieldIndicator(
        "size",
        Boolean(locationForm.size_value && locationForm.size_unit)
      );
      const quantityIndicator = getAiFieldIndicator("quantity", Boolean(locationForm.quantity));
      const formattedPrice = locationForm.price
        ? (Number(locationForm.price) / 100).toFixed(2)
        : "";

      return (
        <div>
          <div style={styles.stepLabel}>Step 3 of 4</div>
          <h3 style={styles.stepTitle}>Price details</h3>

          {isWeightedArea && (
            <div style={styles.infoBox}>
              Meat and produce usually use price per lb. Change only if needed.
            </div>
          )}

          {/* -- Size / Quantity -- */}
          <label style={styles.label}>Product Size / Quantity</label>
          <input
            style={{
              ...styles.input,
              ...(aiAutoLockedFields.size ? styles.lockedInput : {}),
            }}
            value={locationForm.size_value}
            readOnly={aiAutoLockedFields.size}
            onChange={(e) => {
              markAiFieldEdited("size");
              setLocationForm((prev) => ({ ...prev, size_value: e.target.value }));
            }}
            placeholder="Example: 32"
          />

          <div style={styles.quickButtonRow}>
            {["oz", "lb", "gallon", "half gallon", "liter", "count", "pack", "box", "case"].map((unit) => (
              <button
                key={unit}
                type="button"
                style={{
                  ...styles.quickButton,
                  ...(locationForm.size_unit === unit ? styles.quickButtonActive : {}),
                }}
                disabled={aiAutoLockedFields.size}
                onClick={() => {
                  markAiFieldEdited("size");
                  setLocationForm((prev) => ({ ...prev, size_unit: unit }));
                }}
              >
                {unit}
              </button>
            ))}
          </div>

          {aiAutoLockedFields.size ? (
            <button
              type="button"
              style={styles.editInlineButton}
              onClick={() => unlockAiField("size")}
            >
              Edit size
            </button>
          ) : null}

          <div
            style={{
              ...styles.fieldConfidenceBadge,
              ...(sizeIndicator.style || {}),
            }}
          >
            {sizeIndicator.text}
          </div>

          {/* -- Egg package sizes -- */}
          {shouldShowEggQuantities && (
            <>
              <label style={styles.label}>Egg Package Size</label>
              <div style={styles.quickButtonRow}>
                {EGG_QUANTITY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    style={{
                      ...styles.quickButton,
                      ...(locationForm.quantity === option.value && !isEggQuantityOther
                        ? styles.quickButtonActive
                        : {}),
                    }}
                    onClick={() => {
                      markAiFieldEdited("quantity");
                      setIsEggQuantityOther(false);
                      setLocationForm((prev) => ({ ...prev, quantity: option.value }));
                    }}
                    disabled={aiAutoLockedFields.quantity}
                  >
                    {option.label}
                  </button>
                ))}
                <button
                  type="button"
                  style={{
                    ...styles.quickButton,
                    ...(isEggQuantityOther ? styles.quickButtonActive : {}),
                  }}
                  onClick={() => {
                    markAiFieldEdited("quantity");
                    setIsEggQuantityOther(true);
                    setLocationForm((prev) => ({ ...prev, quantity: "" }));
                  }}
                  disabled={aiAutoLockedFields.quantity}
                >
                  other
                </button>
              </div>

              {isEggQuantityOther && (
                <input
                  style={{
                    ...styles.input,
                    ...(aiAutoLockedFields.quantity ? styles.lockedInput : {}),
                  }}
                  value={locationForm.quantity}
                  readOnly={aiAutoLockedFields.quantity}
                  onChange={(e) => {
                    markAiFieldEdited("quantity");
                    setLocationForm((prev) => ({ ...prev, quantity: e.target.value }));
                  }}
                  placeholder="Enter egg package size"
                />
              )}
            </>
          )}

          {aiAutoLockedFields.quantity ? (
            <button
              type="button"
              style={styles.editInlineButton}
              onClick={() => unlockAiField("quantity")}
            >
              Edit quantity
            </button>
          ) : null}

          <div
            style={{
              ...styles.fieldConfidenceBadge,
              ...(quantityIndicator.style || {}),
            }}
          >
            {quantityIndicator.text}
          </div>

          {/* -- Price confirmation card -- */}
          <label style={styles.label}>Price</label>

          {/* Source badge ? always visible */}
          <div
            style={{
              ...styles.priceSourceBadge,
              color: priceSourceMeta.color,
              background: priceSourceMeta.background,
              borderColor: priceSourceMeta.border,
            }}
          >
            <span>{priceSourceMeta.icon}</span>
            <span>{priceSourceMeta.label}</span>
            {detectedUnitLabel ? (
              <span style={{ marginLeft: 6, fontWeight: 800 }}>({detectedUnitLabel})</span>
            ) : null}
          </div>

          {/* AI price card ? shown when AI detected a price and user hasn't confirmed yet */}
          {aiDetectedPrice && !priceConfirmed ? (
            <div ref={priceConfirmationCardRef} style={styles.aiPriceConfirmationCard}>
              <div style={styles.aiPriceConfirmationTitle}>
                AI found price: ${aiDetectedPrice.amount.toFixed(2)}
                {detectedUnitLabel ? ` ${detectedUnitLabel}` : ""}
              </div>

              <div style={styles.buttonRow}>
                {/* Confirm Price */}
                <button
                  type="button"
                  style={styles.confirmButton}
                  onClick={() => {
                    if (!locationForm.price) {
                      setError("Enter a valid price before confirming");
                      return;
                    }
                    setPriceConfirmed(true);
                    setIsEditingDetectedPrice(false);
                    setLocationForm((prev) => ({
                      ...prev,
                      price_source:
                        aiDetectedPriceEdited || prev.price_source === "user_corrected"
                          ? "user_corrected"
                          : "photo_sign",
                    }));
                    setError("");
                  }}
                >
                  Confirm Price
                </button>

                {/* Edit Price */}
                <button
                  type="button"
                  style={styles.secondaryButton}
                  onClick={() => {
                    setIsEditingDetectedPrice(true);
                    setPriceConfirmed(false);
                    setAiDetectedPriceEdited(true);
                    setLocationForm((prev) => ({
                      ...prev,
                      price_source: "user_corrected",
                    }));
                    setError("");
                    setTimeout(() => {
                      priceInputRef.current?.focus();
                    }, 0);
                  }}
                >
                  Edit Price
                </button>
              </div>
            </div>
          ) : null}

          {/* Green confirmation bar ? shown after price is confirmed */}
          {priceConfirmed && locationForm.price ? (
            <div style={styles.aiPriceConfirmedBar}>
              Confirmed price: ${formatCentsToDollars(locationForm.price)}
              {detectedUnitLabel ? ` ${detectedUnitLabel}` : ` ${formatPriceType(locationForm.price_type)}`}
            </div>
          ) : null}

          {/* Price input ? always visible; disabled when AI price exists and not yet editing */}
          <input
            ref={priceInputRef}
            style={{
              ...styles.input,
              ...(aiDetectedPrice && !isEditingDetectedPrice && !priceConfirmed
                ? { opacity: 0.5, pointerEvents: "none" }
                : {}),
            }}
            value={formattedPrice}
            readOnly={Boolean(aiDetectedPrice) && !isEditingDetectedPrice && !priceConfirmed}
            onChange={(e) => {
              const rawCents = e.target.value.replace(/\D/g, "");
              setPriceConfirmed(false);
              setAiDetectedPriceEdited(true);
              setLocationForm((prev) => ({
                ...prev,
                price: rawCents,
                price_source: "user_corrected",
              }));
              setAiDetectedPrice((prev) =>
                prev
                  ? {
                      ...prev,
                      cents: rawCents,
                      amount: rawCents ? Number(rawCents) / 100 : 0,
                      source: "user_corrected",
                    }
                  : prev
              );
            }}
            placeholder="Type 199 for $1.99"
            inputMode="numeric"
          />

          {/* Price Type selector */}
          <label style={styles.label}>Price Type</label>
          <div style={styles.quickButtonRow}>
            {[
              ["each", "Each"],
              ["per_lb", "Per lb"],
              ["per_oz", "Per oz"],
              ["per_kg", "Per kg"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                style={{
                  ...styles.quickButton,
                  ...(locationForm.price_type === value ? styles.quickButtonActive : {}),
                }}
                onClick={() => {
                  setLocationForm((prev) => ({ ...prev, price_type: value }));
                  setPriceConfirmed(false);
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Manual confirm button ? shown when no AI price, or after editing */}
          {(!aiDetectedPrice || isEditingDetectedPrice) && !priceConfirmed ? (
            <button
              type="button"
              style={styles.confirmButton}
              onClick={() => {
                if (!locationForm.price && locationForm.price_source !== "missing") {
                  setError("Enter a price or tap Skip price for now.");
                  return;
                }
                setPriceConfirmed(true);
                setIsEditingDetectedPrice(false);
                setError("");
              }}
            >
              Confirm price: ${formatCentsToDollars(locationForm.price)}{" "}
              {formatPriceType(locationForm.price_type)}
            </button>
          ) : null}

          {/* Inline warning when price exists but not yet confirmed */}
          {!priceConfirmed && locationForm.price ? (
            <div style={styles.inlineWarning}>
              Confirm or edit the price before continuing.
            </div>
          ) : null}

          <div style={styles.buttonRow}>
            <button
              type="button"
              style={styles.secondaryButton}
              onClick={() => setLocationStep("details")}
            >
              Back
            </button>
            <button
              type="button"
              style={styles.primaryButton}
              onClick={() => {
                if (!locationForm.price && locationForm.price_source !== "missing") {
                  setError("Enter a price or tap Skip price for now.");
                  return;
                }
                setError("");
                setLocationStep("review");
              }}
            >
              Next
            </button>
          </div>
        </div>
      );
    }

    return (
      <div>
        <div style={styles.stepLabel}>Step 4 of 4</div>
        <h3 style={styles.stepTitle}>Review & save</h3>

        <div style={styles.reviewBox}>
          <div><strong>Product:</strong> {product?.name || "Unknown product"}</div>
          <div><strong>Store:</strong> {selectedStore?.name || "No store selected"}</div>
          <div><strong>Aisle / Area:</strong> {locationForm.aisle || "Not set"}</div>
          <div><strong>Section:</strong> {locationForm.section || "Not set"}</div>
          <div><strong>Shelf:</strong> {locationForm.shelf || "Not set"}</div>
          <div><strong>Size:</strong> {locationForm.size_value || "Not set"} {locationForm.size_unit || ""}</div>
          <div><strong>Package Size:</strong> {locationForm.quantity || "Not set"}</div>
          <div><strong>Price:</strong> ${formatCentsToDollars(locationForm.price)} {formatPriceType(locationForm.price_type)}</div>
          {locationForm.price_source === "missing" ? (
            <div><strong>Price note:</strong> Price skipped - add later</div>
          ) : null}
        </div>

        <div style={styles.buttonRow}>
          <button
            type="button"
            style={styles.secondaryButton}
            onClick={() => setLocationStep("price")}
          >
            Back
          </button>
          <button type="button" style={styles.primaryButton} onClick={() => { logButtonClick("Save Location"); handleSaveLocation(); }}>
            Save Location
          </button>
        </div>
      </div>
    );
  };

  // ============================================================================
  // RENDER - Main UI
  // ============================================================================

  if (isCheckingProfile || isAuthLoading) {
    return (
      <div style={styles.introPage}>
        <div style={styles.introHeroCard}>
          {renderAuthDebugBanner()}
          <img
            src={mvpLogo}
            alt="MVP logo"
            style={styles.introHeaderLogo}
          />
          <h2 style={{ margin: "10px 0 6px", fontSize: 24, fontWeight: 900, color: "#0f172a" }}>
            MVP - Most Valuable Purchase
          </h2>
          <p style={{ margin: "0 0 18px", color: "#475569", fontSize: 15 }}>
            Loading your shopping session...
          </p>
          <button
            type="button"
            style={styles.secondaryButton}
            onClick={resetAppSession}
          >
            Reset App Session
          </button>
        </div>
      </div>
    );
  }

  // ============================================================
  // PROFILE SCREEN
  // ============================================================
  const renderProfileScreen = () => {
    const displayName = currentUserProfile
      ? (currentUserProfile.display_name || currentUserProfile.email || "Guest")
      : null;
    const isGuest = currentUserProfile?.is_guest ?? true;
    const points = Number(userPoints || currentUserProfile?.total_points || 0);
    const trustScore = Number(currentUserProfile?.trust_score || 0);
    const listCount = shoppingListItems.length;
    const knownCount = smartShoppingKnownItemCount;
    const missingCount = smartShoppingNeedsLocationCount;

    return (
      <div style={styles.introPage}>
        <div style={styles.introHeroCard}>
          {renderAuthDebugBanner()}

          {/* ── Header row ── */}
          <div style={styles.introHeaderRow}>
            <img src={mvpLogo} alt="MVP logo" style={styles.introHeaderLogo} />
            <span style={{ fontWeight: 900, fontSize: 18, color: "#0f172a", flex: 1 }}>Profile</span>
            <button
              type="button"
              style={{ ...styles.secondaryButton, minHeight: 36, padding: "6px 14px" }}
              onClick={handleBackToHome}
            >
              Home
            </button>
          </div>

          {/* ── Identity card ── */}
          <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 14, padding: "14px 16px", marginBottom: 12 }}>
            {currentUserProfile ? (
              <>
                <div style={{ fontSize: 22, fontWeight: 900, color: "#0f172a", marginBottom: 4 }}>{displayName}</div>
                <div style={{ display: "inline-block", background: isGuest ? "#fef9c3" : "#dbeafe", color: isGuest ? "#92400e" : "#1e3a8a", borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
                  {isGuest ? "Guest" : "Signed In"}
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 4 }}>
                  <div style={{ fontSize: 13, color: "#334155" }}><strong>{points}</strong> pts</div>
                  <div style={{ fontSize: 13, color: "#334155" }}>Trust: <strong>{trustScore}</strong></div>
                  <div style={{ fontSize: 13, color: "#334155" }}>{getUserLevelEmoji()} {getUserLevelTitle()}</div>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#334155", marginBottom: 10 }}>You are not signed in.</div>
                <button
                  type="button"
                  style={{ ...styles.introPrimaryButton, marginBottom: 8 }}
                  onClick={() => { setShowLoginModal(true); }}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  style={styles.introSecondaryButton}
                  onClick={() => {
                    const guestId = crypto.randomUUID();
                    const guestProfile = { id: guestId, display_name: "Guest", is_guest: true, total_points: 0, trust_score: 0 };
                    localStorage.setItem("currentUserProfile", JSON.stringify(guestProfile));
                    setCurrentUserProfile(guestProfile);
                    setAppScreen("store");
                  }}
                >
                  Continue as Guest
                </button>
              </>
            )}
          </div>

          {/* ── Store context ── */}
          <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 14, padding: "12px 16px", marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#1e40af", marginBottom: 6, textTransform: "uppercase" }}>Current Store</div>
            {selectedStore ? (
              <div style={{ fontSize: 14, color: "#0f172a", fontWeight: 700, marginBottom: 8 }}>
                {selectedStore.name}{selectedStore.city ? `, ${selectedStore.city}` : ""}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 8 }}>No store selected.</div>
            )}
            <button
              type="button"
              style={{ ...styles.secondaryButton, minHeight: 34, padding: "6px 12px" }}
              onClick={() => setAppScreen("store")}
            >
              {selectedStore ? "Change Store" : "Select Store"}
            </button>
          </div>

          {/* ── Desired Shopping List & Route summary ── */}
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 14, padding: "12px 16px", marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#334155", marginBottom: 6, textTransform: "uppercase" }}>Desired Shopping List</div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
              <div style={{ fontSize: 13, color: "#0f172a" }}>Items: <strong>{listCount}</strong></div>
              <div style={{ fontSize: 13, color: "#0f172a" }}>Est. total: <strong>${shoppingListEstimatedTotal.toFixed(2)}</strong></div>
            </div>
            {selectedStore ? (
              <>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#1e40af", marginBottom: 4 }}>
                  Route for {selectedStore.name}{selectedStore.city ? `, ${selectedStore.city}` : ""}
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
                  <div style={{ fontSize: 13, color: "#166534" }}>Located: <strong>{knownCount}</strong></div>
                  <div style={{ fontSize: 13, color: "#92400e" }}>Unresolved: <strong>{missingCount}</strong></div>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 8 }}>Select a store to see route details.</div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                style={{ ...styles.secondaryButton, minHeight: 34, padding: "6px 12px" }}
                onClick={() => setAppScreen("cart")}
              >
                Open Shopping List
              </button>
              <button
                type="button"
                style={{ ...styles.introPrimaryButton, minHeight: 34, padding: "6px 14px", marginBottom: 0, fontSize: 13 }}
                onClick={() => {
                  startShoppingMode();
                  if (selectedStore && shoppingListItems.length > 0 && shoppingModeAisleLabels.length > 0) {
                    setAppScreen("cart");
                  }
                }}
              >
                {selectedStore ? `Start Route for ${selectedStore.name}` : "Select Store to Start Route"}
              </button>
            </div>
          </div>

          {/* ── Actions ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            <button
              type="button"
              style={{ ...styles.introPrimaryButton, marginBottom: 0 }}
              onClick={() => {
                if (!selectedStore) {
                  setError("Select a store first.");
                  setAppScreen("store");
                  return;
                }
                setAppScreen("identify");
              }}
            >
              Add Item
            </button>

            <button
              type="button"
              style={{ ...styles.introSecondaryButton, marginBottom: 0 }}
              onClick={() => setShowItemRequestModal(true)}
            >
              Request an Item
            </button>

            <button
              type="button"
              style={{ ...styles.introSecondaryButton, marginBottom: 0 }}
              disabled={isComparingCart}
              onClick={handleCompareCart}
            >
              {isComparingCart ? "Comparing…" : "Compare My Cart"}
            </button>

            {currentUserProfile && (
              <button
                type="button"
                style={{ ...styles.changeStoreButton, marginTop: 4 }}
                onClick={handleResetProfile}
              >
                {isGuest ? "Switch Profile" : "Sign Out"}
              </button>
            )}
          </div>

          {/* ── Cart comparison result (if available) ── */}
          {cartComparison && cartComparison.length > 0 && (
            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 14, padding: "12px 16px", marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#166534", marginBottom: 8, textTransform: "uppercase" }}>Cart Comparison Results</div>
              {cartComparison.slice(0, 5).map((item, idx) => (
                <div key={idx} style={{ fontSize: 13, color: "#0f172a", marginBottom: 4 }}>
                  {item.product_name || item.name}: <strong>${Number(item.price || 0).toFixed(2)}</strong>
                  {item.store_name ? <span style={{ color: "#64748b" }}> @ {item.store_name}</span> : null}
                </div>
              ))}
            </div>
          )}

        </div>
      </div>
    );
  };

  if ((activeScreen === "landing" || !currentUserProfile) && showOnboarding) {
    return (
      <div style={styles.introPage}>
        <div style={styles.introHeroCard}>
          {renderAuthDebugBanner()}
          <img
            src={mvpLogo}
            alt="MVP logo"
            style={styles.introLogo}
          />

          <div style={styles.introSubtitle}>How MVP Works</div>

          <div style={styles.onboardingGrid}>
            <div style={styles.onboardingStepCard}>
              <div style={{ fontSize: 26, marginBottom: 10 }}>1.</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a", marginBottom: 8 }}>
                Snap the item
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.6, color: "#475569" }}>
                Capture the product label, size, and shelf price.
              </div>
            </div>

            <div style={styles.onboardingStepCard}>
              <div style={{ fontSize: 26, marginBottom: 10 }}>2.</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a", marginBottom: 8 }}>
                Let AI assist
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.6, color: "#475569" }}>
                MVP extracts product name, size, quantity, and price when visible.
              </div>
            </div>

            <div style={styles.onboardingStepCard}>
              <div style={{ fontSize: 26, marginBottom: 10 }}>3.</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a", marginBottom: 8 }}>
                Add the location
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.6, color: "#475569" }}>
                Confirm aisle, section, and shelf so others can find it faster.
              </div>
            </div>

            <div style={styles.onboardingStepCard}>
              <div style={{ fontSize: 26, marginBottom: 10 }}>4.</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a", marginBottom: 8 }}>
                Build your Smart Cart
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.6, color: "#475569" }}>
                Compare prices, group by aisle, and improve with every contribution.
              </div>
            </div>
          </div>

          <button
            style={styles.introSecondaryButton}
            onClick={() => setShowOnboarding(false)}
          >
            Back to Start
          </button>
        </div>
      </div>
    );
  }

  if (showScanditScannerTest) {
    return (
      <ScanditScannerTest
        onClose={() => {
          setShowScanditScannerTest(false);
        }}
      />
    );
  }

  if (activeScreen === "landing" || !currentUserProfile) {
    return (
      <div style={styles.introPage}>
        <div style={styles.introHeroCard}>
          {renderAuthDebugBanner()}
          <div style={styles.introHeaderRow}>
            <img
              src={mvpLogo}
              alt="MVP logo"
              style={styles.introHeaderLogo}
            />

            <button
              style={styles.leaderboardHeaderButton}
              onClick={() => window.alert("Leaderboard coming soon.")}
            >
              Leaderboard
            </button>

            <button
              style={{ ...styles.loginIconButton, fontSize: 12, fontWeight: 700, padding: "0 10px", minWidth: 64 }}
              onClick={handleAccountButtonClick}
            >
              {getAccountButtonLabel()}
            </button>
          </div>

          <h1 style={styles.introTitle}>Find Anything in Seconds</h1>
          <p style={styles.introTagline}>
            Aisle. Shelf. Done.
          </p>

          <button
            style={styles.introPrimaryButton}
            onClick={handleStartShoppingSmarter}
          >
            Start Shopping Smarter
          </button>

          {(() => {
            const { points, next, progress } = getNextLevelProgress();
            return (
              <div style={{
                background: "linear-gradient(135deg, #f0fdfa 0%, #eff6ff 100%)",
                border: "1.5px solid #c7f3ed",
                borderRadius: 16,
                padding: "16px 16px 14px",
                margin: "12px 0",
                textAlign: "left",
              }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 28, lineHeight: 1 }}>{getUserLevelEmoji()}</span>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>Your Rank</div>
                      <div style={{ fontSize: 15, fontWeight: 900, color: "#0f172a", lineHeight: 1.2 }}>{getUserLevelTitle()}</div>
                    </div>
                  </div>
                  <div style={{ background: "linear-gradient(90deg, #14b8a6, #6366f1)", borderRadius: 20, padding: "4px 12px" }}>
                    <span style={{ fontSize: 14, fontWeight: 800, color: "#ffffff" }}>{points} pts</span>
                  </div>
                </div>
                <div style={{ background: "#dbeafe", borderRadius: 999, height: 10, overflow: "hidden", marginBottom: 6 }}>
                  <div style={{ width: `${progress}%`, background: "linear-gradient(90deg, #14b8a6, #6366f1)", height: "100%", borderRadius: 999, transition: "width 0.5s ease" }} />
                </div>
                <div style={{ fontSize: 12, color: "#475569", fontWeight: 600 }}>
                  {progress}% toward next level{points < 500 ? ` — ${next - points} pts to go` : " — Max level reached! 🎉"}
                </div>
              </div>
            );
          })()}

          <button
            style={styles.introSecondaryButton}
            onClick={() => setShowOnboarding(true)}
          >
            How it works
          </button>

          <div style={styles.introCommunityCard}>
            <div style={styles.introCommunityTitle}>Can’t find an item?</div>

            <button
              style={styles.introCommunityButton}
              onClick={async () => {
                if (authUser && !currentUserProfile) {
                  await loadOrCreateSupabaseProfile(authUser);
                }

                if (!authUser && !currentUserProfile) {
                  setAuthError("Sign in or continue as guest to request help finding an item.");
                  setShowOnboarding(false);
                  setShowLoginModal(true);
                  return;
                }

                setShowOnboarding(false);
                setShowLoginModal(false);
                setShowItemRequestModal(true);
              }}
            >
              Request Help Finding an Item
            </button>

            <p style={styles.introCommunityText}>
              Tell the community what you’re looking for. If another shopper sees it, they can submit the aisle, shelf, price, or store location.
            </p>
          </div>

          <div style={{ width: "100%", marginTop: 12, marginBottom: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
              <span style={{ fontSize: 18 }}>&#x1F3AF;</span>
              <div style={{ fontSize: 16, fontWeight: 900, color: "#0f172a" }}>Today’s Missions</div>
            </div>

            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 14px", textAlign: "left" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 18 }}>&#x1F4CD;</span>
                    <div style={{ fontSize: 14, fontWeight: 800, color: "#0f172a" }}>Map 1 item location</div>
                  </div>
                  <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 20, padding: "2px 10px", fontSize: 12, fontWeight: 800, color: "#16a34a" }}>+10 pts</div>
                </div>
                <div style={{ fontSize: 12, color: "#64748b", paddingLeft: 26 }}>Add aisle, section, and shelf.</div>
              </div>

              <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 14px", textAlign: "left" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 18 }}>&#x2705;</span>
                    <div style={{ fontSize: 14, fontWeight: 800, color: "#0f172a" }}>Confirm a location</div>
                  </div>
                  <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 20, padding: "2px 10px", fontSize: 12, fontWeight: 800, color: "#16a34a" }}>+3 pts</div>
                </div>
                <div style={{ fontSize: 12, color: "#64748b", paddingLeft: 26 }}>Help verify another shopper’s find.</div>
              </div>

              <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 14px", textAlign: "left" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 18 }}>&#x270F;&#xFE0F;</span>
                    <div style={{ fontSize: 14, fontWeight: 800, color: "#0f172a" }}>Improve product details</div>
                  </div>
                  <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 20, padding: "2px 10px", fontSize: 12, fontWeight: 800, color: "#16a34a" }}>+5 pts</div>
                </div>
                <div style={{ fontSize: 12, color: "#64748b", paddingLeft: 26 }}>Correct name, brand, size, or quantity.</div>
              </div>
            </div>
          </div>

          <p style={styles.introFooter}>
            Photo-first shopping intelligence powered by community contributions.
          </p>

          {showItemRequestModal && (
            <div style={styles.modalOverlay}>
              <div style={styles.itemRequestModalCard}>
                <h2 style={styles.itemRequestModalTitle}>Request Help Finding an Item</h2>

                <label style={styles.itemRequestFieldLabel}>Product</label>
                <input
                  style={styles.itemRequestModalInput}
                  placeholder="Example: Dove body wash, Tide pods, oat milk"
                  value={itemRequestForm.product_name}
                  onChange={(e) =>
                    setItemRequestForm((prev) => ({ ...prev, product_name: e.target.value }))
                  }
                />

                {itemRequestSuggestions.length > 0 && (
                  <div style={styles.itemRequestSuggestionList}>
                    {itemRequestSuggestions.map((suggestion, index) => (
                      <button
                        key={`${suggestion.product_name}-${suggestion.brand}-${index}`}
                        type="button"
                        style={styles.itemRequestSuggestionButton}
                        onClick={() => applyItemRequestSuggestion(suggestion)}
                      >
                        <span style={styles.itemRequestSuggestionTitle}>{suggestion.product_name}</span>
                        {suggestion.brand ? (
                          <span style={styles.itemRequestSuggestionBrand}>{suggestion.brand}</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                )}

                <label style={styles.itemRequestFieldLabel}>Brand (optional)</label>
                <input
                  style={styles.itemRequestModalInput}
                  placeholder="Example: Dove, Tide, Oatly"
                  value={itemRequestForm.brand}
                  onChange={(e) =>
                    setItemRequestForm((prev) => ({ ...prev, brand: e.target.value }))
                  }
                />

                <label style={styles.itemRequestFieldLabel}>Notes (optional)</label>
                <textarea
                  style={styles.itemRequestModalInput}
                  placeholder="Size, scent, flavor, or anything helpful"
                  value={itemRequestForm.notes}
                  onChange={(e) =>
                    setItemRequestForm((prev) => ({ ...prev, notes: e.target.value }))
                  }
                />

                <div style={styles.itemRequestModalActions}>
                  <button
                    style={styles.itemRequestSubmitButton}
                    disabled={isSavingItemRequest}
                    onClick={handleSubmitItemRequest}
                  >
                    {isSavingItemRequest ? "Submitting..." : "Submit Request"}
                  </button>

                  <button
                    style={styles.itemRequestCancelButton}
                    onClick={() => {
                      setShowItemRequestModal(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>

                <div style={styles.itemRequestHint}>
                  Pick a suggestion or keep typing to refine your request.
                </div>
              </div>
            </div>
          )}

          {showLoginModal && (
            <div style={styles.modalOverlay}>
              <div style={styles.modalCard}>
                <h2 style={styles.modalTitle}>Login</h2>

                <input
                  style={styles.modalInput}
                  placeholder="Email"
                  value={loginForm.username}
                  onChange={(e) =>
                    setLoginForm({ ...loginForm, username: e.target.value })
                  }
                />

                <div style={styles.authModeToggleRow}>
                  <button
                    type="button"
                    style={{
                      ...styles.authModeToggleButton,
                      ...(loginMode === "signIn" ? styles.authModeToggleButtonActive : {}),
                    }}
                    onClick={() => {
                      setLoginMode("signIn");
                      setAuthError("");
                    }}
                  >
                    Sign In
                  </button>
                  <button
                    type="button"
                    style={{
                      ...styles.authModeToggleButton,
                      ...(loginMode === "signUp" ? styles.authModeToggleButtonActive : {}),
                    }}
                    onClick={() => {
                      setLoginMode("signUp");
                      setAuthError("");
                    }}
                  >
                    Create Account
                  </button>
                </div>

                <input
                  type="password"
                  style={styles.modalInput}
                  placeholder="Password"
                  value={loginForm.password}
                  onChange={(e) =>
                    setLoginForm({ ...loginForm, password: e.target.value })
                  }
                />

                <button
                  style={styles.modalPrimaryButton}
                  disabled={isSubmittingAuth}
                  onClick={handleSupabaseAuth}
                >
                  {isSubmittingAuth
                    ? "Signing in..."
                    : loginMode === "signUp"
                      ? "Create Account"
                      : "Login"}
                </button>

                {loginMode === "signIn" ? (
                  <button
                    type="button"
                    style={styles.modalSecondaryButton}
                    disabled={isSubmittingAuth}
                    onClick={handleForgotPassword}
                  >
                    Forgot Password?
                  </button>
                ) : null}

                {authError ? (
                  <div style={styles.errorText}>{authError}</div>
                ) : null}

                {authError.toLowerCase().includes("email not confirmed") ||
                authError.toLowerCase().includes("account created") ||
                authError.toLowerCase().includes("confirm your email") ? (
                  <button
                    type="button"
                    style={styles.modalSecondaryButton}
                    onClick={handleResendConfirmationEmail}
                    disabled={isSubmittingAuth}
                  >
                    Resend Confirmation Email
                  </button>
                ) : null}

                <button
                  style={styles.modalSecondaryButton}
                  onClick={async () => {
                    try {
                      if (authUser) {
                        await supabase.auth.signOut();
                      }
                    } catch (err) {
                      console.error("AUTH SIGN OUT ERROR:", err);
                    }

                    localStorage.removeItem("currentUserProfile");
                    const safeUserId = authUser?.id || crypto.randomUUID();
                    const guestProfile = {
                      id: safeUserId,
                      display_name: "Guest",
                      email: null,
                      trust_score: 0,
                      points: 0,
                      total_points: 0,
                      is_guest: true,
                      created_at: new Date().toISOString(),
                    };
                    localStorage.setItem("currentUserProfile", JSON.stringify(guestProfile));
                    setAuthUser(null);
                    setCurrentUserProfile(guestProfile);
                    setAuthError("");
                    setAppScreen("store");
                    setShowLoginModal(false);
                    setShowOnboarding(false);
                  }}
                >
                  Continue as Guest
                </button>

                <button
                  type="button"
                  style={styles.modalSecondaryButton}
                  onClick={() => {
                    setShowLoginModal(false);
                    setShowOnboarding(false);
                  }}
                >
                  Cancel / Back
                </button>

                <button
                  style={styles.modalClose}
                  onClick={() => setShowLoginModal(false)}
                >
                  ×
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (activeScreen === "profile") {
    return renderProfileScreen();
  }

  if (currentUserProfile) {

    return (
      <div style={styles.page}>
        <div style={styles.container}>
          {renderAuthDebugBanner()}
          {showItemRequestModal && (
            <div style={styles.modalOverlay}>
              <div style={styles.itemRequestModalCard}>
                <h2 style={styles.itemRequestModalTitle}>Request Help Finding an Item</h2>

                <label style={styles.itemRequestFieldLabel}>Product</label>
                <input
                  style={styles.itemRequestModalInput}
                  placeholder="Example: Dove body wash, Tide pods, oat milk"
                  value={itemRequestForm.product_name}
                  onChange={(e) =>
                    setItemRequestForm((prev) => ({ ...prev, product_name: e.target.value }))
                  }
                />

                {itemRequestSuggestions.length > 0 && (
                  <div style={styles.itemRequestSuggestionList}>
                    {itemRequestSuggestions.map((suggestion, index) => (
                      <button
                        key={`${suggestion.product_name}-${suggestion.brand}-${index}`}
                        type="button"
                        style={styles.itemRequestSuggestionButton}
                        onClick={() => applyItemRequestSuggestion(suggestion)}
                      >
                        <span style={styles.itemRequestSuggestionTitle}>{suggestion.product_name}</span>
                        {suggestion.brand ? (
                          <span style={styles.itemRequestSuggestionBrand}>{suggestion.brand}</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                )}

                <label style={styles.itemRequestFieldLabel}>Brand (optional)</label>
                <input
                  style={styles.itemRequestModalInput}
                  placeholder="Example: Dove, Tide, Oatly"
                  value={itemRequestForm.brand}
                  onChange={(e) =>
                    setItemRequestForm((prev) => ({ ...prev, brand: e.target.value }))
                  }
                />

                <label style={styles.itemRequestFieldLabel}>Notes (optional)</label>
                <textarea
                  style={styles.itemRequestModalInput}
                  placeholder="Size, scent, flavor, or anything helpful"
                  value={itemRequestForm.notes}
                  onChange={(e) =>
                    setItemRequestForm((prev) => ({ ...prev, notes: e.target.value }))
                  }
                />

                <div style={styles.itemRequestModalActions}>
                  <button
                    style={styles.itemRequestSubmitButton}
                    disabled={isSavingItemRequest}
                    onClick={handleSubmitItemRequest}
                  >
                    {isSavingItemRequest ? "Submitting..." : "Submit Request"}
                  </button>

                  <button
                    style={styles.itemRequestCancelButton}
                    onClick={() => {
                      setShowItemRequestModal(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>

                <div style={styles.itemRequestHint}>
                  Pick a suggestion or keep typing to refine your request.
                </div>
              </div>
            </div>
          )}

          <div style={styles.profileHeader}>
            <button
              type="button"
              style={{
                ...styles.secondaryButton,
                minHeight: 34,
                padding: "6px 12px",
              }}
              onClick={handleBackToHome}
            >
              Home
            </button>
            <span>{currentUserProfile.display_name}</span>
            <span>{currentUserProfile.total_points || 0} pts</span>
            <span>Level 1 Contributor</span>
            <button
              type="button"
              style={{ ...styles.changeStoreButton, background: "#dbeafe", color: "#1e3a8a", border: "1px solid #93c5fd" }}
              onClick={handleAccountButtonClick}
            >
              {getAccountButtonLabel()}
            </button>
          </div>

        <div style={styles.headerMetaRow}>
          <div style={styles.pointsHeaderBadge}>
            {userPoints} pts
          </div>
          <div style={styles.progressPlaceholder}>Level 1 Contributor</div>
        </div>

        <h1 style={styles.title}>MVP - Most Valuable Purchase</h1>
        <p style={styles.subtitle}>
          Identify items by photo first, confirm AI details, and add barcode only
          when available. Barcode is optional for produce, meat, poultry, bakery,
          deli, and store-labeled items.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginBottom: 14 }}>
          <button
            type="button"
            onClick={() => {
              logButtonClick("Store");
              navigateToScreen("store");
            }}
            style={{
              ...styles.secondaryButton,
              minHeight: 40,
              background: activeScreen === "store" ? "#dbeafe" : "#f8fafc",
              border: activeScreen === "store" ? "1px solid #93c5fd" : "1px solid #cbd5e1",
              color: activeScreen === "store" ? "#1e3a8a" : "#0f172a",
              fontWeight: 800,
            }}
          >
            Store
          </button>
          <button
            type="button"
            onClick={() => {
              logButtonClick("Identify Item");
              if (!selectedStore) {
                setError("Select a store first.");
                navigateToScreen("store");
                return;
              }
              navigateToScreen("identify");
            }}
            style={{
              ...styles.secondaryButton,
              minHeight: 40,
              background: activeScreen === "identify" ? "#dbeafe" : "#f8fafc",
              border: activeScreen === "identify" ? "1px solid #93c5fd" : "1px solid #cbd5e1",
              color: activeScreen === "identify" ? "#1e3a8a" : "#0f172a",
              fontWeight: 800,
            }}
          >
            Identify Item
          </button>
          <button
            type="button"
            onClick={() => {
              logButtonClick("Cart");
              navigateToScreen("cart");
            }}
            style={{
              ...styles.secondaryButton,
              minHeight: 40,
              background: activeScreen === "cart" ? "#dbeafe" : "#f8fafc",
              border: activeScreen === "cart" ? "1px solid #93c5fd" : "1px solid #cbd5e1",
              color: activeScreen === "cart" ? "#1e3a8a" : "#0f172a",
              fontWeight: 800,
            }}
          >
            Cart
          </button>
        </div>

        {/* ================= PROFILE STATUS ================= */}
        <div style={{ ...styles.infoBox, marginBottom: 14, borderRadius: 14, boxShadow: "0 6px 18px rgba(15, 23, 42, 0.08)", background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#166534" }}>
            Logged in as: {currentUserProfile.display_name}
          </div>
        </div>

        {/* ================= DESIRED SHOPPING LIST + ROUTE ================= */}
        {effectiveScreen === "cart" && (
        <div style={{ ...styles.infoBox, marginBottom: 14, borderRadius: 14, boxShadow: "0 6px 18px rgba(15, 23, 42, 0.08)" }}>
          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 19, fontWeight: 900, color: "#0f172a" }}>Shopping List (Desired Items)</div>
              <div style={{ fontSize: 12, color: "#475569", fontWeight: 700 }}>
                Comparison uses shared product intelligence; route remains selected-store only.
              </div>
            </div>
            <button
              type="button"
              style={{ ...styles.secondaryButton, width: "auto", minHeight: 34, padding: "0 10px", fontSize: 12, flexShrink: 0 }}
              onClick={shoppingMode ? exitShoppingMode : startShoppingMode}
            >
              {shoppingMode ? "Exit Shopping Mode" : "Start Shopping Route"}
            </button>
          </div>

          {/* Stats row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginBottom: 12 }}>
            <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 10, padding: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#1e40af", textTransform: "uppercase" }}>Estimated Total</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: "#0f172a" }}>${shoppingListEstimatedTotal.toFixed(2)}</div>
            </div>
            <div style={{ border: "1px solid #bbf7d0", background: "#f0fdf4", borderRadius: 10, padding: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#166534", textTransform: "uppercase" }}>Known Items</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: "#0f172a" }}>{smartShoppingKnownItemCount}</div>
            </div>
            <div style={{ border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 10, padding: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#92400e", textTransform: "uppercase" }}>Unresolved Items</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: "#0f172a" }}>{smartShoppingNeedsLocationCount}</div>
            </div>
            <div style={{ border: "1px solid #ddd6fe", background: "#f5f3ff", borderRadius: 10, padding: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#5b21b6", textTransform: "uppercase" }}>Scan Contributions</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: "#0f172a" }}>{scanCartItems.length}</div>
            </div>
          </div>

          {smartShoppingItemsMissingSelectedStoreLocation.length > 0 ? (
            <div style={{ marginBottom: 10, fontSize: 12, color: "#6d28d9", fontWeight: 700 }}>
              {smartShoppingItemsMissingSelectedStoreLocation.length} item(s) have known price/location context in shared data but not for this selected store route yet.
            </div>
          ) : null}

          {/* State message */}
          <div style={{
            background: "#f1f5f9",
            border: "1px solid #e2e8f0",
            borderRadius: 10,
            padding: "10px 14px",
            marginBottom: 12,
            textAlign: "center",
            fontSize: 13,
            fontWeight: 700,
            color: "#334155",
          }}>
            {smartCartStateMessage}
          </div>

          {/* Empty state */}
          {smartShoppingKnownItemCount + smartShoppingNeedsLocationCount === 0 ? (
            <div style={{ fontSize: 14, fontWeight: 700, color: "#334155" }}>
              Your desired shopping list is empty. Add items to begin.
            </div>
          ) : (
            <>
              {/* -- Items to Locate (always promoted to top) -- */}
              {smartShoppingItemsToLocate.length > 0 ? (
                <div style={{ border: "1px solid #fcd34d", background: "#fffbeb", borderRadius: 12, padding: 10, marginBottom: 14 }}>
                  <div style={{ fontSize: 14, fontWeight: 900, color: "#92400e", marginBottom: 8 }}>
                    Help Locate These Items
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {smartShoppingItemsToLocate.map((smartItem) => (
                      <div key={`locate-${smartItem.originalIndex}`} style={{ border: "1px solid #fde68a", borderRadius: 10, background: "#fff7d6", padding: 8 }}>
                        <div style={{ fontSize: 14, fontWeight: 800, color: "#7c2d12", marginBottom: 2 }}>
                          {smartItem.product_name || "Unknown item"}
                        </div>
                        {smartItem.brand ? (
                          <div style={{ fontSize: 12, color: "#92400e", marginBottom: 4, fontWeight: 700 }}>
                            {smartItem.brand}
                          </div>
                        ) : null}
                        <div style={{ fontSize: 12, color: "#b45309", marginBottom: 8 }}>
                          Be the first to add this location
                        </div>
                        <button
                          type="button"
                          style={{ ...styles.primaryButton, width: "auto", minHeight: 32, padding: "0 10px", fontSize: 12 }}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            console.log("ADD LOCATION BUTTON CLICKED");
                            setError("");
                            openLocationPanel();
                            setLocationPanelMode("quick");
                            setLocationStep("aisle");

                            const item = smartItem?.item || {};
                            setProduct({
                              name: item.product_name || "",
                              brand: item.brand || "",
                              barcode: item.barcode || "",
                              size_value: item.size_value || "",
                              size_unit: item.size_unit || "",
                              quantity: item.quantity || "",
                            });
                            setBarcode(item.barcode || "");
                            setCorrectionForm({
                              product_name: item.product_name || "",
                              brand: item.brand || "",
                              category: item.category || "",
                            });
                            setLocationForm({
                              aisle: "",
                              section: "",
                              shelf: "",
                              notes: "",
                              size_value: item.size_value || "",
                              size_unit: item.size_unit || "",
                              quantity: item.quantity || "",
                              price: item.last_seen_location?.price != null ? String(Math.round(Number(item.last_seen_location.price) * 100)) : "",
                              price_type: item.last_seen_location?.price_type || "each",
                              price_source: "",
                              detected_price_unit: "unknown",
                            });
                            setStatus("Add the location for this item");
                          }}
                        >
                          Add Location (+{LOCATION_SUBMISSION_POINTS})
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* -- Shopping Mode: step progress + current aisle -- */}
              {shoppingMode ? (
                <>
                  <div style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 10,
                    background: "#f0fdf4",
                    border: "1px solid #bbf7d0",
                    borderRadius: 10,
                    padding: "8px 12px",
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: "#166534" }}>
                      Step {shoppingModeCurrentAisleIndex + 1} of {shoppingModeAisleLabels.length}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 900, color: "#0f172a" }}>
                      {shoppingModeActiveAisleLabel}
                    </div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 10 }}>
                    {shoppingModeVisibleAisleGroups.map((group) => {
                      const aisleBadge = getConfidenceBadge(group.aisleConfidence);
                      return (
                        <div
                          key={`sm-aisle-${group.aisleLabel}`}
                          style={{ border: "1px solid #dbeafe", background: "#ffffff", borderRadius: 12, padding: 10 }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}>
                            <div style={{ fontSize: 15, fontWeight: 900, color: "#1e40af" }}>{group.aisleLabel}</div>
                            <div style={{
                              border: `1px solid ${aisleBadge.border}`,
                              background: aisleBadge.background,
                              color: aisleBadge.color,
                              borderRadius: 999,
                              padding: "2px 8px",
                              fontSize: 11,
                              fontWeight: 800,
                            }}>
                              {group.aisleConfidence}% • {aisleBadge.label}
                            </div>
                          </div>
                          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>
                            {group.items.length} item{group.items.length !== 1 ? "s" : ""}
                          </div>
                          <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, background: "#f8fafc" }}>
                            {group.items.map((smartItem, itemIndex) => {
                              const itemBadge = getConfidenceBadge(smartItem.confidence_score);
                              const score = Number(smartItem.confidence_score || 0);
                              const routeItemImage = resolveProductImage(smartItem.item || {});
                              const confidenceText = score >= 90
                                ? "High confidence"
                                : score >= 70
                                  ? "Moderate confidence"
                                  : "Needs verification";
                              const isTrustedContributor = currentUserProfile?.trust_score >= 50;
                              return (
                                <div
                                  key={`sm-item-${smartItem.originalIndex}`}
                                  style={{
                                    padding: "10px 8px",
                                    borderTop: itemIndex > 0 ? "1px solid #e2e8f0" : "none",
                                  }}
                                >
                                  <div style={{ width: "100%", marginBottom: 8 }}>
                                    <img
                                      src={routeItemImage}
                                      alt={smartItem.product_name || "Route item"}
                                      style={styles.cartItemImage}
                                      onError={(e) => {
                                        e.currentTarget.src = MVP_PLACEHOLDER_IMAGE;
                                      }}
                                    />
                                  </div>
                                  <div style={{ fontSize: 15, fontWeight: 800, color: "#0f172a", marginBottom: 2 }}>
                                    {smartItem.product_name || "Unknown item"}
                                  </div>
                                  {smartItem.brand ? (
                                    <div style={{ fontSize: 13, color: "#475569", fontWeight: 700, marginBottom: 3 }}>
                                      {smartItem.brand}
                                    </div>
                                  ) : null}
                                  {(smartItem.section || smartItem.shelf) ? (
                                    <div style={{ fontSize: 12, color: "#64748b", marginBottom: 3 }}>
                                      {[smartItem.section && `Section: ${smartItem.section}`, smartItem.shelf && `Shelf: ${smartItem.shelf}`].filter(Boolean).join(" • ")}
                                    </div>
                                  ) : null}
                                  {smartItem.price ? (
                                    <div style={{ fontSize: 13, fontWeight: 800, color: "#166534", marginBottom: 4 }}>
                                      ${Number(smartItem.price).toFixed(2)}
                                    </div>
                                  ) : null}
                                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                                    <div style={{
                                      border: `1px solid ${itemBadge.border}`,
                                      background: itemBadge.background,
                                      color: itemBadge.color,
                                      borderRadius: 999,
                                      padding: "2px 8px",
                                      fontSize: 11,
                                      fontWeight: 800,
                                      display: "inline-block",
                                    }}>
                                      {score}% • {itemBadge.label}
                                    </div>
                                    <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>{confidenceText}</div>
                                    {isTrustedContributor ? (
                                      <div style={{ fontSize: 10, color: "#166534", fontWeight: 700, background: "#dcfce7", border: "1px solid #86efac", borderRadius: 999, padding: "1px 6px" }}>
                                        Trusted contributor impact active
                                      </div>
                                    ) : null}
                                  </div>
                                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                    <button
                                      type="button"
                                      style={{ ...styles.primaryButton, width: "auto", minHeight: 30, padding: "0 10px", fontSize: 12 }}
                                      onClick={() => {
                                        const item = smartItem.item;
                                        setProduct({
                                          name: item.product_name || "",
                                          brand: item.brand || "",
                                          barcode: item.barcode || "",
                                          size_value: item.size_value || "",
                                          size_unit: item.size_unit || "",
                                          quantity: item.quantity || "",
                                        });
                                        setBarcode(item.barcode || "");
                                        setToast({ message: "Location confirmation ready", type: "success" });
                                      }}
                                    >
                                      Confirm Location (+{LOCATION_CONFIRMATION_POINTS})
                                    </button>
                                    <button
                                      type="button"
                                      style={{ ...styles.secondaryButton, width: "auto", minHeight: 30, padding: "0 10px", fontSize: 12 }}
                                      onClick={() => {
                                        const item = smartItem.item;
                                        setProduct({
                                          name: item.product_name || "",
                                          brand: item.brand || "",
                                          barcode: item.barcode || "",
                                          size_value: item.size_value || "",
                                          size_unit: item.size_unit || "",
                                          quantity: item.quantity || "",
                                        });
                                        setBarcode(item.barcode || "");
                                        setLocationForm({
                                          aisle: item.last_seen_location?.aisle || "",
                                          section: item.last_seen_location?.section || "",
                                          shelf: item.last_seen_location?.shelf || "",
                                          notes: item.last_seen_location?.notes || item.notes || "",
                                          size_value: item.size_value || "",
                                          size_unit: item.size_unit || "",
                                          quantity: item.quantity || "",
                                          price: item.last_seen_location?.price != null ? String(Math.round(Number(item.last_seen_location.price) * 100)) : "",
                                          price_type: item.last_seen_location?.price_type || "each",
                                          price_source: "",
                                          detected_price_unit: "unknown",
                                        });
                                        openLocationPanel();
                                        setLocationPanelMode("quick");
                                        setLocationStep("aisle");
                                        setStatus("Update this item location");
                                      }}
                                    >
                                      Fix Location
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>

                          {/* Next / Finish aisle button */}
                          <div style={{ marginTop: 12 }}>
                            <button
                              type="button"
                              style={{ ...styles.primaryButton, width: "100%", minHeight: 38, fontSize: 14 }}
                              onClick={goToNextAisle}
                            >
                              {shoppingModeCurrentAisleIndex >= shoppingModeAisleLabels.length - 1
                                ? "Finish Shopping Route"
                                : "Next Aisle"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                /* -- Browse Mode: all aisles -- */
                <>
                  <div style={{ fontSize: 13, color: "#475569", marginBottom: 12 }}>
                    Start Smart Shopping Route to view aisle-by-aisle navigation and location confidence details.
                  </div>
                </>
              )}
            </>
          )}
        </div>
        )}

        {effectiveScreen === "cart" && (
        <div style={{ ...styles.rewardsSection }}>
          <div style={styles.rewardsSectionHeader}>Shopping List / Smart Cart</div>
          <button
            type="button"
            onClick={() => {
              cloudShoppingListExplicitClearRef.current = true;
              localStorage.removeItem("shoppingListItems");
              setShoppingListItems([]);
              setToast({ message: "Test cart cleared", type: "success" });
            }}
            style={{
              ...styles.secondaryButton,
              minHeight: 36,
              width: "auto",
              padding: "0 12px",
              fontSize: 13,
              marginBottom: 10,
            }}
          >
            Clear Test Cart
          </button>
          {window.localStorage.getItem("mvpDebug") === "true" ? (
            <button
              type="button"
              onClick={handleManualCloudListTest}
              style={{
                ...styles.secondaryButton,
                minHeight: 36,
                width: "auto",
                padding: "0 12px",
                fontSize: 13,
                marginBottom: 10,
                marginLeft: 8,
              }}
            >
              Test Cloud List Save/Load
            </button>
          ) : null}
          {canUseSavedShoppingList() && shoppingListItems.length > 0 ? (
            <div style={{ marginBottom: 10 }}>
              <button
                type="button"
                onClick={handleManualCloudListSave}
                disabled={isManualCloudSaveInProgress}
                style={{
                  ...styles.secondaryButton,
                  minHeight: 36,
                  width: "auto",
                  padding: "0 12px",
                  fontSize: 13,
                }}
              >
                Save Shopping List
              </button>
              {manualCloudSaveStatus ? (
                <div style={{ fontSize: 12, color: manualCloudSaveStatus === "Could not save list" ? "#b91c1c" : "#166534", marginTop: 6, fontWeight: 700 }}>
                  {isManualCloudSaveInProgress ? "Saving..." : manualCloudSaveStatus}
                </div>
              ) : null}
            </div>
          ) : null}
          {currentUserProfile?.is_guest ? (
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 10 }}>
              Sign in to save this list for next time.
            </div>
          ) : null}
          <div style={styles.rewardDescription}>
            Build your cart first, then MVP can help suggest the most frugal or sensible store based on known prices and item availability.
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 14, marginBottom: 14 }}>
            <input
              type="text"
              value={manualListItemName}
              onChange={(e) => {
                setManualListItemName(e.target.value);
                setCatalogSearchTerm(e.target.value);
              }}
              placeholder="Add item e.g. ketchup, milk, eggs"
              style={{ ...styles.input, marginBottom: 0, flex: 1 }}
            />
            <button
              onClick={handleAddManualListItem}
              style={{ ...styles.primaryButton, width: "auto", padding: "0 16px" }}
            >
              Add
            </button>
          </div>

          {(catalogSearchTerm.trim().length >= 2 || isSearchingCatalog) && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#475569", textTransform: "uppercase", letterSpacing: 0.5, margin: "0 2px 8px" }}>
                Shared Catalog Matches
              </div>

              {isSearchingCatalog ? (
                <div style={{ fontSize: 13, color: "#64748b", padding: "8px 2px" }}>
                  Searching catalog...
                </div>
              ) : null}

              {!isSearchingCatalog && catalogSearchMessage ? (
                <div style={{ fontSize: 13, color: "#64748b", padding: "8px 2px" }}>
                  {catalogSearchMessage}
                </div>
              ) : null}

              {!isSearchingCatalog && catalogSearchTerm.trim().length >= 2 && catalogSearchResults.length === 0 ? (
                <div
                  style={{
                    border: "1px solid #dbeafe",
                    background: "#f8fafc",
                    borderRadius: 10,
                    padding: 10,
                    marginBottom: 8,
                  }}
                >
                  <div style={{ fontSize: 13, color: "#334155", fontWeight: 700, marginBottom: 8 }}>
                    No catalog matches yet. Add it to the database when you shop.
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      style={{ ...styles.primaryButton, width: "auto", minHeight: 34, padding: "0 12px", marginBottom: 0 }}
                      onClick={handleStartPhotoFirst}
                    >
                      Use Photo
                    </button>
                    <button
                      type="button"
                      style={{ ...styles.secondaryButton, width: "auto", minHeight: 34, padding: "0 12px", marginBottom: 0 }}
                      onClick={startScanner}
                    >
                      Scan Barcode
                    </button>
                    <button
                      type="button"
                      style={{ ...styles.secondaryButton, width: "auto", minHeight: 34, padding: "0 12px", marginBottom: 0 }}
                      onClick={() => {
                        setShowItemRequestModal(true);
                        setItemRequestForm((prev) => ({
                          ...prev,
                          product_name: catalogSearchTerm.trim(),
                        }));
                      }}
                    >
                      Request Help Finding This
                    </button>
                  </div>
                </div>
              ) : null}

              {!isSearchingCatalog && catalogSearchResults.length > 0 ? (
                <div style={{ display: "grid", gap: 8 }}>
                  {catalogSearchResults.map((result) => {
                    const location = result.selected_store_location;
                    const hasStoreLocation = Boolean(location?.aisle || location?.section || location?.shelf);
                    const hasKnownPriceElsewhere = Boolean(!hasStoreLocation && result?.hasKnownPriceAtAnotherStore);
                    const displayImage = resolveProductImage(result);
                    const selectedPrice = Number(location?.avg_price ?? location?.price ?? 0) || null;
                    const cheapestKnownPrice = Number(result?.cheapest_known_price ?? 0) || null;
                    const cheapestLocationPrice = Number(result?.cheapest_location?.avg_price ?? result?.cheapest_location?.price ?? 0) || null;
                    const offerPrice = Number(result?.offers?.[0]?.price ?? 0) || null;
                    const displayPrice = selectedPrice ?? cheapestKnownPrice ?? cheapestLocationPrice ?? offerPrice;

                    const selectedLocationText = [location?.aisle, location?.section, location?.shelf].filter(Boolean).join(" • ");
                    const cheapestLocationText = [result?.cheapest_location?.aisle, result?.cheapest_location?.section, result?.cheapest_location?.shelf].filter(Boolean).join(" • ");
                    const offerLocationText = [result?.offers?.[0]?.aisle, result?.offers?.[0]?.section, result?.offers?.[0]?.shelf].filter(Boolean).join(" • ");
                    const bestLocationText = selectedLocationText || cheapestLocationText || offerLocationText;

                    const bestKnownStoreName = result?.cheapest_known_store_name || result?.cheapest_location?.store_name || result?.offers?.[0]?.store_name || null;
                    const displayPriceLabel = selectedPrice != null
                      ? "$" + Number(selectedPrice).toFixed(2) + " " + formatPriceType(location?.price_type)
                      : (displayPrice != null
                        ? `Best known price: $${Number(displayPrice).toFixed(2)}${bestKnownStoreName ? ` at ${bestKnownStoreName}` : ""}`
                        : null);

                    return (
                      <div
                        key={`catalog-${result.id || result.barcode || result.product_name}`}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "52px 1fr auto",
                          gap: 10,
                          alignItems: "center",
                          border: "1px solid #e2e8f0",
                          borderRadius: 10,
                          padding: 8,
                          background: hasStoreLocation ? "#f0fdf4" : "#f8fafc",
                          cursor: "pointer",
                        }}
                        onClick={() => addSharedCatalogResultToCart(result)}
                      >
                        <img
                          src={displayImage}
                          alt={result.product_name || "Catalog product"}
                          style={{ width: 52, height: 52, borderRadius: 8, objectFit: "cover", background: "#fff" }}
                          onError={(e) => {
                            e.currentTarget.src = MVP_PLACEHOLDER_IMAGE;
                          }}
                        />

                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {result.product_name || "Unknown product"}
                          </div>
                          <div style={{ fontSize: 12, color: "#475569" }}>
                            {result.brand || "Unknown brand"}
                            {result.category ? ` • ${result.category}` : ""}
                            {result.size_value || result.size_unit
                              ? ` • ${String(result.size_value || "").trim()} ${String(result.size_unit || "").trim()}`.trim()
                              : ""}
                          </div>
                          {selectedStore?.id ? (
                            <div style={{ fontSize: 12, color: hasStoreLocation ? "#166534" : "#64748b", marginTop: 2 }}>
                              {bestLocationText
                                ? bestLocationText
                                : hasKnownPriceElsewhere
                                  ? "Known price found at another store; selected store still needs location."
                                  : "No known location for this store yet"}
                              {displayPriceLabel ? ` • ${displayPriceLabel}` : ""}
                            </div>
                          ) : null}
                        </div>

                        <button
                          type="button"
                          style={{ ...styles.secondaryButton, minHeight: 36, width: "auto", padding: "0 12px", whiteSpace: "nowrap" }}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            addSharedCatalogResultToCart(result);
                          }}
                        >
                          Add
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          )}

          <div style={{ marginTop: 4, marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, color: "#475569", margin: "2px 2px 8px" }}>
              In-Store Scanned Cart
            </div>

            {scanCartItems.length === 0 ? (
              <div style={{ ...styles.rewardEmptyState, marginBottom: 8 }}>
                No scanned items yet.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {scanCartItems.map((item, index) => {
                  const contributionLocation = item?.last_seen_location || item?.location || null;
                  const contributionImage = resolveProductImage(item);
                  const contributionPrice = contributionLocation?.avg_price ?? contributionLocation?.price ?? item?.avg_price ?? item?.price;
                  const contributionPriceType = contributionLocation?.price_type || item?.price_type || "each";

                  console.log("IN_STORE_SCANNED_CART_IMAGE_RENDER", {
                    product_name: item?.product_name || null,
                    image: item?.image || null,
                    cart_image_url: item?.cart_image_url || null,
                    image_url: item?.image_url || null,
                    raw_photo_url: item?.raw_photo_url || null,
                    verified_image_url: item?.verified_image_url || null,
                    resolvedImage: contributionImage,
                  });

                  return (
                    <div
                      key={`${item?.contribution_key || item?.barcode || item?.product_name || "scan"}-${index}`}
                      style={{
                        border: "1px solid #e2e8f0",
                        borderRadius: 10,
                        padding: 8,
                        background: "#f8fafc",
                        display: "grid",
                        gridTemplateColumns: "52px 1fr",
                        gap: 10,
                        alignItems: "start",
                      }}
                    >
                      <img
                        src={contributionImage}
                        alt={item?.product_name || "Scanned item"}
                        style={{ width: 52, height: 52, borderRadius: 8, objectFit: "cover", background: "#fff" }}
                        onError={(e) => {
                          e.currentTarget.src = MVP_PLACEHOLDER_IMAGE;
                        }}
                      />

                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a" }}>
                          {item?.product_name || "Unknown product"}
                        </div>
                        <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>
                          {item?.brand || "Unknown brand"}
                          {(item?.display_size || item?.size_value || item?.size_unit)
                            ? ` • ${item?.display_size || `${item?.size_value || ""}${item?.size_unit ? ` ${item?.size_unit}` : ""}`.trim()}`
                            : ""}
                          {item?.quantity ? ` • qty ${item.quantity}` : ""}
                        </div>
                        <div style={{ fontSize: 12, color: "#334155", marginTop: 2 }}>
                          {(contributionLocation?.store_name || item?.store_name) ? `Store: ${contributionLocation?.store_name || item?.store_name}` : "Store: Unknown"}
                          {(contributionLocation?.aisle || contributionLocation?.section || contributionLocation?.shelf)
                            ? ` • ${[contributionLocation?.aisle, contributionLocation?.section, contributionLocation?.shelf].filter(Boolean).join(" / ")}`
                            : ""}
                        </div>
                        <div style={{ fontSize: 12, color: "#334155", marginTop: 2 }}>
                          {contributionPrice != null
                            ? `$${Number(contributionPrice).toFixed(2)} ${formatPriceType(contributionPriceType)}`
                            : "Price not added yet"}
                        </div>

                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                          <button
                            type="button"
                            style={{ ...styles.secondaryButton, width: "auto", minHeight: 32, padding: "0 10px", fontSize: 12, marginBottom: 0 }}
                            onClick={async () => {
                              await handleAddToShoppingList(item, contributionLocation || item?.location || null);
                            }}
                          >
                            Add to Shopping List
                          </button>
                          <button
                            type="button"
                            style={{ ...styles.editButton, width: "auto", minHeight: 32, padding: "0 10px", fontSize: 12, marginBottom: 0 }}
                            onClick={() => handleRemoveFromContributionItems(item?.contribution_key)}
                          >
                            Remove from Scanned Cart
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {shoppingListItems.length > 0 ? (
            <>
              <div style={{ fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, color: "#475569", margin: "2px 2px 8px" }}>
                Detailed cart
              </div>
              <div style={styles.rewardsGrid}>
                {!shoppingMode ? shoppingListItems.map((item, cartIndex) => {
                      const itemPrice = item.avg_price ?? item.price;
                      const priceTypeLabel = formatPriceType(item.price_type);
                      const isEditing = editingCartItemIndex === cartIndex;
                      const isEggCartItem = isEggText(item.product_name);
                      const lastSeen = item.last_seen_location || null;
                      const lastSeenLocationText = [lastSeen?.aisle, lastSeen?.section, lastSeen?.shelf].filter(Boolean).join(" • ");
                      const displayImageUrl = resolveProductImage(item);
                      const itemKey = buildComparableProductKey(item);
                      const priceInsight = getComparablePriceBucket(cartPriceInsightsByKey, item);
                      const cheapestKnownRow = priceInsight?.cheapestRow || null;
                      const otherKnownPrices = Object.values(priceInsight?.rowsByStore || {})
                        .filter((row) => row && row !== cheapestKnownRow)
                        .map((row) => ({
                          storeName: row?.stores?.name || row?.store_name || "Unknown store",
                          price: Number(row?.avg_price ?? row?.price ?? 0) || null,
                          priceType: row?.price_type || "each",
                        }))
                        .filter((entry) => entry.price != null);
                      const cheapestKnownPrice = Number(cheapestKnownRow?.avg_price ?? cheapestKnownRow?.price ?? 0) || null;
                      const cheapestKnownStoreName = cheapestKnownRow?.stores?.name || cheapestKnownRow?.store_name || null;
                      const routeStorePrice = selectedStore?.id && item?.barcode
                        ? storeRouteLocations[String(item.barcode).trim()] || null
                        : null;
                      const routeStorePriceValue = Number(routeStorePrice?.avg_price ?? routeStorePrice?.price ?? 0) || null;
                      // Check offers array for best known price (from catalog hydration)
                      const itemOffers = Array.isArray(item?.offers) ? item.offers : [];
                      const bestOffer = itemOffers.length > 0 ? itemOffers[0] : null;
                      const bestOfferPrice = bestOffer ? Number(bestOffer.price) : null;
                      const bestOfferStore = bestOffer?.store_name || null;
                      const hasKnownPrice = bestOfferPrice != null || cheapestKnownPrice != null || itemPrice != null || routeStorePriceValue != null;

                      console.log("SMART CART RENDER IMAGE:", {
                        productName: item.product_name,
                        cart_image_url: item.cart_image_url,
                        image: item.image,
                        verified_image_url: item.verified_image_url,
                        displayImageUrl,
                      });

                      return (
                        <div
                          key={`${item.barcode || item.product_name || "item"}-${cartIndex}`}
                          style={styles.rewardCard}
                          onClick={() => {
                            setEditingCartItemIndex(cartIndex);
                            setCartEditForm({
                              ...item,
                              product_name: item.product_name || "",
                              brand: item.brand || "",
                              size_value: item.size_value || "",
                              size_unit: item.size_unit || "",
                              quantity: item.quantity || "",
                              price: item.last_seen_location?.price ?? item.price ?? "",
                              price_type: item.last_seen_location?.price_type || item.price_type || "each",
                              aisle: item.last_seen_location?.aisle || "",
                              section: item.last_seen_location?.section || "",
                              shelf: item.last_seen_location?.shelf || "",
                            });
                            setCartEditError("");
                          }}
                        >
                          <div style={{ width: "100%", marginBottom: 8 }}>
                            <img
                              src={displayImageUrl}
                              alt={item.product_name || item.name || "Cart item"}
                              style={styles.cartItemImage}
                              onError={(e) => {
                                console.warn("CART IMAGE FALLBACK:", {
                                  productName: item.product_name || item.name,
                                  attemptedSrc: displayImageUrl,
                                });
                                e.currentTarget.src = MVP_PLACEHOLDER_IMAGE;
                              }}
                            />
                          </div>
                  <div style={styles.rewardTitle}>{item.product_name}</div>
                  {item.needs_review ? (
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#b45309", background: "#fef3c7", borderRadius: 6, padding: "2px 7px", marginBottom: 4, display: "inline-block" }}>
                      ⚠ Needs review
                    </div>
                  ) : null}
                  {bestOfferPrice != null ? (
                    <div style={{ fontSize: 12, color: "#166534", fontWeight: 800, marginBottom: 3 }}>
                      Best known price: ${bestOfferPrice.toFixed(2)} at {bestOfferStore || "Unknown store"}
                    </div>
                  ) : cheapestKnownPrice != null ? (
                    <div style={{ fontSize: 12, color: "#166534", fontWeight: 800, marginBottom: 3 }}>
                      Cheapest known: {cheapestKnownStoreName || "Unknown store"} ${cheapestKnownPrice.toFixed(2)}
                    </div>
                  ) : null}
                  {bestOfferPrice != null && itemOffers.length > 1 ? (
                    <div style={{ fontSize: 12, color: "#64748b", marginBottom: 3 }}>
                      Also known at {itemOffers.length - 1} other store{itemOffers.length - 1 !== 1 ? "s" : ""}
                    </div>
                  ) : !bestOfferPrice && otherKnownPrices.length > 0 ? (
                    <div style={{ fontSize: 12, color: "#64748b", marginBottom: 3 }}>
                      Other known price: {otherKnownPrices.slice(0, 2).map((entry) => `${entry.storeName} $${entry.price.toFixed(2)}`).join(" • ")}
                    </div>
                  ) : null}
                  {/* Last seen location from best offer or last_seen_location */}
                  {(bestOffer?.aisle || bestOffer?.section || bestOffer?.shelf) ? (
                    <div style={{ fontSize: 12, color: "#475569", marginBottom: 3 }}>
                      Last seen: {[bestOffer.aisle, bestOffer.section, bestOffer.shelf].filter(Boolean).join(" • ")}
                    </div>
                  ) : null}
                  {!hasKnownPrice ? (
                    <div style={{ fontSize: 12, color: "#64748b", marginBottom: 3, fontWeight: 700 }}>
                      No known price yet
                    </div>
                  ) : null}
                  {routeStorePriceValue != null && shoppingMode ? (
                    <div style={{ fontSize: 12, color: "#1d4ed8", marginBottom: 3, fontWeight: 700 }}>
                      Selected route: ${routeStorePriceValue.toFixed(2)} {formatPriceType(routeStorePrice?.price_type)}
                    </div>
                  ) : null}
                  <div style={styles.rewardDescription}>
                    {item.brand || "Unknown brand"}
                    {(item.display_size || item.size_value || item.size_unit)
                      ? ` • ${item.display_size || `${item.size_value || ""}${item.size_unit ? ` ${item.size_unit}` : ""}`.trim()}`
                      : ""}
                    {item.quantity ? ` • qty ${item.quantity}` : ""}
                    {itemPrice != null
                      ? ` • $${Number(itemPrice).toFixed(2)} ${priceTypeLabel}`
                      : item.price_source === "missing"
                        ? " • Price not added yet"
                        : ""}
                    {item.notes ? ` • note: ${item.notes}` : ""}
                  </div>

                  {lastSeen ? (
                    <div style={{ ...styles.rewardDescription, marginTop: -2, fontSize: 12 }}>
                      {lastSeenLocationText ? `Last seen: ${lastSeenLocationText}` : "Last seen location saved"}
                      {lastSeen.avg_price != null
                        ? ` • ${Number(lastSeen.avg_price).toFixed(2)} ${formatPriceType(lastSeen.price_type)}`
                        : lastSeen.price != null
                          ? ` • ${Number(lastSeen.price).toFixed(2)} ${formatPriceType(lastSeen.price_type)}`
                          : ""}
                    </div>
                  ) : null}

                  {isEditing && cartEditForm ? (
                    <div style={{ marginTop: 8 }}>
                      <label style={styles.label}>Product name</label>
                      <input
                        type="text"
                        value={cartEditForm.product_name}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          e.stopPropagation();
                          setCartEditForm((prev) => ({ ...prev, product_name: e.target.value }));
                        }}
                        style={styles.input}
                      />

                      <label style={styles.label}>Quantity</label>
                      <input
                        type="text"
                        value={cartEditForm.quantity}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          e.stopPropagation();
                          setCartEditForm((prev) => ({ ...prev, quantity: e.target.value }));
                        }}
                        style={styles.input}
                        placeholder="e.g. 1, dozen, 2 pack"
                      />

                      <label style={styles.label}>Size</label>
                      <input
                        type="text"
                        value={cartEditForm.size_value}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          e.stopPropagation();
                          setCartEditForm((prev) => ({ ...prev, size_value: e.target.value }));
                        }}
                        style={styles.input}
                        placeholder="e.g. 16"
                      />

                      <label style={styles.label}>Unit</label>
                      <input
                        type="text"
                        value={cartEditForm.size_unit}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          e.stopPropagation();
                          setCartEditForm((prev) => ({ ...prev, size_unit: e.target.value }));
                        }}
                        style={styles.input}
                        placeholder="e.g. oz"
                      />

                      {isEggCartItem ? (
                        <div style={styles.quickButtonRow}>
                          {EGG_QUANTITY_OPTIONS.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              style={{
                                ...styles.quickButton,
                                ...(String(cartEditForm.quantity || "").toLowerCase() === option.value
                                  ? styles.quickButtonActive
                                  : {}),
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setCartEditForm((prev) => ({ ...prev, quantity: option.value }));
                              }}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      ) : null}

                      <label style={styles.label}>Price</label>
                      <input
                        type="text"
                        value={cartEditForm.price}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          e.stopPropagation();
                          setCartEditForm((prev) => ({ ...prev, price: e.target.value }));
                        }}
                        style={styles.input}
                        placeholder="e.g. 3.49"
                        inputMode="decimal"
                      />

                      <label style={styles.label}>Area / location notes</label>
                      <textarea
                        value={cartEditForm.notes}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          e.stopPropagation();
                          setCartEditForm((prev) => ({ ...prev, notes: e.target.value }));
                        }}
                        style={styles.textarea}
                        placeholder="Optional note"
                      />

                      {cartEditError ? <div style={styles.errorBox}>{cartEditError}</div> : null}

                      <div style={styles.buttonRow}>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            logButtonClick("Save", {
                              originalIndex: cartIndex,
                              productName: item.product_name,
                            });
                            saveEditedCartItem(cartIndex);
                          }}
                          style={styles.primaryButton}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            logButtonClick("Cancel", { productName: item.product_name });
                            setEditingCartItemIndex(null);
                            setCartEditForm(null);
                            setCartEditError("");
                          }}
                          style={styles.secondaryButton}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            logButtonClick("Remove", { originalIndex: cartIndex, productName: item.product_name });
                            handleRemoveShoppingListItem(cartIndex);
                          }}
                          style={styles.editButton}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {isEditing && item.brand ? (
                    <div style={{ display: "flex", gap: 6, marginTop: 6, marginBottom: 6 }}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          console.log("BRAND LOCK TOGGLE:", {
                            originalIndex: cartIndex,
                            productName: item.product_name,
                            brandLock: false,
                          });
                          setShoppingListItems((prev) =>
                            prev.map((el, index) =>
                              index === cartIndex
                                ? { ...el, brand_lock: false }
                                : el
                            )
                          );
                        }}
                        style={{
                          ...styles.quickButton,
                          fontSize: 12,
                          padding: "4px 10px",
                          background: !item.brand_lock ? "#dbeafe" : "#f8fafc",
                          borderColor: !item.brand_lock ? "#2563eb" : "#dbe4ef",
                          color: !item.brand_lock ? "#1d4ed8" : "#475569",
                        }}
                      >
                        Brand flexible
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          console.log("BRAND LOCK TOGGLE:", {
                            originalIndex: cartIndex,
                            productName: item.product_name,
                            brandLock: true,
                          });
                          setShoppingListItems((prev) =>
                            prev.map((el, index) =>
                              index === cartIndex
                                ? { ...el, brand_lock: true }
                                : el
                            )
                          );
                        }}
                        style={{
                          ...styles.quickButton,
                          fontSize: 12,
                          padding: "4px 10px",
                          background: item.brand_lock ? "#dbeafe" : "#f8fafc",
                          borderColor: item.brand_lock ? "#2563eb" : "#dbe4ef",
                          color: item.brand_lock ? "#1d4ed8" : "#475569",
                        }}
                      >
                        Stick to this brand
                      </button>
                    </div>
                  ) : null}
                        </div>
                      );
                    }) : null}
              </div>
            </>
          ) : (
            <div style={styles.rewardEmptyState}>No items yet.</div>
          )}

          {shoppingListItems.length > 0 ? (
            <div style={{ marginTop: 10, fontSize: 14, color: "#0f172a", fontWeight: 700 }}>
              Cart total (items with price): ${shoppingListEstimatedTotal.toFixed(2)}
            </div>
          ) : null}

          <label style={{ ...styles.label, marginBottom: 6 }}>Brand preference</label>
          <div style={{ ...styles.quickButtonRow, marginBottom: 12 }}>
            <button
              type="button"
              onClick={() => {
                logButtonClick("Flexible");
                console.log("GLOBAL BRAND MODE:", "flexible");
                setBrandComparisonMode("flexible");
              }}
              style={{
                ...styles.quickButton,
                background: brandComparisonMode === "flexible" ? "#dbeafe" : "#f8fafc",
                borderColor: brandComparisonMode === "flexible" ? "#2563eb" : "#dbe4ef",
                color: brandComparisonMode === "flexible" ? "#1d4ed8" : "#475569",
              }}
            >
              Flexible
            </button>
            <button
              type="button"
              onClick={() => {
                logButtonClick("Match exact brand");
                console.log("GLOBAL BRAND MODE:", "brand_match");
                setBrandComparisonMode("brand_match");
              }}
              style={{
                ...styles.quickButton,
                background: brandComparisonMode === "brand_match" ? "#dbeafe" : "#f8fafc",
                borderColor: brandComparisonMode === "brand_match" ? "#2563eb" : "#dbe4ef",
                color: brandComparisonMode === "brand_match" ? "#1d4ed8" : "#475569",
              }}
            >
              Match exact brand
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              logButtonClick("Find Cheapest Store", { cartSize: shoppingListItems.length });
              handleCompareCart();
            }}
            disabled={shoppingListItems.length === 0 || isComparingCart}
            title={shoppingListItems.length === 0 ? "Add items to your cart first" : undefined}
            style={{ ...styles.primaryButton, width: "100%", marginTop: 12 }}
          >
            {isComparingCart ? "Comparing..." : "Find Cheapest Store"}
          </button>

          {cartComparison ? (
            cartComparison.length > 0 ? (
              <div style={{ ...styles.rewardsGrid, marginTop: 12 }}>
                <div style={styles.rewardCard}>
                  <div style={styles.rewardTitle}>
                    Best store: {cartComparisonBestStore?.store?.name || "Unknown store"}
                  </div>
                  <div style={styles.rewardDescription}>
                    Estimated total: ${Number(cartComparisonBestStore?.total_price || 0).toFixed(2)}
                  </div>
                  <div style={styles.rewardDescription}>
                    Matched {Number(cartComparisonBestStore?.matched_count || 0)} of {cartComparisonBestStoreTotalItems} items
                  </div>
                  <div style={styles.rewardDescription}>
                    Coverage: {Number(cartComparisonBestStoreCoverage).toFixed(2)}%
                  </div>
                  <div style={styles.rewardDescription}>
                    Average confidence: {Number(cartComparisonBestStore?.avg_confidence || 0).toFixed(2)}%
                  </div>
                  <div style={styles.rewardDescription}>
                    {cartComparisonBestStore?.decision_reason || "Chosen based on coverage, total price, and confidence."}
                  </div>
                  {cartComparisonBestStore?.is_estimate ? (
                    <div style={{ fontSize: 12, color: "#92400e", background: "#fef3c7", borderRadius: 8, padding: "4px 8px", marginTop: 6 }}>
                      Comparison estimate - more scans improve accuracy.
                    </div>
                  ) : null}

                  {cartComparisonWinningRows.length > 0 ? (
                    <div style={{ marginTop: 10, borderTop: "1px solid #bbf7d0", paddingTop: 10 }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: "#166534", marginBottom: 6, textTransform: "uppercase" }}>
                        Item breakdown
                      </div>
                      {cartComparisonWinningRows.map((row, index) => {
                        const locationParts = [row.aisle, row.section, row.shelf].filter(Boolean).join(" • ");
                        return (
                          <div key={`${row.product_name || "item"}-${index}`} style={{ fontSize: 13, color: "#0f172a", marginBottom: 6 }}>
                            <div style={{ fontWeight: 700 }}>
                              {row.product_name} — ${row.price != null ? Number(row.price).toFixed(2) : "0.00"} {formatPriceType(row.price_type)}
                            </div>
                            <div style={{ fontSize: 12, color: "#475569" }}>
                              Confidence: {Number(row.confidence_score || 0).toFixed(0)}% • Match: {String(row.match_method || "unknown").replace("_", " ")}
                            </div>
                            {locationParts ? (
                              <div style={{ fontSize: 12, color: "#64748b" }}>
                                {locationParts}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>

                {cartComparisonAlternativeStores.length > 0 ? (
                  <div style={styles.infoBox}>
                    <div style={styles.rewardTitle}>Alternatives</div>
                    {cartComparisonAlternativeStores.map((result, index) => {
                      const alternativeTotal = Number(result?.total_price || 0);
                      const bestTotal = Number(cartComparisonBestStore?.total_price || 0);
                      const difference = alternativeTotal - bestTotal;
                      const resultTotalItems = Number(result?.total_item_count ?? result?.total_items ?? shoppingListItems.length) || shoppingListItems.length;
                      return (
                        <div
                          key={`${result.store_id || "store-alt"}-${index}`}
                          style={{ ...styles.rewardDescription, marginBottom: 8, paddingBottom: 8, borderBottom: index < cartComparisonAlternativeStores.length - 1 ? "1px solid #dbeafe" : "none" }}
                        >
                          <div style={{ fontWeight: 700, color: "#0f172a" }}>
                            {result.store?.name || "Unknown store"}
                          </div>
                          <div style={{ fontSize: 12, color: "#475569" }}>
                            Total: ${alternativeTotal.toFixed(2)} • Matched {Number(result?.matched_count || 0)} of {resultTotalItems} • {difference >= 0 ? "+" : ""}${difference.toFixed(2)} vs best
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : (
              <>
                <div style={{ ...styles.rewardEmptyState, marginTop: 12 }}>
                  No comparable price records found yet for these cart items.
                </div>
                {(import.meta.env.DEV || window.localStorage.getItem("mvpDebug") === "true") ? (
                  <div style={{ ...styles.infoBox, marginTop: 8 }}>
                    <div style={styles.rewardTitle}>Debug diagnostics</div>
                    <div style={styles.rewardDescription}>
                      Cart item keys: {cartComparisonDebugKeys.length > 0 ? cartComparisonDebugKeys.join(" | ") : "none"}
                    </div>
                    <div style={styles.rewardDescription}>Matched rows count: 0</div>
                    <div style={styles.rewardDescription}>Missing canonical keys count: {cartComparisonMissingCanonicalCount}</div>
                  </div>
                ) : null}
              </>
            )
          ) : null}
        </div>
        )}

        {effectiveScreen === "store" && selectedStore ? (
          <div style={{ marginBottom: 14 }}>
            <div style={styles.storeBadgeRow}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={styles.storeBadge}>Store: {selectedStore.name}</div>
                <div style={{ fontSize: 12, color: "#475569", fontWeight: 600 }}>
                  {getStoreAddressSubtitle(selectedStore)}
                </div>
              </div>
              <button
                onClick={() => {
                  setSelectedStore(null);
                  localStorage.removeItem("selectedStore");
                }}
                style={styles.changeStoreButton}
              >
                Change Store
              </button>
            </div>
            <button
              type="button"
              onClick={() => setAppScreen("identify")}
              style={{ ...styles.primaryButton, width: "100%", minHeight: 44, marginTop: 10 }}
            >
              Continue to Item Identification
            </button>
          </div>
        ) : null}

        {effectiveScreen === "identify" && !selectedStore ? (
          <div style={styles.infoBox}>
            Choose a store first to start identifying items.
          </div>
        ) : null}

        {!selectedStore ? (
          <div style={{ ...styles.card, display: effectiveScreen === "store" ? "block" : "none" }}>
            <div style={styles.sectionTitle}>Choose Your Store</div>
            <p style={{ fontSize: 15, color: '#475569', marginBottom: 16, lineHeight: 1.5 }}>
              Select the store before scanning so item locations stay accurate.
            </p>

            <button
              onClick={handleDetectStore}
              disabled={isDetectingStore || isFindingNearbyStores}
              style={{ ...styles.secondaryButton, width: '100%', marginBottom: 16, minHeight: 48 }}
            >
              {isDetectingStore || isFindingNearbyStores ? 'Searching...' : 'Use My Location to Find Stores'}
            </button>

            {storeDetectionMessage ? (
              <div style={{ ...styles.infoBox, marginBottom: 16 }}>{storeDetectionMessage}</div>
            ) : null}

            {nearbyStores.length > 0 && (
              <>
                <div style={{ ...styles.sectionTitle, fontSize: 15, marginBottom: 10 }}>Nearby Stores</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
                  {nearbyStores.map((s, idx) => (
                    <button
                      key={s.google_place_id ?? s.id ?? idx}
                      onClick={() => {
                        const localStore = {
                          id: s.id ?? s.google_place_id ?? `${s.name}-${s.latitude}-${s.longitude}`,
                          name: s.name,
                          address: s.address ?? null,
                          city: s.city ?? "Honolulu",
                          state: s.state ?? "HI",
                          zip: s.zip ?? null,
                          postal_code: s.postal_code ?? null,
                          latitude: s.latitude ?? null,
                          longitude: s.longitude ?? null,
                          google_place_id: s.google_place_id ?? null,
                        };

                        console.info("STORE NEARBY: selected without DB upsert", localStore);
                        handlePickStore(localStore);
                      }}
                      style={styles.storeOptionButton}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', flex: 1, gap: 2 }}>
                        <span style={{ fontWeight: 700 }}>{s.name}</span>
                        <span style={{ fontSize: 12, color: '#64748b' }}>{getStoreAddressSubtitle(s)}</span>
                      </div>
                      {s.distance_miles != null ? (
                        <span style={{ fontSize: 13, color: '#3b82f6', fontWeight: 700, whiteSpace: 'nowrap', marginLeft: 8 }}>
                          {s.distance_miles.toFixed(1)} mi
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </>
            )}

            {suggestedStore && (
              <div style={styles.suggestedStoreCard}>
                <div style={styles.suggestedStoreTitle}>Are you at {suggestedStore.name}?</div>
                <div style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
                  {getStoreAddressSubtitle(suggestedStore)}
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    onClick={() => {
                      console.info("STORE DETECT: confirmed suggested store", suggestedStore);
                      handlePickStore(suggestedStore);
                      setSuggestedStore(null);
                    }}
                    style={{ ...styles.confirmButton, flex: 1, minHeight: 44 }}
                  >
                    Yes, use this store
                  </button>
                  <button
                    onClick={() => setSuggestedStore(null)}
                    style={{ ...styles.editButton, flex: 1, minHeight: 44 }}
                  >
                    No, choose manually
                  </button>
                </div>
              </div>
            )}

            <label style={styles.label}>Search stores</label>
            <input
              type="text"
              value={manualStoreName}
              onChange={(e) => {
                const value = e.target.value;
                setStoreSearchQuery(value);
                if (storeSearchTimeoutRef.current) {
                  clearTimeout(storeSearchTimeoutRef.current);
                }

                storeSearchTimeoutRef.current = setTimeout(() => {
                  handleStoreSearch(value);
                }, 500);
              }}
              placeholder="e.g. Target, Walmart, Safeway"
              style={{ ...styles.input, marginBottom: 12 }}
            />

            {isLoadingStores ? (
              <div style={styles.infoBox}>Loading stores...</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                {filteredStores.map((s, idx) => (
                  <button
                    key={s.google_place_id ?? s.id ?? `${s.name}-${idx}`}
                    onClick={() => {
                      const localStore = {
                        id: s.id ?? s.google_place_id ?? `${s.name}-${s.latitude}-${s.longitude}`,
                        name: s.name,
                        address: s.address ?? null,
                        city: s.city ?? "Honolulu",
                        state: s.state ?? "HI",
                        zip: s.zip ?? null,
                        postal_code: s.postal_code ?? null,
                        latitude: s.latitude ?? null,
                        longitude: s.longitude ?? null,
                        google_place_id: s.google_place_id ?? null,
                      };

                      console.info("STORE SEARCH: selected store option", localStore);
                      handlePickStore(localStore);
                    }}
                    style={styles.storeOptionButton}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                      <span style={{ fontWeight: 700 }}>{s.name}</span>
                      <span style={{ fontSize: 13, color: '#64748b' }}>
                        {getStoreAddressSubtitle(s)}
                      </span>
                    </div>
                    {s.distance_miles != null ? (
                      <span style={{ fontSize: 13, color: '#3b82f6', fontWeight: 700, marginLeft: "auto" }}>
                        {s.distance_miles.toFixed(1)} mi
                      </span>
                    ) : null}
                  </button>
                ))}

                {storeSearchQuery && filteredStores.length === 0 && (
                  <button
                    onClick={handleCreateManualStore}
                    style={{ ...styles.storeOptionButton, borderStyle: 'dashed', color: '#2563eb' }}
                  >
                    <span style={{ fontWeight: 700 }}>Use "{manualStoreName.trim()}" as my store</span>
                  </button>
                )}

                {storeSearchQuery && filteredStores.length === 0 && (
                  <div style={{ fontSize: 14, color: '#94a3b8', marginTop: 4 }}>
                    No matching stores found. Tap "Find Nearby Stores" or use the option above to add it manually.
                  </div>
                )}
              </div>
            )}

            {error ? <div style={styles.errorBox}>{error}</div> : null}
          </div>
        ) : (
          <div style={{ display: effectiveScreen === "identify" ? "block" : "none" }}>
            <div style={styles.storeBadgeRow}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={styles.storeBadge}>
              Store: {selectedStore.name}
              </div>
              <div style={{ fontSize: 12, color: "#475569", fontWeight: 600 }}>
                {getStoreAddressSubtitle(selectedStore)}
              </div>
              </div>
              <button
                onClick={() => {
                  setSelectedStore(null);
                  localStorage.removeItem("selectedStore");
                }}
                style={styles.changeStoreButton}
              >
                Change Store
              </button>
            </div>

        <div style={styles.card}>
          <div style={styles.sectionTitle}>Identify Item</div>
          <div style={{ fontSize: 14, color: "#64748b", marginBottom: 10 }}>
            Take up to 3 photos: product label, size, and shelf price.
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 8, marginBottom: 10 }}>
            <button
              type="button"
              onClick={() => {
                logButtonClick("Start Camera");
                handleStartPhotoFirst();
              }}
              style={{ ...styles.primaryButton, flex: 1, minHeight: 56, fontWeight: 800 }}
            >
              Start Camera
            </button>
            <button
              type="button"
              style={{ ...styles.libraryButton, flex: 1 }}
              onClick={() => {
                logButtonClick("Upload from Gallery");
                fileInputRef.current?.click();
              }}
            >
              Upload from Gallery
            </button>
          </div>
          <button
            type="button"
            onClick={async () => {
              try {
                await stopScanner();
              } catch {
                // Keep temporary test access resilient if scanner is already stopped.
              }
              setShowScanditScannerTest(true);
            }}
            style={{
              ...styles.secondaryButton,
              width: "100%",
              minHeight: 52,
              marginBottom: 10,
              background: "#f8fafc",
              color: "#0f172a",
              border: "1px dashed #94a3b8",
              fontWeight: 800,
            }}
          >
            Test Scandit Scanner
          </button>
          <div style={{ ...styles.infoBox, marginTop: 6, marginBottom: 10 }}>
            <div style={{ fontWeight: 800, marginBottom: 4 }}>Best results</div>
            <div>- Photo 1: front label</div>
            <div>- Photo 2: size / net weight</div>
            <div>- Photo 3: shelf price</div>
          </div>
          {error || String(status || "").includes("Use Gallery") ? (
            <button
              type="button"
              style={{ ...styles.libraryButton, width: "100%", marginBottom: 10 }}
              onClick={() => {
                logButtonClick("Use Gallery Instead");
                fileInputRef.current?.click();
              }}
            >
              Use Gallery Instead
            </button>
          ) : null}
          <div
            style={{
              display: "inline-flex",
              padding: "8px 14px",
              borderRadius: 999,
              background: "#eef2ff",
              color: "#334155",
              fontSize: 13,
              fontWeight: 700,
              marginBottom: 10,
            }}
          >
            {status}
          </div>
          {error ? <div style={styles.errorBox}>{error}</div> : null}
        </div>

        <div style={styles.card}>
          <div style={styles.scannerContainer}>
            <div style={styles.scannerFrame}>
              <div style={styles.scannerCornerTopLeft}></div>
              <div style={styles.scannerCornerTopRight}></div>
              <div style={styles.scannerCornerBottomLeft}></div>
              <div style={styles.scannerCornerBottomRight}></div>
              
              <div style={{ ...styles.videoWrap, borderRadius: 16, overflow: "hidden", maxHeight: 360 }}>
                {isScanning || awaitingPhoto ? (
                  <>
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      style={{ ...styles.video, width: "100%", height: "100%", objectFit: "cover" }}
                    />
                    {awaitingPhoto && !isScanning && (
                      <div style={{
                        position: "absolute",
                        inset: 0,
                        background: "rgba(0,0,0,0.75)",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        zIndex: 10,
                        textAlign: "center",
                        padding: 20
                      }}>
                        <div style={{ fontSize: 48, marginBottom: 12 }}>Photo</div>
                        <div style={{ fontSize: 22, fontWeight: 800, color: "#fff", marginBottom: 8 }}>
                          Photo Required
                        </div>
                        <div style={{ fontSize: 15, color: "#e5e7eb", maxWidth: 260 }}>
                          Take a clear front-label photo so MVP can identify this product.
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div style={styles.overlay}>
                    <div style={styles.overlayIcon}>[ ]</div>
                    <div style={styles.overlayText}>Start with a product photo</div>
                    <div style={styles.overlaySubtext}>
                      Take or upload clear photos of the front label, size or weight, and shelf price when available. Barcode is optional.
                    </div>
                  </div>
                )}
              </div>
              <canvas ref={canvasRef} style={{ display: "none" }} />
            </div>

            <div style={styles.scannerControls}>
              {!awaitingPhoto ? (!isScanning ? (
                <div style={{ width: "100%" }}>
                  <button
                    type="button"
                    onClick={() => {
                      logButtonClick("Start Camera");
                      handleStartPhotoFirst();
                    }}
                    style={styles.scanButton}
                  >
                    Start Camera
                  </button>
                  <button
                    type="button"
                    style={{ ...styles.libraryButton, width: "100%", marginTop: 10 }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Upload from Gallery
                  </button>
                  <div style={{ ...styles.infoBox, marginTop: 10 }}>
                    Photo-first flow: take or upload a product photo, confirm the AI result, then add location and price.
                  </div>
                  <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #e2e8f0" }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: "#475569", marginBottom: 8 }}>
                      Optional barcode tools
                    </div>
                    <button
                      onClick={() => {
                        if (awaitingProductConfirmation) {
                          setShowOptionalBarcodeInput(true);
                          setStatus("Attach a barcode manually or keep it blank.");
                          return;
                        }
                        startScanner();
                      }}
                      style={{
                        ...styles.secondaryButton,
                        minHeight: 44,
                        width: "100%",
                        marginBottom: 8,
                        background: "#f8fafc",
                        color: "#334155",
                        border: "1px solid #cbd5e1",
                        fontWeight: 700,
                      }}
                    >
                      Add/Scan Barcode (Optional)
                    </button>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        type="text"
                        value={manualBarcode}
                        onChange={(e) => setManualBarcode(e.target.value)}
                        placeholder="Optional barcode entry"
                        style={{ ...styles.input, marginBottom: 0, flex: 1 }}
                      />
                      <button
                        onClick={handleManualBarcodeSubmit}
                        style={{ ...styles.secondaryButton, minHeight: 44, flex: "0 0 auto", padding: "0 14px" }}
                      >
                        Attach
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <button onClick={stopScanner} style={styles.stopButton}>
                  Stop Scanner
                </button>
              )) : null}

              {(isScanning || awaitingPhoto) && (
                <div style={{ display: "flex", gap: 10, width: "100%", marginBottom: 10 }}>
                  <button
                    type="button"
                    onClick={capturePhotoFromLiveCamera}
                    style={{ ...styles.photoButtonSolid, flex: 1, marginBottom: 0 }}
                  >
                    Capture Photo
                  </button>
                  <button
                    type="button"
                    onClick={stopScanner}
                    style={{ ...styles.stopButton, flex: 1, minHeight: 52, padding: "0 14px" }}
                  >
                    Stop Camera
                  </button>
                </div>
              )}
            </div>
          </div>

          {(awaitingPhoto || capturedPhotos.length > 0) && (
            <div style={styles.photoPromptBox}>
              {/* -- Header -- */}
              <div style={{
                ...styles.infoBox,
                border: "2px solid #f59e0b",
                background: "#fffbeb",
                color: "#92400e",
                fontWeight: 800,
                fontSize: 18,
                marginBottom: 12,
              }}>
                Photo-first item identification
              </div>

              {/* Per-role capture instruction card */}
              {capturedPhotos.length < MAX_PHOTOS && (() => {
                const nextRole = PHOTO_ROLE_SEQUENCE[capturedPhotos.length];
                const roleInstructions = [
                  "Point camera at the product front label - ensure name and brand are clearly visible.",
                  "Point camera at the net weight or size label - usually found on the side or back.",
                  "Point camera at the shelf price tag - include the unit price if visible.",
                ];
                return (
                  <div style={{
                    background: "#eff6ff",
                    border: "1.5px solid #bfdbfe",
                    borderRadius: 10,
                    padding: "10px 14px",
                    marginBottom: 12,
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#1d4ed8", marginBottom: 2 }}>
                      Photo {capturedPhotos.length + 1} of {MAX_PHOTOS}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: "#1e3a8a", marginBottom: 4 }}>
                      {nextRole?.label || "Additional photo"}
                    </div>
                    <div style={{ fontSize: 13, color: "#374151" }}>
                      {roleInstructions[capturedPhotos.length] || "Take a clear photo of the product."}
                    </div>
                  </div>
                );
              })()}

              {/* -- Photo count progress -- */}
              <div style={{ fontSize: 14, color: "#475569", marginBottom: 12, fontWeight: 600 }}>
                Photos added: {capturedPhotos.length} / {MAX_PHOTOS}
              </div>

              {/* -- Captured photo thumbnails with remove buttons -- */}
              {capturedPhotos.length > 0 && (
                <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
                  {capturedPhotos.map((p, i) => (
                    <div
                      key={i}
                      style={{ position: "relative", width: 80, height: 80, borderRadius: 10, overflow: "hidden", border: "2px solid #e2e8f0", flexShrink: 0 }}
                    >
                      <img
                        src={previewImages[i] || p.previewUrl}
                        alt={p.label}
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                      <button
                        type="button"
                        aria-label={`Remove ${p.label}`}
                        onClick={() => {
                          URL.revokeObjectURL(p.previewUrl);
                          setCapturedPhotos((prev) => {
                            const next = prev.filter((_, idx) => idx !== i);
                            return next.map((ph, idx) => ({
                              ...ph,
                              label: `Photo ${idx + 1}`,
                              role: getRoleByPhotoIndex(idx),
                            }));
                          });
                        }}
                        style={{
                          position: "absolute",
                          top: 2,
                          right: 2,
                          width: 22,
                          height: 22,
                          borderRadius: "50%",
                          background: "rgba(0,0,0,0.65)",
                          color: "#fff",
                          border: "none",
                          fontSize: 14,
                          lineHeight: "22px",
                          textAlign: "center",
                          cursor: "pointer",
                          padding: 0,
                        }}
                      >
                        ×
                      </button>
                      <div style={{ position: "absolute", bottom: 2, left: 2, fontSize: 10, color: "#fff", background: "rgba(0,0,0,0.55)", borderRadius: 4, padding: "1px 4px" }}>
                        {`#${i + 1}`}
                      </div>
                      <div style={{ position: "absolute", top: 2, left: 2, fontSize: 9, color: "#fff", background: "rgba(0,0,0,0.55)", borderRadius: 4, padding: "1px 4px", maxWidth: 54, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {PHOTO_ROLE_SEQUENCE[i]?.label || "Photo"}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* -- Analyze button (shown after =1 photo) -- */}
              {capturedPhotos.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    logButtonClick("Analyze Photos", { photoCount: capturedPhotos.length });
                    analyzeAllPhotos();
                  }}
                  style={{ ...styles.confirmButton, width: "100%", minHeight: 56, fontSize: 17, fontWeight: 800, marginBottom: 10 }}
                  disabled={photoAnalysisStatus === 'uploading' || photoAnalysisStatus === 'analyzing' || processingRef.current}
                >
                  Analyze Photos
                </button>
              )}

              {/* -- Capture / Upload controls (shown when < MAX_PHOTOS) -- */}
              {capturedPhotos.length < MAX_PHOTOS && (
                <>
                  <button
                    onClick={capturePhotoFromLiveCamera}
                    style={{
                      ...styles.photoButtonSolid,
                      minHeight: 52,
                      fontSize: 16,
                      fontWeight: 800,
                      marginBottom: 10,
                    }}
                    disabled={isCapturingPhoto || photoAnalysisStatus === 'uploading' || photoAnalysisStatus === 'analyzing'}
                  >
                    {isCapturingPhoto
                      ? "Capturing..."
                      : `${capturedPhotos.length === 0 ? "Take" : "Add"} Photo ${capturedPhotos.length + 1} of ${MAX_PHOTOS}: ${PHOTO_ROLE_SEQUENCE[capturedPhotos.length]?.label || "Additional photo"}`}
                  </button>

                  <button
                    type="button"
                    style={{ ...styles.libraryButton, marginBottom: 10 }}
                    onClick={() => {
                      fileInputRef.current?.click();
                    }}
                  >
                    {capturedPhotos.length === 0
                      ? "Take Photo 1 of 3 (Camera/Gallery): Product front label"
                      : `Take Photo ${capturedPhotos.length + 1} of ${MAX_PHOTOS} (Camera/Gallery): ${PHOTO_ROLE_SEQUENCE[capturedPhotos.length]?.label || "Additional photo"}`}
                  </button>
                  <input
                    ref={fileInputRef}
                    id="cameraInput"
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handleImageUpload}
                    style={{
                      position: "absolute",
                      width: 1,
                      height: 1,
                      opacity: 0,
                      pointerEvents: "none",
                    }}
                  />
                </>
              )}

              <div style={styles.photoHelpText}>
                Suggested: Photo 1 = front label, Photo 2 = net weight/size, Photo 3 = price sign. Barcode is optional - add it after AI identifies the product.
              </div>
            </div>
          )}
          {availableCameras.length > 0 && (
            <div style={styles.fieldBlock}>
              <label style={styles.label}>Camera</label>
              <select
                value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
                style={styles.select}
                disabled={isScanning || awaitingPhoto}
              >
                {availableCameras.map((camera, index) => (
                  <option key={camera.deviceId} value={camera.deviceId}>
                    {camera.label || `Camera ${index + 1}`}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div style={styles.statusChips}>
            <div
              style={styles.statusChip}
              onClick={statusOpensLocationPanel ? handleOpenLocationFromStatus : undefined}
              role={statusOpensLocationPanel ? "button" : undefined}
              tabIndex={statusOpensLocationPanel ? 0 : undefined}
              onKeyDown={(e) => {
                if (!statusOpensLocationPanel) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleOpenLocationFromStatus();
                }
              }}
            >
              {status}
            </div>
            {aiDebug?.data?.debug_version && (
              <div style={styles.methodChip}>
                AI Debug: {aiDebug.data.debug_version}
              </div>
            )}
            {aiDebug?.data?.product_name && (
              <div style={styles.confirmChip}>
                AI Product: {aiDebug.data.product_name}
              </div>
            )}
            {barcode && (
              <div style={styles.barcodeChip}>
                Image ID: {barcode}
              </div>
            )}
            {submissionMethod && (
              <div style={styles.methodChip}>
                Source: {submissionMethod}
              </div>
            )}
            {userPoints > 0 && (
              <div style={styles.pointsChip}>
                {userPoints} pts
              </div>
            )}
            {locationConfirmationCount > 0 && (
              <div style={styles.confirmChip}>
                {locationConfirmationCount} confirms
              </div>
            )}
            {locationConfidenceScore > 0 && (
              <div style={styles.confidenceChip}>
                {locationConfidenceScore}% confidence
              </div>
            )}
          </div>

          {product && locationSaved && !isCurrentProductInCart ? (
            <button
              onClick={() => handleAddToShoppingList(product)}
              style={{ ...styles.secondaryButton, width: "100%", marginTop: 12 }}
            >
              Add to Shopping List
            </button>
          ) : null}

          {product && isCurrentProductInCart ? (
            <button
              onClick={() => {
                logButtonClick("Remove from Cart", { productName: product?.name });
                handleRemoveProductFromCart();
              }}
              style={{ ...styles.secondaryButton, width: "100%", marginTop: 12 }}
            >
              Remove from Cart
            </button>
          ) : null}

          {product && !locationSaved && activePanel !== "location" ? (
            <div style={{ ...styles.infoBox, marginTop: 12, borderColor: "#f59e0b", background: "#fffbeb", color: "#92400e" }}>
              <div style={{ fontWeight: 800, marginBottom: 8 }}>
                Location needed: help other shoppers find this item.
              </div>
              <button
                type="button"
                style={{ ...styles.primaryButton, width: "100%" }}
                onClick={() => {
                  openLocationPanel();
                  setLocationPanelMode("quick");
                  setLocationStep("aisle");
                }}
              >
                Add Location
              </button>
            </div>
          ) : null}

          {awaitingProductConfirmation ? (
            <div style={{ ...styles.sectionBox, marginTop: 12 }}>
              {(() => {
                const priceSourceMeta = getPriceSourceMeta(locationForm.price_source);
                const detectedUnitLabel = formatDetectedUnitLabel(
                  locationForm.detected_price_unit || aiDetectedPrice?.unit
                );
                const summarySizeText = [locationForm.size_value, locationForm.size_unit].filter(Boolean).join(" ") || "Size not detected";
                const summaryQuantityText = locationForm.quantity || "1";
                const summaryCategoryText = correctionForm.category || product?.category || "Category not detected";
                const summaryPriceText = locationForm.price
                  ? `$${formatCentsToDollars(locationForm.price)}${detectedUnitLabel || ` ${formatPriceType(locationForm.price_type)}`}`
                  : "Price not detected";
                const identityConfidence = Number(aiIdentityConfidence || 0);
                const sizeFieldConfidence = Number(aiFieldConfidence.size || 0);
                const quantityFieldConfidence = Number(aiFieldConfidence.quantity || 0);
                const priceFieldConfidence = Number(aiFieldConfidence.price || 0);
                const summaryConfidenceItems = [
                  {
                    key: "identity",
                    label: "Identity",
                    value: identityConfidence,
                    autoLocked: false,
                  },
                  {
                    key: "size",
                    label: "Size",
                    value: sizeFieldConfidence,
                    autoLocked: Boolean(aiAutoLockedFields.size),
                  },
                  {
                    key: "quantity",
                    label: "Quantity",
                    value: quantityFieldConfidence,
                    autoLocked: Boolean(aiAutoLockedFields.quantity),
                  },
                ];
                if (aiDetectedPrice || locationForm.price) {
                  summaryConfidenceItems.push({
                    key: "price",
                    label: "Price",
                    value: priceFieldConfidence,
                    autoLocked: false,
                  });
                }
                const shouldReviewSuggested = [
                  identityConfidence,
                  sizeFieldConfidence,
                  quantityFieldConfidence,
                  aiDetectedPrice || locationForm.price ? priceFieldConfidence : 1,
                ].some((score) => score < 0.85);
                const reviewSizeIndicator = getAiFieldIndicator(
                  "size",
                  Boolean(locationForm.size_value && locationForm.size_unit)
                );
                const reviewQuantityIndicator = getAiFieldIndicator("quantity", Boolean(locationForm.quantity));

                if (showAiSummaryCard) {
                  return (
                    <>
                      <div style={styles.aiSummaryCard}>
                        <div style={styles.aiSummaryImageWrap}>
                          {product?.image ? (
                            <img src={product.image} alt={product?.name || "Product"} style={styles.aiSummaryImage} />
                          ) : (
                            <div style={styles.aiSummaryImageFallback}>No image</div>
                          )}
                        </div>

                        <div style={styles.aiSummaryName}>
                          {correctionForm.product_name || product?.name || "Unknown product"}
                        </div>
                        <button
                          type="button"
                          style={{ ...styles.primaryButton, width: "100%", marginTop: 8 }}
                          onClick={() => {
                            openLocationPanel();
                            setLocationPanelMode("quick");
                            setLocationStep("aisle");
                          }}
                        >
                          Add Item Location
                        </button>
                        {correctionForm.brand ? (
                          <div style={styles.aiSummaryBrand}>{correctionForm.brand}</div>
                        ) : null}
                        <div style={styles.aiSummaryMeta}>Category: {summaryCategoryText}</div>
                        <div style={styles.aiSummaryMeta}>{summarySizeText}</div>
                        <div style={styles.aiSummaryMeta}>Qty: {summaryQuantityText}</div>
                        <div style={styles.aiSummaryPrice}>{summaryPriceText}</div>

                        {imageDebugResult ? (
                          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
                            {JSON.stringify(imageDebugResult, null, 2)}
                          </pre>
                        ) : null}

                        <div style={styles.aiSummaryConfidenceRow}>
                          {summaryConfidenceItems.map((item) => {
                            const isHigh = item.value >= 0.85;
                            const pct = `${Math.round(item.value * 100)}%`;
                            return (
                              <div
                                key={item.key}
                                style={{
                                  ...styles.aiSummaryConfidencePill,
                                  ...(isHigh ? styles.aiSummaryConfidencePillHigh : null),
                                }}
                              >
                                <span>{item.label}: {pct}</span>
                                {item.autoLocked ? (
                                  <span style={styles.aiSummaryConfidenceAutoTag}>Auto-locked</span>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>

                        {shouldReviewSuggested ? (
                          <div style={styles.aiSummaryReviewLabel}>Review suggested</div>
                        ) : null}

                        <div style={styles.buttonRow}>
                          <button
                            type="button"
                            style={styles.primaryButton}
                            onClick={handleConfirmAiSummary}
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            style={styles.secondaryButton}
                            onClick={() => {
                              setShowAiSummaryCard(false);
                              setStatus("Review and edit AI details before continuing.");
                            }}
                          >
                            Edit Details
                          </button>
                        </div>
                        <button
                          type="button"
                          style={{ ...styles.secondaryButton, width: "100%", marginTop: 8 }}
                          onClick={handleRetakePhotosFromSummary}
                        >
                          Retake Photos
                        </button>
                        <button
                          type="button"
                          style={{ ...styles.primaryButton, width: "100%", marginTop: 8, fontWeight: 800 }}
                          onClick={() => {
                            openLocationPanel();
                            setLocationPanelMode("quick");
                            setLocationStep("aisle");
                            setStatus("Add item location.");
                          }}
                        >
                          Add Item Location
                        </button>
                      </div>
                    </>
                  );
                }

                return (
                  <>
              <div style={styles.sectionTitle}>Review AI Product Result</div>
              <div style={styles.rewardDescription}>
                Confirm or edit item details. Barcode is optional.
              </div>
              {imageDebugResult ? (
                <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
                  {JSON.stringify(imageDebugResult, null, 2)}
                </pre>
              ) : null}
              <div style={{ ...styles.aiSummaryName, marginBottom: 8 }}>
                {correctionForm.product_name || product?.name || "Unknown product"}
              </div>

              <button
                type="button"
                style={{ ...styles.primaryButton, width: "100%", marginTop: 0, marginBottom: 12, fontWeight: 800 }}
                onClick={() => {
                  openLocationPanel();
                  setLocationPanelMode("quick");
                  setLocationStep("aisle");
                }}
              >
                Add Item Location
              </button>

              {aiDetectedRawText ? (
                <div style={{ ...styles.infoBox, marginBottom: 12, background: "#f8fafc", borderColor: "#cbd5e1", color: "#334155" }}>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>Detected text:</div>
                  <div style={{ fontSize: 12, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {aiDetectedRawText}
                  </div>
                </div>
              ) : null}

              <div
                style={{
                  ...styles.priceSourceBadge,
                  color: priceSourceMeta.color,
                  background: priceSourceMeta.background,
                  borderColor: priceSourceMeta.border,
                  marginBottom: 12,
                }}
              >
                <span>{priceSourceMeta.icon}</span>
                <span>{priceSourceMeta.label}</span>
              </div>

              {aiDetectedPrice && !priceConfirmed ? (
                <div ref={priceConfirmationCardRef} style={styles.aiPriceConfirmationCard}>
                  <div style={styles.aiPriceConfirmationTitle}>
                    AI found price: ${aiDetectedPrice.amount.toFixed(2)}{detectedUnitLabel}. Is this correct?
                  </div>
                  <div style={styles.buttonRow}>
                    <button
                      type="button"
                      style={styles.confirmButton}
                      onClick={() => {
                        if (!locationForm.price) {
                          setError("Enter a valid price before confirming");
                          return;
                        }
                        setPriceConfirmed(true);
                        setIsEditingDetectedPrice(false);
                        setLocationForm((prev) => ({
                          ...prev,
                          price_source:
                            aiDetectedPriceEdited || prev.price_source === "user_corrected"
                              ? "user_corrected"
                              : "photo_sign",
                          detected_price_unit:
                            prev.detected_price_unit !== "unknown"
                              ? prev.detected_price_unit
                              : aiDetectedPrice.unit || "unknown",
                        }));
                        setAiDetectedPrice((prev) =>
                          prev
                            ? {
                                ...prev,
                                source:
                                  aiDetectedPriceEdited || locationForm.price_source === "user_corrected"
                                    ? "user_corrected"
                                    : "photo_sign",
                              }
                            : prev
                        );
                        setToast({ message: "Price confirmed", type: "success" });
                        setError("");
                      }}
                    >
                      Confirm Price
                    </button>
                    <button
                      type="button"
                      style={styles.secondaryButton}
                      onClick={() => {
                        setIsEditingDetectedPrice(true);
                        setPriceConfirmed(false);
                        setLocationForm((prev) => ({ ...prev, price_source: "user_corrected" }));
                        setError("");
                        setTimeout(() => {
                          if (priceInputRef.current?.focus) {
                            priceInputRef.current.focus();
                          }
                        }, 0);
                      }}
                    >
                      Edit Price
                    </button>
                  </div>
                </div>
              ) : null}

              {!aiDetectedPrice ? (
                <div style={styles.aiPriceConfirmationCard}>
                  <div style={styles.aiPriceConfirmationTitle}>Price not detected</div>
                  <div style={styles.rewardDescription}>
                    No shelf price was found. You can enter it now, skip it for home testing, or add it later in store.
                  </div>
                  <div style={styles.buttonRow}>
                    <button
                      type="button"
                      style={styles.secondaryButton}
                      onClick={() => {
                        setLocationForm((prev) => ({ ...prev, price_source: "manual" }));
                        setPriceConfirmed(false);
                        setTimeout(() => {
                          if (priceInputRef.current?.focus) {
                            priceInputRef.current.focus();
                          }
                        }, 0);
                      }}
                    >
                      Enter price now
                    </button>
                    <button
                      type="button"
                      style={styles.confirmButton}
                      onClick={() => {
                        setPriceConfirmed(true);
                        setLocationForm((prev) => ({
                          ...prev,
                          price: "",
                          price_source: "missing",
                          detected_price_unit: "unknown",
                        }));
                        setError("");
                        setStatus("Price skipped for now. You can add it later in store.");
                      }}
                    >
                      Skip price for now
                    </button>
                  </div>
                </div>
              ) : null}

              {aiDetectedPrice && priceConfirmed ? (
                <div style={styles.aiPriceConfirmedBar}>
                  Confirmed price: ${formatCentsToDollars(locationForm.price)}{detectedUnitLabel}
                </div>
              ) : null}

              <label style={styles.label}>Product name</label>
              <input
                style={styles.input}
                value={correctionForm.product_name}
                onChange={(e) =>
                  setCorrectionForm((prev) => ({ ...prev, product_name: e.target.value }))
                }
                placeholder="Enter product name"
              />

              <label style={styles.label}>Brand</label>
              <input
                style={styles.input}
                value={correctionForm.brand}
                onChange={(e) =>
                  setCorrectionForm((prev) => ({ ...prev, brand: e.target.value }))
                }
                placeholder="Brand (optional)"
              />

              <label style={styles.label}>Category</label>
              <input
                style={styles.input}
                value={correctionForm.category || ""}
                onChange={(e) =>
                  setCorrectionForm((prev) => ({ ...prev, category: e.target.value }))
                }
                placeholder="e.g. Produce, Bakery, Deli"
              />

              <label style={styles.label}>Package details</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  style={{
                    ...styles.input,
                    marginBottom: 12,
                    flex: 1,
                    ...(aiAutoLockedFields.size ? styles.lockedInput : {}),
                  }}
                  value={locationForm.size_value}
                  readOnly={aiAutoLockedFields.size}
                  onChange={(e) => {
                    markAiFieldEdited("size");
                    setLocationForm((prev) => ({ ...prev, size_value: e.target.value }));
                  }}
                  placeholder="Size"
                />
                <input
                  style={{
                    ...styles.input,
                    marginBottom: 12,
                    flex: 1,
                    ...(aiAutoLockedFields.size ? styles.lockedInput : {}),
                  }}
                  value={locationForm.size_unit}
                  readOnly={aiAutoLockedFields.size}
                  onChange={(e) => {
                    markAiFieldEdited("size");
                    setLocationForm((prev) => ({ ...prev, size_unit: e.target.value }));
                  }}
                  placeholder="Unit"
                />
              </div>
              {aiAutoLockedFields.size ? (
                <button
                  type="button"
                  style={styles.editInlineButton}
                  onClick={() => unlockAiField("size")}
                >
                  Edit size
                </button>
              ) : null}
              <div
                style={{
                  ...styles.fieldConfidenceBadge,
                  ...(reviewSizeIndicator.style || {}),
                }}
              >
                {reviewSizeIndicator.text}
              </div>
              <input
                style={{
                  ...styles.input,
                  ...(aiAutoLockedFields.quantity ? styles.lockedInput : {}),
                }}
                value={locationForm.quantity}
                readOnly={aiAutoLockedFields.quantity}
                onChange={(e) => {
                  markAiFieldEdited("quantity");
                  setLocationForm((prev) => ({ ...prev, quantity: e.target.value }));
                }}
                placeholder="Quantity / package size"
              />
              {aiAutoLockedFields.quantity ? (
                <button
                  type="button"
                  style={styles.editInlineButton}
                  onClick={() => unlockAiField("quantity")}
                >
                  Edit quantity
                </button>
              ) : null}
              <div
                style={{
                  ...styles.fieldConfidenceBadge,
                  ...(reviewQuantityIndicator.style || {}),
                }}
              >
                {reviewQuantityIndicator.text}
              </div>

              <label style={styles.label}>
                {aiDetectedPrice ? "Detected sign price (required confirmation)" : "Price"}
              </label>
              <input
                ref={priceInputRef}
                style={styles.input}
                value={locationForm.price ? (Number(locationForm.price) / 100).toFixed(2) : ""}
                disabled={Boolean(aiDetectedPrice) && !isEditingDetectedPrice}
                onChange={(e) => {
                  const rawCents = e.target.value.replace(/\D/g, "");
                  setPriceConfirmed(false);
                  setAiDetectedPriceEdited(true);
                  setLocationForm((prev) => ({
                    ...prev,
                    price: rawCents,
                    price_source: "user_corrected",
                  }));
                  setAiDetectedPrice((prev) =>
                    prev
                      ? {
                          ...prev,
                          cents: rawCents,
                          amount: rawCents ? Number(rawCents) / 100 : 0,
                          source: "user_corrected",
                        }
                      : prev
                  );
                }}
                placeholder="Type 349 for $3.49"
                inputMode="numeric"
              />

              {detectedUnitLabel ? (
                <div style={styles.detectedUnitHint}>
                  Displayed price: ${locationForm.price ? formatCentsToDollars(locationForm.price) : "0.00"} {detectedUnitLabel}
                </div>
              ) : null}

              {aiDetectedPrice ? (
                <div style={styles.quickButtonRow}>
                  <button
                    type="button"
                    style={{
                      ...styles.quickButton,
                      ...(isEditingDetectedPrice ? styles.quickButtonActive : {}),
                    }}
                    onClick={() => {
                      setIsEditingDetectedPrice(true);
                      setLocationForm((prev) => ({ ...prev, price_source: "user_corrected" }));
                      setPriceConfirmed(false);
                      setError("");
                    }}
                  >
                    Editing enabled
                  </button>
                </div>
              ) : (
                <div style={styles.quickButtonRow}>
                  <button
                    type="button"
                    style={{
                      ...styles.quickButton,
                      ...(priceConfirmed ? styles.quickButtonActive : {}),
                    }}
                    onClick={() => {
                      if (!locationForm.price) {
                        setError("Enter a valid price before confirming");
                        return;
                      }
                      setPriceConfirmed(true);
                      setError("");
                    }}
                  >
                    Confirm price
                  </button>
                </div>
              )}

              <label style={styles.label}>Price type</label>
              <div style={styles.quickButtonRow}>
                {[
                  ["each", "Each"],
                  ["per_lb", "Per lb"],
                  ["per_oz", "Per oz"],
                  ["per_kg", "Per kg"],
                ].map(([value, label]) => (
                  <button
                    key={`photo-review-${value}`}
                    type="button"
                    style={{
                      ...styles.quickButton,
                      ...(locationForm.price_type === value ? styles.quickButtonActive : {}),
                    }}
                    onClick={() => {
                      setPriceConfirmed(false);
                      setLocationForm((prev) => ({ ...prev, price_type: value }));
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {locationForm.price_source ? (
                <div style={{ fontSize: 12, color: "#1e40af", marginBottom: 8 }}>
                  Price source: {locationForm.price_source}
                  {locationForm.detected_price_unit && locationForm.detected_price_unit !== "unknown"
                    ? ` • unit: ${locationForm.detected_price_unit}`
                    : ""}
                </div>
              ) : null}

              {locationForm.price_source === "missing" ? (
                <div style={styles.inlineWarning}>Price skipped - add later</div>
              ) : null}

              {!priceConfirmed && locationForm.price ? (
                <div style={styles.inlineWarning}>
                  Confirm or edit the detected price before saving.
                </div>
              ) : null}

              {isEggItem({ name: correctionForm.product_name }, correctionForm) ? (
                <div style={styles.quickButtonRow}>
                  {EGG_QUANTITY_OPTIONS.map((option) => (
                    <button
                      key={`review-${option.value}`}
                      type="button"
                      style={{
                        ...styles.quickButton,
                        ...(String(locationForm.quantity || "").toLowerCase() === option.value
                          ? styles.quickButtonActive
                          : {}),
                      }}
                      disabled={aiAutoLockedFields.quantity}
                      onClick={() => {
                        markAiFieldEdited("quantity");
                        setLocationForm((prev) => ({ ...prev, quantity: option.value }));
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}

              <button
                type="button"
                style={styles.secondaryButton}
                onClick={() => setShowOptionalBarcodeInput((prev) => !prev)}
              >
                Add/Scan Barcode (Optional)
              </button>

              {showOptionalBarcodeInput ? (
                <div style={{ marginTop: 8 }}>
                  <input
                    style={styles.input}
                    value={optionalBarcodeInput}
                    onChange={(e) => setOptionalBarcodeInput(e.target.value)}
                    placeholder="Enter barcode if available"
                  />
                  <button
                    type="button"
                    style={styles.secondaryButton}
                    onClick={handleAttachOptionalBarcode}
                  >
                    Attach Barcode
                  </button>
                </div>
              ) : null}

              <div style={styles.buttonRow}>
                <button
                  type="button"
                  style={styles.primaryButton}
                  onClick={handleConfirmProductFromPhoto}
                >
                  Confirm Product & Continue
                </button>
                <button
                  type="button"
                  style={styles.secondaryButton}
                  onClick={handleStartPhotoFirst}
                >
                  Retake Photo
                </button>
              </div>
              <button
                type="button"
                style={{ ...styles.primaryButton, width: "100%", marginTop: 8, background: "#0f766e" }}
                onClick={() => {
                  setAwaitingProductConfirmation(false);
                  setShowAiSummaryCard(false);
                  openLocationPanel();
                  setLocationPanelMode("quick");
                  setLocationStep("aisle");
                  setStatus("Add this item location in the store.");
                }}
              >
                Add Store Location
              </button>
                  </>
                );
              })()}
            </div>
          ) : null}

          {error ? <div style={styles.errorBox}>{error}</div> : null}

          {isLoadingBestLocation ? (
            <div style={styles.infoBox}>Checking best known location...</div>
          ) : null}

          {bestKnownLocation && (
            <div style={{ ...styles.bestKnownLocationCard, opacity: 1, transform: 'translateY(0)', transition: 'opacity 0.5s ease, transform 0.5s ease' }}>
              <div style={styles.locationCardHeader}>
                <div>
                  <div style={styles.locationCardTitle}>Best Known Location</div>
                  <div style={styles.locationCardSubtitle}>We found {bestKnownLocation.confirmation_count ?? 0} {(bestKnownLocation.confirmation_count ?? 0) === 1 ? 'confirmation' : 'confirmations'}</div>
                </div>
                <div style={styles.confidenceBadge}>{bestKnownLocation.confidence_score ?? 0}%</div>
              </div>

              <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 14, padding: 14, marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: bestKnownLocation.avg_price != null ? 8 : 0, gap: 8 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>Best Known Price</div>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      borderRadius: 999,
                      padding: "4px 10px",
                      border:
                        Number(bestKnownLocation.price_confidence || 0) >= 60
                          ? "1px solid #86efac"
                          : Number(bestKnownLocation.price_confidence || 0) >= 30
                          ? "1px solid #fcd34d"
                          : "1px solid #d1d5db",
                      background:
                        Number(bestKnownLocation.price_confidence || 0) >= 60
                          ? "#dcfce7"
                          : Number(bestKnownLocation.price_confidence || 0) >= 30
                          ? "#fef3c7"
                          : "#f3f4f6",
                      color:
                        Number(bestKnownLocation.price_confidence || 0) >= 60
                          ? "#166534"
                          : Number(bestKnownLocation.price_confidence || 0) >= 30
                          ? "#92400e"
                          : "#374151",
                    }}
                  >
                    {Number(bestKnownLocation.price_confidence || 0)}% confidence
                  </div>
                </div>

                {bestKnownLocation.avg_price != null ? (
                  (() => {
                    return (
                      <>
                        <div style={{ fontSize: 30, fontWeight: 800, color: "#065f46", lineHeight: 1.1, marginBottom: 8 }}>
                          ${Number(bestKnownLocation.price).toFixed(2)} {formatPriceType(bestKnownLocation.price_type)}
                        </div>
                        <div style={{ fontSize: 14, color: "#475569", lineHeight: 1.5, marginBottom: 10 }}>
                          ? {Number(bestKnownLocation.price_count || 0)} {Number(bestKnownLocation.price_count || 0) === 1 ? "confirmation" : "confirmations"}
                          <br />
                          ? {Number(bestKnownLocation.price_confidence || 0)}% confidence
                        </div>
                        <button
                          type="button"
                          style={{ ...styles.secondaryButton, minHeight: 44, fontSize: 14, fontWeight: 700 }}
                        >
                          Use This Price
                        </button>
                      </>
                    );
                  })()
                ) : (
                  <div style={{ fontSize: 14, color: "#64748b" }}>
                    No price data yet - be the first to add
                  </div>
                )}
              </div>

              <div style={styles.locationDetailsGrid}>
                <div style={styles.locationDetail}>
                  <div style={styles.locationDetailLabel}>Aisle</div>
                  <div style={styles.locationDetailValue}>{bestKnownLocation.aisle || "Not set"}</div>
                </div>
                <div style={styles.locationDetail}>
                  <div style={styles.locationDetailLabel}>Section</div>
                  <div style={styles.locationDetailValue}>{bestKnownLocation.section || "Not set"}</div>
                </div>
                <div style={styles.locationDetail}>
                  <div style={styles.locationDetailLabel}>Shelf</div>
                  <div style={styles.locationDetailValue}>{bestKnownLocation.shelf || "Not set"}</div>
                </div>
              </div>

              {bestKnownLocation.notes && (
                <div style={styles.locationNotesBox}>
                  <strong>Note:</strong> {bestKnownLocation.notes}
                </div>
              )}

              <div style={styles.locationMetaRow}>
                <div style={styles.locationMeta}>
                  <span style={styles.metaText}>Last confirmed {formatTimestamp(bestKnownLocation.last_confirmed_at)}</span>
                </div>
              </div>

              <div style={styles.buttonRow}>
                <button
                  onClick={handleUseBestKnownLocation}
                  style={styles.primaryButton}
                  disabled={isConfirmingBestLocation}
                >
                  {isConfirmingBestLocation
                    ? "Confirming..."
                    : "Use This Location"}
                </button>
                <button
                  onClick={() => {
                    setLocationForm((prev) => ({
                      ...prev,
                      aisle: bestKnownLocation.aisle || "",
                      section: bestKnownLocation.section || "",
                      shelf: bestKnownLocation.shelf || "",
                      notes: bestKnownLocation.notes || "",
                    }));
                    setActivePanel('location');
                    setLocationPanelMode('quick');
                    setLocationStep("aisle");
                  }}
                  style={styles.secondaryButton}
                >
                  Add / Correct Location
                </button>
              </div>
            </div>
          )}
        </div>

          </div>
        )}

        <div style={{ ...styles.rewardsSection, display: effectiveScreen === "cart" ? "block" : "none" }}>
          <div style={styles.rewardsSectionHeader}>
            Available Rewards
          </div>

          {rewards.length > 0 ? (
            <div style={styles.rewardsGrid}>
              {rewards.map((reward, index) => (
                <div
                  key={reward.id ?? `${reward.title || 'reward'}-${index}`}
                  style={styles.rewardCard}
                >
                  <div style={styles.rewardTitle}>
                    {reward.title}
                  </div>
                  <div style={styles.rewardDescription}>
                    {reward.description}
                  </div>
                  <div style={styles.rewardPoints}>
                    {reward.points_cost} pts
                  </div>
                  <button
                    onClick={() => handleRedeemReward(reward)}
                    disabled={userPoints < Number(reward.points_cost || 0)}
                    style={{
                      marginTop: 10,
                      minHeight: 40,
                      width: "100%",
                      borderRadius: 12,
                      border: userPoints < Number(reward.points_cost || 0)
                        ? "1px solid #cbd5e1"
                        : "1px solid #16a34a",
                      background: userPoints < Number(reward.points_cost || 0)
                        ? "#f8fafc"
                        : "linear-gradient(135deg, #22c55e 0%, #16a34a 100%)",
                      color: userPoints < Number(reward.points_cost || 0)
                        ? "#94a3b8"
                        : "#ffffff",
                      fontSize: 14,
                      fontWeight: 700,
                      cursor: userPoints < Number(reward.points_cost || 0)
                        ? "not-allowed"
                        : "pointer",
                    }}
                  >
                    {userPoints >= Number(reward.points_cost || 0)
                      ? "Redeem"
                      : "Not enough points"}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div style={styles.rewardEmptyState}>
              No rewards available yet.
            </div>
          )}
        </div>
      </div>

      {showNextItemPrompt && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            zIndex: 10000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 24,
              padding: 24,
              width: "100%",
              maxWidth: 420,
              textAlign: "center",
              boxShadow: "0 20px 60px rgba(0,0,0,0.25)"
            }}
          >
            <h2 style={{ fontSize: 24, fontWeight: 900, marginBottom: 10 }}>
              Contribution saved. What next?
            </h2>

            <p style={{ color: "#64748b", fontSize: 16, lineHeight: 1.5, marginBottom: 20 }}>
              Choose your next step.
            </p>

            <button
              type="button"
              onClick={() => {
                setShowNextItemPrompt(false);
                setAppScreen("identify");

                setProduct(null);
                setBarcode("");
                setBestKnownLocation(null);
                resetContributionFlow();

                setStatus("Starting next scan...");

                startScanner();
              }}
              style={{
                width: "100%",
                padding: "16px 18px",
                borderRadius: 18,
                border: "none",
                background: "#2563eb",
                color: "#fff",
                fontSize: 18,
                fontWeight: 900,
                marginBottom: 12
              }}
            >
              Add Next Item
            </button>

            <button
              type="button"
              onClick={() => {
                setShowNextItemPrompt(false);

                setProduct(null);
                setBarcode("");
                setBestKnownLocation(null);
                resetContributionFlow();

                setAppScreen("cart");
                setStatus("Ready");
              }}
              style={{
                width: "100%",
                padding: "14px 18px",
                borderRadius: 18,
                border: "1px solid #cbd5e1",
                background: "#fff",
                color: "#334155",
                fontSize: 16,
                fontWeight: 800
              }}
            >
              View Cart / Checkout
            </button>
          </div>
        </div>
      )}

      {effectiveScreen === "location" && (
        <div
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            background: "#fff",
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            padding: 20,
            paddingBottom: "calc(20px + env(safe-area-inset-bottom, 0px))",
            zIndex: 9999,
            boxShadow: "0 -4px 20px rgba(0,0,0,0.15)",
            maxHeight: "90vh",
            overflowY: "auto",
          }}
        >
          {renderLocationWizardStep()}

          {error ? <div style={styles.errorBox}>{error}</div> : null}

          <button
            type="button"
            onClick={() => {
              setActivePanel(null);
              setError("");
            }}
            style={{
              marginTop: 16,
              width: "100%",
              padding: 12,
              borderRadius: 12,
              background: "#e5e7eb",
              border: "none",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
      )}

      {toast.message && (
        <div
          style={{
            ...styles.toast,
            backgroundColor: toast.type === 'success' ? '#22c55e' : '#ef4444',
            opacity: toastIsExiting ? 0 : 1,
            transform: toastIsExiting ? 'translateX(-50%) translateY(16px)' : 'translateX(-50%) translateY(0)',
          }}
        >
          {toast.message}
        </div>
      )}
      </div>
    );
  }

  return null;
}

// ============================================================================
// STYLES - MVP Brand Design System
// ============================================================================

const MVP_GRADIENT = "linear-gradient(135deg, #22c55e 0%, #14b8a6 50%, #3b82f6 100%)";
const MVP_GRADIENT_HOVER = "linear-gradient(135deg, #16a34a 0%, #0d9488 50%, #2563eb 100%)";

const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(160deg, #f0fdf4 0%, #f0fdfa 40%, #eff6ff 100%)",
    color: "#0f172a",
    padding: 20,
    fontFamily: "system-ui, -apple-system, sans-serif",
  },
  container: {
    maxWidth: 480,
    margin: "0 auto",
  },
  fullScreenCenter: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    height: "100vh",
    background: "linear-gradient(160deg, #f0fdf4 0%, #f0fdfa 40%, #eff6ff 100%)",
  },
  cardLarge: {
    width: "90%",
    maxWidth: "400px",
    padding: "28px 24px",
    borderRadius: "24px",
    background: "#fff",
    boxShadow: "0 8px 40px rgba(59,130,246,0.10), 0 2px 8px rgba(0,0,0,0.06)",
    border: "1px solid #e2e8f0",
  },
  introPage: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px 18px",
    background: "radial-gradient(circle at top, rgba(20,184,166,0.24) 0%, rgba(20,184,166,0) 32%), linear-gradient(160deg, #064e3b 0%, #10b981 34%, #14b8a6 66%, #2563eb 100%)",
  },
  introHeroCard: {
    width: "100%",
    maxWidth: 420,
    padding: 28,
    borderRadius: 28,
    background: "linear-gradient(180deg, rgba(255,255,255,0.92) 0%, rgba(255,255,255,0.84) 100%)",
    border: "1px solid rgba(255,255,255,0.45)",
    boxShadow: "0 24px 60px rgba(15,23,42,0.28), inset 0 1px 0 rgba(255,255,255,0.6)",
    backdropFilter: "blur(18px)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
  },
  introHeaderRow: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 18,
  },
  introHeaderLogo: {
    width: 54,
    height: 54,
    objectFit: "contain",
    borderRadius: 12,
    filter: "drop-shadow(0 6px 12px rgba(15,23,42,0.2))",
  },
  leaderboardHeaderButton: {
    border: "1px solid #cbd5e1",
    background: "#ffffff",
    color: "#0f172a",
    minHeight: 40,
    padding: "0 14px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: "0 4px 10px rgba(15,23,42,0.1)",
  },
  introLogo: {
    width: 126,
    height: 126,
    objectFit: "contain",
    marginBottom: 12,
    filter: "drop-shadow(0 14px 24px rgba(15,23,42,0.24))",
  },
  introTitle: {
    fontSize: 44,
    lineHeight: 1,
    fontWeight: 900,
    letterSpacing: "-1.5px",
    margin: "0 0 8px",
    color: "#0f172a",
  },
  introSubtitle: {
    fontSize: 22,
    lineHeight: 1.2,
    fontWeight: 800,
    color: "#064e3b",
    marginBottom: 12,
  },
  introTagline: {
    fontSize: 15,
    lineHeight: 1.7,
    color: "#334155",
    margin: "0 0 20px",
    maxWidth: 320,
  },
  introInput: {
    width: "100%",
    minHeight: 54,
    borderRadius: 18,
    border: "1.5px solid rgba(15,23,42,0.12)",
    background: "rgba(255,255,255,0.92)",
    color: "#0f172a",
    padding: "0 16px",
    fontSize: 16,
    fontWeight: 600,
    marginBottom: 14,
    boxSizing: "border-box",
    boxShadow: "inset 0 1px 2px rgba(15,23,42,0.06)",
  },
  introPrimaryButton: {
    width: "100%",
    minHeight: 56,
    borderRadius: 18,
    border: "none",
    background: "linear-gradient(135deg, #064e3b 0%, #10b981 34%, #14b8a6 68%, #2563eb 100%)",
    color: "#ffffff",
    fontSize: 16,
    fontWeight: 800,
    cursor: "pointer",
    boxShadow: "0 14px 28px rgba(6,78,59,0.22)",
    marginBottom: 12,
  },
  introSecondaryButton: {
    width: "100%",
    minHeight: 54,
    borderRadius: 18,
    border: "1.5px solid rgba(15,23,42,0.10)",
    background: "rgba(255,255,255,0.8)",
    color: "#0f172a",
    fontSize: 15,
    fontWeight: 800,
    cursor: "pointer",
    boxShadow: "0 8px 18px rgba(15,23,42,0.08)",
  },
  introCommunityCard: {
    width: "100%",
    marginTop: 14,
    marginBottom: 4,
    padding: "16px 14px",
    borderRadius: 18,
    background: "#ffffff",
    border: "1px solid #dbeafe",
    boxShadow: "0 8px 22px rgba(15,23,42,0.08)",
  },
  introCommunityTitle: {
    fontSize: 17,
    fontWeight: 800,
    color: "#0f172a",
    marginBottom: 10,
    textAlign: "left",
  },
  introCommunityButton: {
    width: "100%",
    minHeight: 46,
    borderRadius: 14,
    border: "none",
    background: "linear-gradient(135deg, #10b981 0%, #2563eb 100%)",
    color: "#ffffff",
    fontSize: 14,
    fontWeight: 800,
    cursor: "pointer",
    marginBottom: 10,
    boxShadow: "0 8px 18px rgba(37,99,235,0.2)",
  },
  introCommunityText: {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.6,
    color: "#475569",
    textAlign: "left",
  },
  introFooter: {
    fontSize: 12,
    lineHeight: 1.6,
    color: "#475569",
    margin: "16px 0 0",
    maxWidth: 300,
  },
  onboardingGrid: {
    width: "100%",
    display: "grid",
    gap: 12,
    marginBottom: 18,
  },
  onboardingStepCard: {
    textAlign: "left",
    padding: "18px 16px",
    borderRadius: 20,
    background: "linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(248,250,252,0.96) 100%)",
    border: "1px solid rgba(20,184,166,0.14)",
    boxShadow: "0 10px 24px rgba(15,23,42,0.08)",
  },
  topRightIconContainer: {
    position: "absolute",
    top: 16,
    right: 16,
    zIndex: 10,
  },
  loginIconButton: {
    fontSize: 18,
    fontWeight: 800,
    color: "#0f172a",
    background: "#ffffff",
    borderRadius: "50%",
    width: 44,
    height: 44,
    border: "1px solid #cbd5e1",
    boxShadow: "0 6px 16px rgba(15, 23, 42, 0.12)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  modalOverlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modalCard: {
    background: "white",
    borderRadius: 20,
    padding: 24,
    width: "85%",
    maxWidth: 400,
    position: "relative",
    boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 16,
    textAlign: "center",
  },
  modalInput: {
    width: "100%",
    padding: 12,
    marginBottom: 12,
    borderRadius: 10,
    border: "1px solid #ccc",
    fontSize: 16,
    boxSizing: "border-box",
  },
  modalPrimaryButton: {
    width: "100%",
    padding: 14,
    borderRadius: 12,
    border: "none",
    background: "linear-gradient(135deg, #10b981, #2563eb)",
    color: "white",
    fontWeight: "bold",
    marginBottom: 10,
    cursor: "pointer",
  },
  authModeToggleRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
    marginBottom: 12,
  },
  authModeToggleButton: {
    minHeight: 36,
    borderRadius: 10,
    border: "1px solid #cbd5e1",
    background: "#f8fafc",
    color: "#334155",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  authModeToggleButtonActive: {
    background: "#e0f2fe",
    border: "1px solid #7dd3fc",
    color: "#0c4a6e",
  },
  modalSecondaryButton: {
    width: "100%",
    padding: 12,
    borderRadius: 12,
    border: "1px solid #cbd5e1",
    background: "#f9fafb",
    color: "#0f172a",
    cursor: "pointer",
  },
  modalClose: {
    position: "absolute",
    top: 10,
    right: 12,
    background: "transparent",
    border: "none",
    fontSize: 18,
    cursor: "pointer",
  },
  itemRequestModalCard: {
    background: "white",
    borderRadius: 20,
    padding: 22,
    width: "90%",
    maxWidth: 460,
    boxShadow: "0 16px 34px rgba(0,0,0,0.22)",
  },
  itemRequestModalTitle: {
    fontSize: 20,
    fontWeight: 800,
    color: "#0f172a",
    marginBottom: 14,
    textAlign: "left",
  },
  itemRequestFieldLabel: {
    display: "block",
    fontSize: 13,
    fontWeight: 700,
    color: "#334155",
    marginBottom: 6,
  },
  itemRequestModalInput: {
    width: "100%",
    border: "1px solid #cbd5e1",
    borderRadius: 12,
    padding: "11px 12px",
    marginBottom: 12,
    fontSize: 16,
    color: "#0f172a",
    background: "#ffffff",
    boxSizing: "border-box",
    minHeight: 44,
  },
  itemRequestSuggestionList: {
    display: "grid",
    gap: 8,
    marginBottom: 12,
  },
  itemRequestSuggestionButton: {
    width: "100%",
    border: "1px solid #dbeafe",
    background: "#f8fafc",
    borderRadius: 10,
    padding: "10px 12px",
    cursor: "pointer",
    textAlign: "left",
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  itemRequestSuggestionTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: "#0f172a",
  },
  itemRequestSuggestionBrand: {
    fontSize: 12,
    color: "#64748b",
  },
  itemRequestModalActions: {
    display: "grid",
    gap: 10,
    marginTop: 2,
  },
  itemRequestSubmitButton: {
    width: "100%",
    minHeight: 46,
    borderRadius: 12,
    border: "none",
    background: "linear-gradient(135deg, #10b981, #2563eb)",
    color: "#ffffff",
    fontSize: 14,
    fontWeight: 800,
    cursor: "pointer",
  },
  itemRequestCancelButton: {
    width: "100%",
    minHeight: 44,
    borderRadius: 12,
    border: "1px solid #cbd5e1",
    background: "#f8fafc",
    color: "#0f172a",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
  },
  itemRequestHint: {
    marginTop: 12,
    fontSize: 12,
    color: "#64748b",
    borderTop: "1px solid #e2e8f0",
    paddingTop: 10,
  },
  profileHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    padding: "10px 4px",
    marginBottom: 4,
  },
  errorText: {
    fontSize: 13,
    color: "#ef4444",
    fontWeight: 700,
    marginBottom: 10,
  },
  headerMetaRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 12,
    flexWrap: "wrap",
  },
  pointsHeaderBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: "linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)",
    color: "#92400e",
    border: "1px solid #fcd34d",
    borderRadius: 999,
    padding: "7px 14px",
    fontSize: 13,
    fontWeight: 700,
    boxShadow: "0 2px 8px rgba(251,191,36,0.15)",
  },
  progressPlaceholder: {
    display: "inline-flex",
    alignItems: "center",
    background: "linear-gradient(135deg, #eff6ff 0%, #f0fdfa 100%)",
    color: "#0369a1",
    border: "1px solid #bae6fd",
    borderRadius: 999,
    padding: "7px 14px",
    fontSize: 13,
    fontWeight: 700,
  },
  title: {
    fontSize: 30,
    fontWeight: 900,
    marginBottom: 10,
    textAlign: "center",
    background: MVP_GRADIENT,
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    backgroundClip: "text",
    letterSpacing: "-0.5px",
  },
  subtitle: {
    fontSize: 15,
    marginBottom: 24,
    lineHeight: 1.6,
    textAlign: "center",
    color: "#475569",
  },
  card: {
    background: "#ffffff",
    borderRadius: 24,
    padding: 24,
    boxShadow: "0 8px 32px rgba(59,130,246,0.07), 0 2px 8px rgba(0,0,0,0.04)",
    border: "1px solid #e8f4fd",
  },
  scannerContainer: {
    marginBottom: 24,
  },
  scannerFrame: {
    position: "relative",
    width: "100%",
    marginBottom: 24,
  },
  scannerCornerTopLeft: {
    position: "absolute",
    top: 20,
    left: 20,
    width: 40,
    height: 40,
    borderTop: "3px solid #14b8a6",
    borderLeft: "3px solid #14b8a6",
    borderTopLeftRadius: 12,
    zIndex: 10,
  },
  scannerCornerTopRight: {
    position: "absolute",
    top: 20,
    right: 20,
    width: 40,
    height: 40,
    borderTop: "3px solid #14b8a6",
    borderRight: "3px solid #14b8a6",
    borderTopRightRadius: 12,
    zIndex: 10,
  },
  scannerCornerBottomLeft: {
    position: "absolute",
    bottom: 20,
    left: 20,
    width: 40,
    height: 40,
    borderBottom: "3px solid #22c55e",
    borderLeft: "3px solid #22c55e",
    borderBottomLeftRadius: 12,
    zIndex: 10,
  },
  scannerCornerBottomRight: {
    position: "absolute",
    bottom: 20,
    right: 20,
    width: 40,
    height: 40,
    borderBottom: "3px solid #22c55e",
    borderRight: "3px solid #22c55e",
    borderBottomRightRadius: 12,
    zIndex: 10,
  },
  videoWrap: {
    position: "relative",
    width: "100%",
    minHeight: 340,
    background: "#f8fafc",
    borderRadius: 20,
    overflow: "hidden",
    boxShadow: "0 4px 24px rgba(59,130,246,0.10), inset 0 1px 0 rgba(255,255,255,0.8)",
    border: "2px solid #e0f2fe",
  },
  video: {
    width: "100%",
    height: 340,
    objectFit: "cover",
    display: "block",
    background: "#f8fafc",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(248,250,252,0.92)",
    color: "#334155",
    textAlign: "center",
    padding: "0 24px",
    backdropFilter: "blur(4px)",
  },
  overlayIcon: {
    fontSize: 56,
    marginBottom: 16,
    opacity: 0.75,
  },
  overlayText: {
    fontSize: 20,
    fontWeight: 700,
    marginBottom: 8,
    color: "#0f172a",
  },
  overlaySubtext: {
    fontSize: 15,
    opacity: 0.8,
    lineHeight: 1.5,
    color: "#64748b",
  },
  captureOverlay: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: 20,
    background: "rgba(255,255,255,0.97)",
    backdropFilter: "blur(14px)",
    border: "1px solid rgba(20,184,166,0.2)",
    color: "#0f172a",
    padding: 20,
    borderRadius: 20,
    textAlign: "center",
    boxShadow: "0 8px 32px rgba(59,130,246,0.12)",
  },
  captureIcon: {
    fontSize: 28,
    marginBottom: 12,
  },
  captureText: {
    fontSize: 18,
    fontWeight: 700,
    marginBottom: 6,
  },
  captureSubtext: {
    fontSize: 15,
    opacity: 0.9,
    lineHeight: 1.3,
  },
  scannerControls: {
    display: "flex",
    justifyContent: "center",
  },
  scanButton: {
    minHeight: 64,
    padding: "0 36px",
    borderRadius: 32,
    border: "none",
    fontSize: 18,
    fontWeight: 800,
    background: MVP_GRADIENT,
    color: "#ffffff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 12,
    boxShadow: "0 4px 24px rgba(20,184,166,0.30)",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
    active: { transform: "scale(0.97)" },
  },
  scanButtonIcon: {
    fontSize: 20,
  },
  stopButton: {
    minHeight: 64,
    padding: "0 36px",
    borderRadius: 32,
    border: "none",
    fontSize: 18,
    fontWeight: 800,
    background: "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)",
    color: "#ffffff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 12,
    boxShadow: "0 4px 20px rgba(239,68,68,0.30)",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
  },
  stopButtonIcon: {
    fontSize: 20,
  },
  hiddenCanvas: {
    display: "none",
  },
  buttonRow: {
    display: "flex",
    gap: 12,
    marginTop: 18,
  },
  secondaryButton: {
    flex: 1,
    minHeight: 52,
    borderRadius: 16,
    border: "1.5px solid #e2e8f0",
    fontSize: 15,
    fontWeight: 700,
    background: "#ffffff",
    color: "#475569",
    cursor: "pointer",
    transition: "all 0.15s ease",
    boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
  },
  confirmButton: {
    flex: 1,
    minHeight: 52,
    borderRadius: 16,
    border: "none",
    fontSize: 15,
    fontWeight: 700,
    background: MVP_GRADIENT,
    color: "#ffffff",
    cursor: "pointer",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
    boxShadow: "0 4px 18px rgba(20,184,166,0.22)",
  },
  editButton: {
    flex: 1,
    minHeight: 52,
    borderRadius: 16,
    border: "1.5px solid #e2e8f0",
    fontSize: 15,
    fontWeight: 700,
    background: "#f8fafc",
    color: "#64748b",
    cursor: "pointer",
    transition: "all 0.15s ease",
    boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
  },
  photoPromptBox: {
    background: "linear-gradient(135deg, #f0fdf4 0%, #f0fdfa 100%)",
    border: "1px solid #bbf7d0",
    borderRadius: 18,
    padding: 18,
    marginBottom: 16,
    boxShadow: "0 2px 10px rgba(34,197,94,0.07)",
  },
  photoPromptText: {
    fontSize: 15,
    marginBottom: 12,
    color: "#374151",
    fontWeight: 600,
  },
  photoButtonSolid: {
    width: "100%",
    minHeight: 52,
    borderRadius: 16,
    border: "none",
    fontSize: 15,
    fontWeight: 800,
    background: MVP_GRADIENT,
    color: "#ffffff",
    cursor: "pointer",
    marginBottom: 12,
    boxShadow: "0 4px 18px rgba(20,184,166,0.22)",
    transition: "transform 0.15s ease",
  },
  libraryButton: {
    position: "relative",
    width: "100%",
    minHeight: 52,
    borderRadius: 16,
    border: "1.5px solid #e2e8f0",
    fontSize: 15,
    fontWeight: 700,
    background: "#ffffff",
    color: "#475569",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
  },
  realFileInput: {
    position: "absolute",
    inset: 0,
    opacity: 0,
    cursor: "pointer",
  },
  photoHelpText: {
    marginTop: 12,
    fontSize: 13,
    lineHeight: 1.6,
    color: "#64748b",
  },
  fieldBlock: {
    marginBottom: 14,
  },
  label: {
    display: "block",
    marginBottom: 8,
    fontSize: 14,
    fontWeight: 700,
    color: "#334155",
  },
  stepLabel: {
    fontSize: 13,
    fontWeight: 800,
    background: MVP_GRADIENT,
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    backgroundClip: "text",
    marginBottom: 6,
  },
  stepTitle: {
    fontSize: 22,
    fontWeight: 900,
    color: "#0f172a",
    marginBottom: 16,
  },
  select: {
    width: "100%",
    minHeight: 48,
    borderRadius: 14,
    border: "1.5px solid #d1d5db",
    background: "#ffffff",
    color: "#0f172a",
    padding: "12px 14px",
    fontSize: 16,
    boxShadow: "inset 0 1px 2px rgba(15,23,42,0.05)",
  },
  input: {
    width: "100%",
    minHeight: 48,
    borderRadius: 14,
    border: "1.5px solid #d1d5db",
    background: "#ffffff",
    color: "#0f172a",
    padding: "12px 14px",
    fontSize: 16,
    marginBottom: 12,
    boxSizing: "border-box",
    boxShadow: "inset 0 1px 2px rgba(15,23,42,0.05)",
    transition: "border-color 0.15s ease",
  },
  textarea: {
    width: "100%",
    minHeight: 96,
    borderRadius: 14,
    border: "1.5px solid #d1d5db",
    background: "#ffffff",
    color: "#0f172a",
    padding: "12px 14px",
    fontSize: 16,
    marginBottom: 12,
    resize: "vertical",
    boxSizing: "border-box",
    boxShadow: "inset 0 1px 2px rgba(15,23,42,0.05)",
  },
  quickButtonRow: {
    display: "flex",
    gap: 8,
    marginBottom: 12,
    flexWrap: "wrap",
  },
  quickAreaGrid: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "center",
    marginTop: 10,
    marginBottom: 14,
  },
  quickAreaButton: {
    padding: "10px 14px",
    borderRadius: 999,
    border: "1px solid #e0f2fe",
    background: "#f8fafc",
    color: "#334155",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    transition: "all 0.15s ease",
  },
  quickAreaButtonActive: {
    background: MVP_GRADIENT,
    color: "#ffffff",
    border: "1px solid transparent",
    boxShadow: "0 2px 10px rgba(20,184,166,0.20)",
  },
  quickButton: {
    flex: 1,
    minHeight: 46,
    borderRadius: 14,
    border: "1.5px solid #e2e8f0",
    background: "#f8fafc",
    color: "#1f2937",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    padding: "0 12px",
    transition: "all 0.15s ease",
    display: "flex",
    alignItems: "center",
    gap: 8,
    textAlign: "left",
  },
  quickButtonActive: {
    background: MVP_GRADIENT,
    color: "#ffffff",
    border: "1px solid transparent",
    boxShadow: "0 2px 10px rgba(20,184,166,0.20)",
  },
  statusChips: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 20,
    alignItems: "center",
  },
  statusChip: {
    background: MVP_GRADIENT,
    color: "#ffffff",
    padding: "10px 20px",
    borderRadius: 24,
    fontSize: 15,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    gap: 8,
    boxShadow: "0 4px 14px rgba(20,184,166,0.22)",
    flex: "0 1 auto",
    minWidth: "fit-content",
  },
  barcodeChip: {
    background: "#f1f5f9",
    border: "1px solid #e2e8f0",
    color: "#64748b",
    padding: "5px 12px",
    borderRadius: 18,
    fontSize: 13,
    fontFamily: "monospace",
    display: "flex",
    alignItems: "center",
    gap: 5,
  },
  methodChip: {
    background: "#f1f5f9",
    color: "#64748b",
    padding: "5px 12px",
    borderRadius: 18,
    fontSize: 13,
    display: "flex",
    alignItems: "center",
    gap: 5,
  },
  pointsChip: {
    background: "linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)",
    color: "#78350f",
    padding: "9px 18px",
    borderRadius: 22,
    fontSize: 15,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    gap: 6,
    boxShadow: "0 4px 12px rgba(251,191,36,0.25)",
    flex: "0 1 auto",
    minWidth: "fit-content",
  },
  confirmChip: {
    background: "linear-gradient(135deg, #dcfce7 0%, #d1fae5 100%)",
    color: "#166534",
    padding: "8px 16px",
    borderRadius: 20,
    fontSize: 14,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    gap: 6,
    border: "1px solid #bbf7d0",
    flex: "0 1 auto",
    minWidth: "fit-content",
  },
  confidenceChip: {
    background: "#fef3c7",
    color: "#92400e",
    padding: "5px 12px",
    borderRadius: 18,
    fontSize: 13,
    display: "flex",
    alignItems: "center",
    gap: 5,
  },
  chipIcon: {
    fontSize: 16,
  },
  errorBox: {
    background: "#fef2f2",
    border: "1px solid #fecaca",
    color: "#dc2626",
    padding: 16,
    borderRadius: 16,
    marginBottom: 16,
    fontSize: 14,
    fontWeight: 600,
    boxShadow: "0 2px 8px rgba(239,68,68,0.08)",
  },
  successBox: {
    background: "linear-gradient(135deg, #f0fdf4 0%, #d1fae5 100%)",
    border: "1px solid #86efac",
    color: "#166534",
    padding: 16,
    borderRadius: 16,
    marginTop: 16,
    fontSize: 15,
    fontWeight: 600,
    boxShadow: "0 2px 8px rgba(34,197,94,0.10)",
  },
  infoBox: {
    background: "linear-gradient(135deg, #eff6ff 0%, #f0fdfa 100%)",
    border: "1px solid #bae6fd",
    color: "#0369a1",
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
    fontWeight: 700,
  },
  priceSourceBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    border: "1px solid #e2e8f0",
    borderRadius: 999,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 700,
    marginBottom: 10,
  },
  aiPriceConfirmationCard: {
    border: "1px solid #bae6fd",
    background: "linear-gradient(135deg, #eff6ff 0%, #f0fdfa 100%)",
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
  },
  aiPriceConfirmationTitle: {
    fontSize: 15,
    fontWeight: 800,
    color: "#0369a1",
    marginBottom: 10,
  },
  aiPriceConfirmedBar: {
    border: "1px solid #86efac",
    background: "linear-gradient(135deg, #dcfce7 0%, #d1fae5 100%)",
    color: "#166534",
    borderRadius: 12,
    padding: "8px 12px",
    fontSize: 13,
    fontWeight: 700,
    marginBottom: 10,
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  aiSummaryCard: {
    border: "1px solid #e0f2fe",
    background: "#ffffff",
    borderRadius: 20,
    padding: 18,
    boxShadow: "0 8px 24px rgba(59,130,246,0.08)",
  },
  aiSummaryImageWrap: {
    width: "100%",
    height: 180,
    borderRadius: 14,
    overflow: "hidden",
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    marginBottom: 12,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  aiSummaryImage: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
    background: "#fff",
  },
  aiSummaryImageFallback: {
    color: "#94a3b8",
    fontSize: 14,
    fontWeight: 600,
  },
  aiSummaryName: {
    fontSize: 22,
    fontWeight: 900,
    color: "#0f172a",
    lineHeight: 1.2,
    marginBottom: 4,
  },
  aiSummaryBrand: {
    fontSize: 14,
    color: "#475569",
    marginBottom: 6,
    fontWeight: 700,
  },
  aiSummaryMeta: {
    fontSize: 15,
    color: "#334155",
    marginBottom: 3,
    fontWeight: 700,
  },
  aiSummaryPrice: {
    fontSize: 22,
    fontWeight: 900,
    color: "#065f46",
    marginTop: 4,
    marginBottom: 8,
  },
  aiSummaryConfidenceRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 8,
  },
  aiSummaryConfidencePill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    border: "1px solid #fcd34d",
    background: "#fef3c7",
    color: "#92400e",
    borderRadius: 999,
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 700,
  },
  aiSummaryConfidencePillHigh: {
    border: "1px solid #86efac",
    background: "#dcfce7",
    color: "#166534",
  },
  aiSummaryConfidenceAutoTag: {
    border: "1px solid #93c5fd",
    background: "#dbeafe",
    color: "#1d4ed8",
    borderRadius: 999,
    padding: "1px 6px",
    fontSize: 10,
    fontWeight: 800,
    lineHeight: 1.2,
  },
  aiSummaryReviewLabel: {
    display: "inline-flex",
    border: "1px solid #fcd34d",
    background: "#fef3c7",
    color: "#92400e",
    borderRadius: 999,
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 700,
    marginBottom: 2,
  },
  detectedUnitHint: {
    fontSize: 12,
    color: "#0369a1",
    marginBottom: 10,
    fontWeight: 700,
  },
  inlineWarning: {
    border: "1px solid #fcd34d",
    background: "#fef3c7",
    color: "#92400e",
    borderRadius: 12,
    padding: "8px 12px",
    fontSize: 12,
    fontWeight: 700,
    marginBottom: 10,
  },
  bestKnownLocationCard: {
    background: "#ffffff",
    border: "1px solid #e0f2fe",
    borderRadius: 22,
    padding: 20,
    marginBottom: 20,
    boxShadow: "0 6px 24px rgba(59,130,246,0.08)",
  },
  debugBox: {
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    color: "#475569",
    padding: 16,
    borderRadius: 14,
    marginBottom: 16,
  },
  debugTitle: {
    fontSize: 13,
    fontWeight: 700,
    marginBottom: 8,
    color: "#64748b",
  },
  debugPre: {
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontSize: 12,
    lineHeight: 1.5,
  },
  productCard: {
    background: "#ffffff",
    border: "1px solid #e0f2fe",
    borderRadius: 22,
    padding: 24,
    boxShadow: "0 6px 24px rgba(59,130,246,0.08)",
    marginBottom: 20,
  },
  productHeader: {
    fontSize: 13,
    fontWeight: 800,
    marginBottom: 18,
    textTransform: "uppercase",
    letterSpacing: 1,
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: MVP_GRADIENT,
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    backgroundClip: "text",
  },
  resultIcon: {
    fontSize: 18,
  },
  productImageContainer: {
    width: "100%",
    height: 220,
    borderRadius: 16,
    overflow: "hidden",
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    marginBottom: 20,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
  },
  productImage: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
    background: "#ffffff",
  },
  productImagePlaceholder: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    color: "#94a3b8",
    textAlign: "center",
  },
  placeholderIcon: {
    fontSize: 56,
    marginBottom: 12,
  },
  placeholderText: {
    fontSize: 15,
    color: "#94a3b8",
  },
  productDetails: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  productName: {
    fontSize: 24,
    fontWeight: 900,
    margin: 0,
    lineHeight: 1.2,
    color: "#0f172a",
  },
  productMeta: {
    fontSize: 15,
    margin: 0,
    display: "flex",
    alignItems: "center",
    gap: 10,
    color: "#475569",
  },
  metaLabel: {
    fontWeight: 700,
    color: "#64748b",
    minWidth: 65,
  },
  barcodeCode: {
    background: "#f0fdfa",
    padding: "4px 8px",
    borderRadius: 8,
    fontFamily: "monospace",
    fontSize: 14,
    color: "#0d9488",
    border: "1px solid #99f6e4",
  },
  actionsRow: {
    display: "flex",
    gap: 8,
    marginTop: 18,
    flexWrap: "wrap",
  },
  actionButton: {
    flex: 1,
    minHeight: 52,
    borderRadius: 14,
    border: "1.5px solid #e2e8f0",
    fontSize: 14,
    fontWeight: 700,
    background: "#f8fafc",
    color: "#334155",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    transition: "all 0.15s ease",
  },
  sectionBox: {
    marginTop: 12,
    padding: 20,
    background: "#ffffff",
    borderRadius: 20,
    border: "1px solid #e0f2fe",
    boxShadow: "0 4px 18px rgba(59,130,246,0.07)",
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: 800,
    marginBottom: 16,
    color: "#0f172a",
  },
  panelTitle: {
    fontSize: 21,
    fontWeight: 900,
    marginBottom: 8,
    color: "#0f172a",
  },
  panelSubtitle: {
    fontSize: 14,
    color: "#475569",
    marginBottom: 14,
    lineHeight: 1.5,
  },
  reviewBox: {
    background: "linear-gradient(135deg, #f8fafc 0%, #f0fdf4 100%)",
    border: "1px solid #e2e8f0",
    borderRadius: 18,
    padding: 18,
    textAlign: "left",
    lineHeight: 1.8,
  },
  rewardsSection: {
    background: "#ffffff",
    borderRadius: 24,
    padding: 20,
    marginTop: 14,
    boxShadow: "0 8px 32px rgba(59,130,246,0.07), 0 2px 8px rgba(0,0,0,0.04)",
    border: "1px solid #e0f2fe",
  },
  rewardsSectionHeader: {
    fontSize: 17,
    fontWeight: 800,
    marginBottom: 12,
    color: "#0f172a",
  },
  rewardsGrid: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  rewardCard: {
    border: "1px solid #e0f2fe",
    borderRadius: 16,
    padding: 14,
    background: "#ffffff",
    boxShadow: "0 2px 10px rgba(59,130,246,0.05)",
    transition: "box-shadow 0.15s ease",
  },
  cartItemImage: {
    width: 56,
    height: 56,
    minWidth: 56,
    borderRadius: 12,
    objectFit: "cover",
    background: "#f1f5f9",
  },
  rewardTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: "#0f172a",
    marginBottom: 4,
  },
  rewardDescription: {
    fontSize: 14,
    color: "#64748b",
    lineHeight: 1.4,
    marginBottom: 8,
  },
  rewardPoints: {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: 999,
    padding: "5px 12px",
    fontSize: 13,
    fontWeight: 700,
    color: "#92400e",
    background: "linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)",
    border: "1px solid #fcd34d",
  },
  rewardEmptyState: {
    fontSize: 14,
    color: "#94a3b8",
    textAlign: "center",
    padding: "16px 0",
  },
  closeButton: {
    background: "none",
    border: "none",
    color: "#94a3b8",
    fontSize: 20,
    cursor: "pointer",
    padding: 0,
    width: 32,
    height: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    transition: "background 0.15s ease",
  },
  toast: {
    position: "fixed",
    bottom: "calc(24px + env(safe-area-inset-bottom, 0px))",
    left: "50%",
    transform: "translateX(-50%) translateY(0)",
    background: MVP_GRADIENT,
    color: "#ffffff",
    padding: "16px 28px",
    borderRadius: 28,
    fontSize: 15,
    fontWeight: 700,
    boxShadow: "0 8px 32px rgba(20,184,166,0.28)",
    zIndex: 10001,
    border: "1px solid rgba(255,255,255,0.2)",
    opacity: 1,
    transition: "all 0.4s cubic-bezier(0.32, 0.72, 0, 1)",
    whiteSpace: "normal",
    maxWidth: "calc(100vw - 48px)",
    textAlign: "center",
  },
  locationCardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 18,
    gap: 12,
  },
  locationCardTitle: {
    fontSize: 19,
    fontWeight: 800,
    color: "#0f172a",
    marginBottom: 4,
  },
  locationCardSubtitle: {
    fontSize: 14,
    color: "#64748b",
    fontWeight: 500,
  },
  confidenceBadge: {
    background: MVP_GRADIENT,
    color: "#ffffff",
    padding: "8px 16px",
    borderRadius: 20,
    fontSize: 14,
    fontWeight: 700,
    whiteSpace: "nowrap",
    boxShadow: "0 2px 10px rgba(20,184,166,0.20)",
  },
  locationDetailsGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: 12,
    marginBottom: 16,
    padding: "14px",
    background: "linear-gradient(135deg, #f0fdf4 0%, #f0fdfa 100%)",
    borderRadius: 16,
    border: "1px solid #bbf7d0",
  },
  locationDetail: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  locationDetailLabel: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    color: "#94a3b8",
  },
  locationDetailValue: {
    fontSize: 17,
    fontWeight: 800,
    color: "#0f172a",
  },
  locationNotesBox: {
    background: "#fefce8",
    border: "1px solid #fde047",
    padding: 12,
    borderRadius: 12,
    fontSize: 14,
    color: "#713f12",
    marginBottom: 12,
    lineHeight: 1.5,
  },
  locationMetaRow: {
    display: "flex",
    gap: 16,
    marginBottom: 16,
    fontSize: 13,
    color: "#64748b",
  },
  locationMeta: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  metaIcon: {
    fontSize: 14,
    color: "#22c55e",
  },
  metaText: {
    fontSize: 13,
  },
  primaryButton: {
    flex: 1,
    minHeight: 52,
    background: MVP_GRADIENT,
    color: "#ffffff",
    border: "none",
    borderRadius: 16,
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
    boxShadow: "0 4px 16px rgba(20,184,166,0.22)",
  },
  storeBadgeRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 12,
    flexWrap: "wrap",
  },
  storeBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: "linear-gradient(135deg, #f0fdfa 0%, #e0f2fe 100%)",
    color: "#0369a1",
    border: "1px solid #99f6e4",
    borderRadius: 999,
    padding: "8px 16px",
    fontSize: 14,
    fontWeight: 700,
  },
  changeStoreButton: {
    background: "none",
    border: "1px solid #e2e8f0",
    borderRadius: 999,
    color: "#64748b",
    fontSize: 13,
    fontWeight: 600,
    padding: "6px 14px",
    cursor: "pointer",
    transition: "all 0.15s ease",
  },
  storeOptionButton: {
    width: "100%",
    minHeight: 52,
    borderRadius: 14,
    border: "1.5px solid #e2e8f0",
    background: "#f8fafc",
    color: "#0f172a",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    padding: "0 16px",
    gap: 8,
    textAlign: "left",
    boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
    transition: "all 0.15s ease",
  },
  suggestedStoreCard: {
    background: "linear-gradient(135deg, #f0fdf4 0%, #f0fdfa 100%)",
    border: "1px solid #99f6e4",
    borderRadius: 18,
    padding: 16,
    marginBottom: 16,
    boxShadow: "0 2px 10px rgba(20,184,166,0.10)",
  },
  suggestedStoreTitle: {
    fontSize: 16,
    fontWeight: 800,
    color: "#065f46",
    marginBottom: 12,
  },
  fieldConfidenceBadge: {
    marginTop: -4,
    marginBottom: 12,
    fontSize: 12,
    fontWeight: 700,
    color: "#92400e",
    background: "#fef3c7",
    border: "1px solid #fcd34d",
    borderRadius: 10,
    padding: "6px 8px",
  },
  fieldConfidenceBadgeHigh: {
    color: "#166534",
    background: "#dcfce7",
    border: "1px solid #86efac",
  },
  fieldConfidenceBadgeEdited: {
    color: "#1d4ed8",
    background: "#dbeafe",
    border: "1px solid #93c5fd",
  },
  lockedInput: {
    background: "#f0fdfa",
    borderColor: "#99f6e4",
    color: "#0f172a",
  },
  editInlineButton: {
    minHeight: 34,
    borderRadius: 10,
    border: "1px solid #99f6e4",
    background: "#f0fdfa",
    color: "#0d9488",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    padding: "0 10px",
    marginBottom: 10,
  },
};









