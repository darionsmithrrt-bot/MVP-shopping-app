import React, { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { supabase } from "./supabaseClient";
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

const PHOTO_ROLE_SEQUENCE = [
  { key: "product_label", label: "Product front label" },
  { key: "size_label", label: "Size / net weight label" },
  { key: "price_sign", label: "Shelf price sign" },
];

const VALID_IMAGE_ROLES = new Set(["product_label", "size_label", "price_sign"]);

const getRoleByPhotoIndex = (index) => {
  const boundedIndex = Math.max(0, Math.min(index, PHOTO_ROLE_SEQUENCE.length - 1));
  return PHOTO_ROLE_SEQUENCE[boundedIndex].key;
};

const normalizeImageRole = (role, index) => {
  const candidate = String(role || "").trim();
  if (VALID_IMAGE_ROLES.has(candidate)) return candidate;
  return getRoleByPhotoIndex(index);
};

const identifyProductFromPhoto = async (imageUrls, barcode, imageRoles = []) => {
  const urls = Array.isArray(imageUrls) ? imageUrls : [imageUrls].filter(Boolean);
  const normalizedRoles = urls.map((_, index) => normalizeImageRole(imageRoles[index], index));
  const payload = {
    imageUrls: urls,
    imageRoles: normalizedRoles,
    barcode,
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
      icon: "??",
      label: "Price from shelf photo",
      color: "#166534",
      background: "#dcfce7",
      border: "#86efac",
    };
  }

  if (priceSource === "user_corrected") {
    return {
      icon: "??",
      label: "User edited price",
      color: "#92400e",
      background: "#fef3c7",
      border: "#fcd34d",
    };
  }

  return {
    icon: "?",
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

const extractDetectedPriceFromAi = (aiPayload, aiResponse) => {
  const responseData = aiResponse?.data || {};

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
  const sizeRegex = /(\d+(?:\.\d+)?)\s*(fl\s*oz|fluid\s*oz|oz|ounces?|g|grams?|kg|kilograms?|lb|lbs|pounds?|pack|pk|count|ct)\b/gi;

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
        const score = (sourceTexts.length - sourceIndex) + (lines.length - lineIndex) + (hasNetWeightHint ? 20 : 0);

        candidates.push({ value, unit, score });
      }
    });
  });

  if (!candidates.length) return null;

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return {
    size_value: best.value,
    size_unit: best.unit,
    size_confidence: 0.75,
  };
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
  const [activeAisleView, setActiveAisleView] = useState(null);
  const [shoppingMode, setShoppingMode] = useState(false);
  const [manualListItemName, setManualListItemName] = useState("");
  const [cartComparison, setCartComparison] = useState(null);
  const [isComparingCart, setIsComparingCart] = useState(false);
  const [brandComparisonMode, setBrandComparisonMode] = useState("flexible");

  // ============================================================================
  // STATE - User Profile
  // ============================================================================
  const [currentUserProfile, setCurrentUserProfile] = useState(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [isCheckingProfile, setIsCheckingProfile] = useState(true);
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

  // ============================================================================
  // EFFECTS - Initialization & Cleanup
  // ============================================================================

  useEffect(() => {
    const loadCameras = async () => {
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
      } catch (err) {
        console.error("CAMERA LOAD ERROR:", err);
        setError("Unable to load cameras");
        setStatus("Camera load failed");
      }
    };

    loadCameras();

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

  // Load user profile from localStorage on app mount
  useEffect(() => {
    const saved = localStorage.getItem("currentUserProfile");

    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed?.display_name) {
          setCurrentUserProfile(parsed);
        }
      } catch {
        localStorage.removeItem("currentUserProfile");
      }
    }

    setIsCheckingProfile(false);
  }, []);

  useEffect(() => {
    try {
      const savedShoppingList = localStorage.getItem("shoppingListItems");
      if (!savedShoppingList) return;
      const parsedShoppingList = JSON.parse(savedShoppingList);
      if (Array.isArray(parsedShoppingList)) {
        setShoppingListItems(parsedShoppingList);
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    localStorage.setItem("shoppingListItems", JSON.stringify(shoppingListItems));
  }, [shoppingListItems]);

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
      }
    } catch (_) {}
  }, []);

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
        `${s.name || ""} ${s.address || ""} ${s.city || ""} ${s.state || ""}`
          .toLowerCase()
          .includes(storeSearchQuery)
      )
    : nearbyStores;

  const calculateCartTotal = (cart) => {
    return (cart || []).reduce((sum, item) => {
      const price = Number(item?.avg_price ?? item?.price);
      return Number.isNaN(price) || price <= 0 ? sum : sum + price;
    }, 0);
  };

  const shoppingListEstimatedTotal = calculateCartTotal(shoppingListItems);

  const smartCartItems = shoppingListItems
    .map((item, originalIndex) => {
      const aisleText = String(item?.aisle || "").trim();
      const confidenceScore = Number(item?.confidence_score || 0);
      return {
        product_name: item?.product_name || "",
        brand: item?.brand || "",
        aisle: aisleText,
        section: item?.section || "",
        shelf: item?.shelf || "",
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

  const smartCartByAisle = smartCartItems.reduce((acc, smartItem) => {
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

  const smartShoppingItemsToLocate = smartCartItems.filter((smartItem) => smartItem.needsContribution);
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
  const isSmartCartEmpty = shoppingListItems.length === 0;
  const hasKnownSmartCartItems = smartShoppingKnownItemCount > 0;
  const hasUnknownSmartCartItems = smartShoppingNeedsLocationCount > 0;
  const smartCartStateMessage = isSmartCartEmpty
    ? "Your Smart Cart is empty. Add items by photo or manual entry."
    : hasKnownSmartCartItems && hasUnknownSmartCartItems
      ? "Some items are ready to shop. Others still need locations."
      : hasUnknownSmartCartItems
        ? "Start locating these items to build this store's map."
        : "Ready to shop by aisle.";

  const startShoppingMode = () => {
    if (!shoppingModeAisleLabels.length) return;
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
    const targetBarcode = String(productLike?.barcode || "").trim();
    const itemBarcode = String(item?.barcode || "").trim();

    if (targetBarcode) {
      return itemBarcode === targetBarcode;
    }

    const targetName = normalizeMatchValue(productLike?.product_name || productLike?.name);
    const targetBrand = normalizeMatchValue(productLike?.brand);
    const targetStoreId = String(productLike?.store_id || "").trim();

    const itemName = normalizeMatchValue(item?.product_name);
    const itemBrand = normalizeMatchValue(item?.brand);
    const itemStoreId = String(item?.store_id || "").trim();

    if (!targetName) return false;

    return (
      itemName === targetName &&
      itemStoreId === targetStoreId &&
      (itemBrand === targetBrand || !targetBrand)
    );
  };

  const currentProductBarcode = product?.barcode || barcode;
  const currentProductName = product?.name || "";
  const currentProductBrand = product?.brand || "";
  const currentProductStoreId = selectedStore?.id || "";
  const isCurrentProductInCart = shoppingListItems.some((item) =>
    doesCartItemMatchProduct(item, {
      barcode: currentProductBarcode,
      product_name: currentProductName,
      brand: currentProductBrand,
      store_id: currentProductStoreId,
    })
  );

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

      setSelectedStore(resolvedStore);
      localStorage.setItem("selectedStore", JSON.stringify(resolvedStore));
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
    try {
      await stopScanner();

      const constraints = {
        video: selectedDeviceId
          ? { deviceId: { exact: selectedDeviceId } }
          : { facingMode: { ideal: "environment" } },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      if (!videoRef.current) {
        throw new Error("Video element not ready");
      }

      videoRef.current.srcObject = stream;

      try {
        await videoRef.current.play();
      } catch (err) {
        if (!isIgnorablePlayInterruption(err)) {
          throw err;
        }
      }

      setIsScanning(true);
      setStatus("Camera live. Capture a product photo.");
    } catch (err) {
      if (isIgnorablePlayInterruption(err)) {
        console.warn("Ignored camera transition warning:", err);
        setStatus("Camera live. Capture a product photo.");
        setError("");
        return;
      }

      console.error("LIVE PREVIEW ERROR:", err);
      setError(err.message || "Unable to start camera preview");
      setStatus("Camera preview failed");
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
      const { data, error: productError } = await supabase
        .from("catalog_products")
        .select("id, barcode, product_name, image_url, brand, source, size_value, size_unit, quantity")
        .eq("barcode", scannedBarcode)
        .maybeSingle();

      if (productError) {
        throw productError;
      }

      if (!data) {
        return null;
      }

      return {
        catalog_id: data.id || null,
        name: data.product_name || "Unknown product",
        image: data.image_url || "",
        barcode: data.barcode || scannedBarcode,
        brand: data.brand || "",
        category: "",
        size_value: data.size_value || "",
        size_unit: data.size_unit || "",
        quantity: data.quantity || "",
        source: data.source || "catalog",
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
              }

              setAwaitingPhoto(false);
              setSubmissionMethod("retrieved");
              const addResult = handleAddToShoppingList(knownProduct, knownLocation);

              if (!knownLocation && !addResult?.updated) {
                setActivePanel("location");
                setLocationPanelMode("quick");
                setLocationStep("aisle");
              }

              setStatus("Known product found. Photo skipped.");
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
      setStatus("? Photo capture failed");
    } finally {
      setIsCapturingPhoto(false);
    }
  };

  const handlePhotoSelected = (event, source) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length === 0) {
      alert("Camera failed. Please try again or upload from your gallery.");
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

  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) {
      alert("Camera failed. Please try again or upload from your gallery.");
      return;
    }

    console.log("Uploading file:", file);
    handlePhotoSelected(e, "library");
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

      // â”€â”€ Upload all captured photos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

      // â”€â”€ Save initial product record using first photo URL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
          .select("id, barcode, product_name, image_url, brand, source, size_value, size_unit, quantity")
          .single();
        savedRow = result.data;
        saveError = result.error;
      } else {
        const result = await supabase
          .from("catalog_products")
          .insert([{ barcode: productKey, product_name: "Unknown product", image_url: firstImageUrl, source: initialSourceValue }])
          .select("id, barcode, product_name, image_url, brand, source, size_value, size_unit, quantity")
          .single();
        savedRow = result.data;
        saveError = result.error;
      }

      if (saveError) throw new Error(`Database save failed: ${saveError.message}`);

      // â”€â”€ Call AI with all uploaded URLs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      setPhotoAnalysisStatus('analyzing');
      setStatus(`Analyzing ${uploadedUrls.length} photo${uploadedUrls.length > 1 ? "s" : ""} with AI...`);

      const imageRoles = capturedPhotos
        .slice(0, files.length)
        .map((photo, index) => normalizeImageRole(photo?.role, index));
      const aiResponse = await identifyProductFromPhoto(uploadedUrls, normalizedBarcode, imageRoles);
      console.log("FULL AI RESPONSE:", aiResponse);
      
      if (aiResponse?.error) {
        throw new Error(`AI function failed: ${aiResponse.error.message || JSON.stringify(aiResponse.error)}`);
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
      };
      
      console.log("NORMALIZED AI PAYLOAD AFTER FALLBACK:", aiPayload);
      setAiDetectedRawText(String(aiPayload.raw_text || "").trim());

      const extractLikelyProductPhraseFromRawText = (rawText) => {
        const lines = String(rawText || "")
          .split(/[\n\r]+/)
          .map((line) => line.trim())
          .filter(Boolean);

        const blockedLine = /(\$|\bper\b|\bprice\b|\btotal\b|\bsave\b|\bcoupon\b|\bwww\.|\bhttp\b|\bbarcode\b|\bnutrition\b|\bserving\b|\bcalories\b)/i;

        for (const line of lines) {
          const cleaned = line.replace(/[^\w\s&'\-]/g, " ").replace(/\s+/g, " ").trim();
          if (!cleaned || cleaned.length < 3 || cleaned.length > 80) continue;
          if (blockedLine.test(cleaned)) continue;

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
      const normalizedBrand = aiPayload.brand || "";
      const normalizedCategory = aiPayload.category || "";
      let normalizedSizeValue = aiPayload.size_value || "";
      let normalizedSizeUnit = aiPayload.size_unit || "";
      const normalizedQuantity = aiPayload.quantity || "1";
      let sizeConfidence = Number(aiPayload.size_confidence || 0);

      const isSizeMissing = !String(normalizedSizeValue || "").trim() || !String(normalizedSizeUnit || "").trim();
      if (isSizeMissing) {
        const sizeFallback = extractFallbackSizeFromAiText(aiPayload, aiResponse);
        if (sizeFallback?.size_value && sizeFallback?.size_unit) {
          normalizedSizeValue = sizeFallback.size_value;
          normalizedSizeUnit = sizeFallback.size_unit;
          sizeConfidence = 0.75;
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

      let finalRow = savedRow;

      if (normalizedProductName) {
        setStatus("Updating product with AI result...");

        const { data: updatedRow, error: updateError } = await supabase
          .from("catalog_products")
          .update({
            product_name: normalizedProductName,
            brand: normalizedBrand,
            size_value: normalizedSizeValue,
            size_unit: normalizedSizeUnit,
            quantity: normalizedQuantity,
            source: initialSourceValue,
          })
          .eq("id", savedRow?.id)
          .select("id, barcode, product_name, image_url, brand, source, size_value, size_unit, quantity")
          .single();

        if (updateError) throw new Error(`AI update failed: ${updateError.message}`);

        finalRow = updatedRow;
        setStatus("? AI identified product");
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

      const finalProduct = {
        catalog_id: finalRow?.id || savedRow?.id || null,
        name: finalResolvedProductName,
        image: finalRow?.image_url || firstImageUrl,
        barcode: normalizedBarcode || productKey,
        is_photo_only: isPhotoOnlyProduct,
        brand: finalRow?.brand || normalizedBrand || "",
        category: normalizedCategory || "",
        size_value: lockedSizeValue,
        size_unit: lockedSizeUnit,
        quantity: lockedQuantity,
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

      setProduct(finalProduct);
      const aiCartPriceType = detectedPriceFromAi
        ? mapDetectedUnitToPriceType(detectedPriceFromAi.unit)
        : "each";
      const aiCartItem = {
        id: Date.now(),
        name: finalProduct.name,
        product_name: finalProduct.name,
        price: detectedPriceFromAi?.amount ?? null,
        avg_price: null,
        price_type: aiCartPriceType,
        quantity: finalProduct.quantity || "1",
        size: finalProduct.size_value || null,
        unit: finalProduct.size_unit || null,
        size_value: finalProduct.size_value || "",
        size_unit: finalProduct.size_unit || "",
        source: "ai",
        price_badge_source: detectedPriceFromAi ? "ai" : "manual",
        price_source: detectedPriceFromAi ? "photo_sign" : "missing",
        price_unit_detected: detectedPriceFromAi?.unit || "unknown",
        barcode: finalProduct.barcode || null,
        brand: finalProduct.brand || "",
      };
      const aiAddFingerprint = [
        aiCartItem.barcode || "",
        aiCartItem.name || "",
        aiCartItem.price ?? "",
        aiCartItem.size_value || "",
        aiCartItem.size_unit || "",
      ]
        .join("|")
        .toLowerCase();
      const now = Date.now();
      const lockWindowMs = 1500;
      const isRapidDuplicate =
        aiAutoAddGuardRef.current.fingerprint === aiAddFingerprint &&
        now - aiAutoAddGuardRef.current.timestamp < lockWindowMs;
      const normalizedFinalName = String(finalProduct?.name || "").trim().toLowerCase();
      const canAutoAddAiItem = normalizedFinalName !== "unknown product" && normalizedFinalName !== "review needed";

      if (!isRapidDuplicate && canAutoAddAiItem) {
        handleAddToShoppingList(aiCartItem, null);
        aiAutoAddGuardRef.current = {
          fingerprint: aiAddFingerprint,
          timestamp: now,
        };
      } else if (!canAutoAddAiItem) {
        console.info("AI auto-add skipped: product name requires user review");
      } else {
        console.info("AI auto-add skipped: duplicate within lock window");
      }
      if (!detectedPriceFromAi) {
        setPriceConfirmed(false);
        setLocationForm((prev) => ({
          ...prev,
          price: "",
          price_source: "manual",
          detected_price_unit: "unknown",
        }));
        setStatus("Product identified. Enter price manually or skip price for now.");
      }
      setAwaitingProductConfirmation(true);
      setShowAiSummaryCard(false);
      setShowOptionalBarcodeInput(false);
      setOptionalBarcodeInput(normalizedBarcode || "");
      setPhotoAnalysisStatus('done');

      if (detectedPriceFromAi) {
        const detectedUnitLabel = formatDetectedUnitLabel(detectedPriceFromAi.unit);
        setStatus(`AI found price: $${detectedPriceFromAi.amount.toFixed(2)}${detectedUnitLabel}`);
      }

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
          last_user_profile_id: currentUserProfile?.id || null,
          last_user_trust_score: currentUserProfile?.trust_score || 0,
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
        aisle,
        section,
        shelf,
        store_id: selectedStore.id,
        store_name: selectedStore.name,
        price_type: bestKnownLocation?.price_type || "each",
        avg_price: bestKnownLocation?.avg_price ?? null,
        notes: bestKnownLocation?.notes ?? "",
      };

      if (bestKnownLocation?.price != null) {
        locationMemory.price = bestKnownLocation.price;
      }

      setShoppingListItems((prev) => {
        const existingIndex = prev.findIndex((item) => item.barcode === barcode);

        if (existingIndex >= 0) {
          const next = [...prev];
          next[existingIndex] = {
            ...next[existingIndex],
            ...locationMemory,
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
            quantity: product?.quantity || "1",
            ...locationMemory,
          },
        ];
      });

      // TODO: Future Google Maps directions hook.

      setStatus(
        `? Location confirmed and added to your cart memory • ${strongConfirmationCount} ${
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

      const updatedProduct = {
        name: updatedRow.product_name || correctedName,
        image: updatedRow.image_url || product.image,
        barcode: updatedRow.barcode || product.barcode,
        brand: updatedRow.brand || correctedBrand,
        source: updatedRow.source || "user_corrected",
      };

      setProduct(updatedProduct);
      setCorrectionSaved(true);
      setActivePanel(null);
      setStatus("? Product correction saved. Review or update location.");
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
      setActivePanel("location");
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
      const barcodeValue = String(barcode || "").trim() || null;
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

      const locationPayload = {
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
        last_user_profile_id: currentUserProfile?.id || null,
        last_user_trust_score: currentUserProfile?.trust_score || 0,
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

      const hasOptionalPriceFieldError = /price_source|price_unit_detected|ai_confidence|photo_evidence_count|column/i.test(
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
          last_user_profile_id: currentUserProfile?.id || null,
          last_user_trust_score: currentUserProfile?.trust_score || 0,
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

      const { data: verifiedLocationRow, error: verifyError } = await applyBarcodeFilter(
        supabase
          .from("product_locations")
          .select("barcode, aisle, section, shelf, notes, price, price_type, source, last_confirmed_at, avg_price, price_count, price_confidence")
          .eq("store_id", selectedStore.id)
      ).maybeSingle();

      if (verifyError) {
        throw new Error(`Could not verify saved price type: ${verifyError.message}`);
      }

      let confirmationCount = 0;
      let confidenceScore = weightedConfidenceScore;

      if (barcodeValue) {
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
          throw new Error("Location saved, but confirmation could not be recorded");
        }

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
          throw new Error(`Could not count confirmations: ${countError.message}`);
        }

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
          throw new Error(
            `Location was saved but confidence update failed: ${updateError.message}`
          );
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
      }

      await fetchUserPoints();
      await updateUserTrustScore(2);

      const savedLocation = {
        barcode: barcodeValue,
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
      setShoppingListItems((prev) => {
        const existingIndex = prev.findIndex((item) =>
          doesCartItemMatchProduct(item, {
            barcode: barcodeValue,
            product_name: product?.name || "Unknown product",
            brand: product?.brand || "",
            store_id: selectedStore.id,
          })
        );
        const updatedItemFields = {
          barcode: barcodeValue,
          price: savedLocation.price,
          avg_price: savedLocation.avg_price,
          price_type: savedLocation.price_type,
          price_source: savedLocation.price_source,
          price_unit_detected: savedLocation.price_unit_detected,
          confidence_score: savedLocation.confidence_score,
          price_confidence: savedLocation.price_confidence,
          ai_confidence: savedLocation.ai_confidence,
          photo_evidence_count: savedLocation.photo_evidence_count,
          aisle: savedLocation.aisle,
          section: savedLocation.section,
          shelf: savedLocation.shelf,
          notes: savedLocation.notes || "",
          store_id: selectedStore.id,
          store_name: selectedStore.name,
          size_value: sizeValue || "",
          size_unit: sizeUnit || "",
          quantity: quantity || "1",
        };

        if (existingIndex >= 0) {
          const next = [...prev];
          next[existingIndex] = {
            ...next[existingIndex],
            ...updatedItemFields,
          };
          return next;
        }

        return [
          ...prev,
          {
            barcode: barcodeValue,
            product_name: product?.name || "Unknown product",
            brand: product?.brand || "",
            brand_lock: false,
            ...updatedItemFields,
          },
        ];
      });
      setLocationSaved(true);
      setLocationConfirmationCount(confirmationCount);
      setLocationConfidenceScore(confidenceScore);
      setActivePanel(null);

      // HARD RESET CURRENT ITEM UI
      setAwaitingPhoto(false);
      resetAiPhotoState();

      setStatus("Saving complete. Preparing next scan...");
      setShowNextItemPrompt(true);

      setTimeout(() => {
        setShowNextItemPrompt(false);

        setProduct(null);
        setBarcode("");
        setBestKnownLocation(null);
        resetContributionFlow();

        setStatus("Ready for next item");

        startScanner();
      }, 1200);
      setProduct((prev) =>
        prev
          ? {
              ...prev,
              size_value: sizeValue || "",
              size_unit: sizeUnit || "",
              quantity: quantity || "",
            }
          : prev
      );

      const confirmationLabel =
        confirmationCount === 1
          ? "1 confirmation"
          : `${confirmationCount} confirmations`;

      setStatus(
        `? Location saved • ${confirmationLabel} • confidence ${confidenceScore}%`
      );
      setToast({ message: 'Location saved!', type: 'success' });
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

  // ============================================================================
  // PROFILE LOGIC - Create & Save User Profile
  // ============================================================================

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

  const handleResetProfile = () => {
    localStorage.removeItem("currentUserProfile");
    setCurrentUserProfile(null);
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

    try {
      // Fetch current trust_score to avoid race conditions
      const { data, error } = await supabase
        .from("profiles")
        .select("trust_score")
        .eq("id", currentUserProfile.id)
        .single();

      if (error) throw error;

      const newTrustScore = Number(data?.trust_score || 0) + increment;

      const { data: updatedProfile, error: updateError } = await supabase
        .from("profiles")
        .update({
          trust_score: newTrustScore,
          updated_at: new Date().toISOString()
        })
        .eq("id", currentUserProfile.id)
        .select()
        .single();

      if (updateError) throw updateError;

      // Persist locally
      setCurrentUserProfile(updatedProfile);
      localStorage.setItem("currentUserProfile", JSON.stringify(updatedProfile));

    } catch (err) {
      console.error("TRUST SCORE UPDATE ERROR:", err);
    }
  };

  const handleAddToShoppingList = (productToAdd = product, locationToUse = bestKnownLocation) => {
    if (!productToAdd) {
      setError("No product available to add");
      return { added: false, updated: false, hasLocation: false };
    }

    const itemBarcode = productToAdd.barcode || barcode || null;
    const itemStoreId = locationToUse?.store_id || selectedStore?.id || "";
    const itemProductName = productToAdd.name || "Unknown product";
    const itemBrand = productToAdd.brand || "";

    const hasLocation = Boolean(locationToUse?.aisle || locationToUse?.section || locationToUse?.shelf);

    if (
      shoppingListItems.some((item) =>
        doesCartItemMatchProduct(item, {
          barcode: itemBarcode,
          product_name: itemProductName,
          brand: itemBrand,
          store_id: itemStoreId,
        })
      )
    ) {
      setShoppingListItems((prev) =>
        prev.map((item) => {
          const isMatch = doesCartItemMatchProduct(item, {
            barcode: itemBarcode,
            product_name: itemProductName,
            brand: itemBrand,
            store_id: itemStoreId,
          });

          if (!isMatch) return item;

          return {
            ...item,
            id: item.id || productToAdd.id || item.cart_item_id,
            name: productToAdd.name || itemProductName || item.name || item.product_name,
            product_name: itemProductName || item.product_name,
            brand: itemBrand || item.brand,
            source: productToAdd.source || item.source || "manual",
            size: productToAdd.size ?? productToAdd.size_value ?? item.size ?? item.size_value ?? null,
            unit: productToAdd.unit ?? productToAdd.size_unit ?? item.unit ?? item.size_unit ?? null,
            size_value: productToAdd.size_value || item.size_value || "",
            size_unit: productToAdd.size_unit || item.size_unit || "",
            quantity: productToAdd.quantity || item.quantity || "1",
            notes: locationToUse?.notes ?? productToAdd.notes ?? item.notes ?? "",
            price: locationToUse?.price ?? productToAdd.price ?? item.price ?? null,
            avg_price: locationToUse?.avg_price ?? productToAdd.avg_price ?? item.avg_price ?? null,
            price_type: locationToUse?.price_type ?? productToAdd.price_type ?? item.price_type ?? "each",
            price_source: locationToUse?.price_source ?? productToAdd.price_source ?? item.price_source ?? null,
            price_badge_source:
              locationToUse?.price_badge_source ??
              productToAdd.price_badge_source ??
              item.price_badge_source ??
              (productToAdd.source === "ai" ? "ai" : "manual"),
            price_unit_detected:
              locationToUse?.price_unit_detected ??
              productToAdd.price_unit_detected ??
              item.price_unit_detected ??
              "unknown",
            aisle: locationToUse?.aisle || item.aisle || "",
            section: locationToUse?.section || item.section || "",
            shelf: locationToUse?.shelf || item.shelf || "",
          };
        })
      );
      setToast({ message: "Added to Smart Cart", type: "success" });
      return { added: false, updated: true, hasLocation };
    }

    const item = {
      cart_item_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      id: productToAdd.id || Date.now(),
      name: productToAdd.name || itemProductName,
      barcode: itemBarcode,
      product_name: itemProductName,
      brand: itemBrand,
      store_id: itemStoreId || null,
      store_name: locationToUse?.store_name || selectedStore?.name || "",
      source: productToAdd.source || "manual",
      size: productToAdd.size ?? productToAdd.size_value ?? null,
      unit: productToAdd.unit ?? productToAdd.size_unit ?? null,
      size_value: productToAdd.size_value || "",
      size_unit: productToAdd.size_unit || "",
      quantity: productToAdd.quantity || "1",
      notes: locationToUse?.notes ?? productToAdd.notes ?? "",
      price: locationToUse?.price ?? productToAdd.price ?? null,
      avg_price: locationToUse?.avg_price ?? productToAdd.avg_price ?? null,
      price_type: locationToUse?.price_type ?? productToAdd.price_type ?? "each",
      price_source: locationToUse?.price_source ?? productToAdd.price_source ?? null,
      price_badge_source:
        locationToUse?.price_badge_source ??
        productToAdd.price_badge_source ??
        (productToAdd.source === "ai" ? "ai" : "manual"),
      price_unit_detected:
        locationToUse?.price_unit_detected ?? productToAdd.price_unit_detected ?? "unknown",
      brand_lock: false,
    };

    setShoppingListItems((prev) => [...prev, item]);
    setToast({ message: "? Added to shopping list", type: "success" });
    return { added: true, updated: false, hasLocation };
  };

  const handleRemoveProductFromCart = () => {
    if (!currentProductBarcode && !currentProductName) {
      return;
    }

    setShoppingListItems((prev) =>
      prev.filter((item) => {
        return !doesCartItemMatchProduct(item, {
          barcode: currentProductBarcode,
          product_name: currentProductName,
          brand: currentProductBrand,
          store_id: currentProductStoreId,
        });
      })
    );
  };

  const handleAddManualListItem = () => {
    const trimmed = manualListItemName.trim();
    if (!trimmed) return;

    setShoppingListItems((prev) => [
      ...prev,
      {
        id: Date.now(),
        name: trimmed,
        barcode: "",
        product_name: trimmed,
        brand: "",
        source: "manual",
        size: null,
        unit: null,
        size_value: "",
        size_unit: "",
        quantity: "1",
        notes: "",
        price_badge_source: "manual",
        brand_lock: false,
      },
    ]);

    setManualListItemName("");
    setToast({ message: "Item added to shopping list", type: "success" });
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

    const parsedPrice = Number(item?.avg_price ?? item?.price);
    const priceInCents = Number.isFinite(parsedPrice) && parsedPrice > 0
      ? String(Math.round(parsedPrice * 100))
      : "";

    setError("");
    setActivePanel("location");
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
      aisle: item?.aisle || "",
      section: item?.section || "",
      shelf: item?.shelf || "",
      notes: item?.notes || "",
      size_value: item?.size_value || prev.size_value || "",
      size_unit: item?.size_unit || prev.size_unit || "",
      quantity: item?.quantity || prev.quantity || "1",
      price: priceInCents || prev.price || "",
      price_type: item?.price_type || prev.price_type || "each",
      price_source: item?.price_source || prev.price_source || "",
      detected_price_unit: item?.price_unit_detected || prev.detected_price_unit || "unknown",
    }));

    setToast({ message: `Update location for ${item?.product_name || "item"}`, type: "success" });
  };

  const handleSmartCartUpdateLocation = (smartItem) => {
    const item = smartItem.item;

    setProduct({
      name: item.product_name,
      brand: item.brand,
      barcode: item.barcode || "",
      size_value: item.size_value || "",
      size_unit: item.size_unit || "",
      quantity: item.quantity || "",
    });

    setBarcode(item.barcode || "");

    setLocationForm({
      aisle: item.aisle || "",
      section: item.section || "",
      shelf: item.shelf || "",
      notes: item.notes || "",
      size_value: item.size_value || "",
      size_unit: item.size_unit || "",
      quantity: item.quantity || "",
      price: item.price ? String(Math.round(item.price * 100)) : "",
      price_type: item.price_type || "each",
      price_source: "",
      detected_price_unit: "unknown",
    });

    setActivePanel("location");
    setLocationPanelMode("quick");
    setLocationStep("aisle");
    setStatus("Update this item location");
  };

  const handleSmartCartHelpLocate = (smartItem) => {
    if (!smartItem) return;
    const item = smartItem.item || smartItem;
    handleUpdateCartItemLocation(item);
    setStatus("Add the location for this item");
  };

  const handleSmartCartMarkFound = (smartItem) => {
    if (smartItem.aisle) {
      setToast({ message: "Location confirmed ready", type: "success" });
    } else {
      handleSmartCartUpdateLocation(smartItem);
    }
  };

  const handleRemoveShoppingListItem = (indexToRemove) => {
    if (editingCartItemIndex === indexToRemove) {
      setEditingCartItemIndex(null);
      setCartEditForm(null);
      setCartEditError("");
    }

    setShoppingListItems((prev) =>
      prev.filter((_, index) => index !== indexToRemove)
    );
  };

  const startEditingCartItem = (item, index) => {
    const itemPrice = item.avg_price ?? item.price;
    setEditingCartItemIndex(index);
    setCartEditError("");
    setCartEditForm({
      product_name: item.product_name || "",
      quantity: item.quantity || "",
      size_value: item.size_value || item.size || "",
      size_unit: item.size_unit || item.unit || "",
      notes: item.notes || "",
      price: itemPrice != null ? Number(itemPrice).toFixed(2) : "",
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
              quantity: quantity || "1",
              size: sizeValue || null,
              unit: sizeUnit || null,
              size_value: sizeValue,
              size_unit: sizeUnit,
              notes,
              price: parsedPrice,
              avg_price: parsedPrice,
              price_badge_source: "manual",
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
    await startLivePreview();
    setAwaitingPhoto(true);
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
    const productName = correctionForm.product_name.trim();
    if (!productName) {
      setError("Product name is required");
      return;
    }

    const confirmedBarcode = optionalBarcodeInput.trim() || product?.barcode || null;

    const confirmedProduct = {
      ...product,
      name: productName,
      brand: correctionForm.brand.trim(),
      category: correctionForm.category?.trim() || "",
      size_value: locationForm.size_value,
      size_unit: locationForm.size_unit,
      quantity: locationForm.quantity,
      barcode: confirmedBarcode,
    };

    setProduct(confirmedProduct);
    setBarcode(confirmedBarcode || "");
    setAwaitingProductConfirmation(false);
    setShowAiSummaryCard(false);
    setError("");

    const addResult = handleAddToShoppingList(confirmedProduct, null);
    if (!addResult?.updated) {
      setActivePanel("location");
      setLocationPanelMode("quick");
      setLocationStep("aisle");
      setStatus("Product confirmed. Add location and price.");
    } else {
      setStatus("Added to Smart Cart");
    }
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
    };

    setProduct(confirmedProduct);
    setBarcode(confirmedBarcode || "");
    setAwaitingProductConfirmation(false);
    setShowAiSummaryCard(false);
    setError("");

    const addResult = handleAddToShoppingList(confirmedProduct, null);
    if (!addResult?.updated) {
      setActivePanel("location");
      setLocationPanelMode("quick");
      setLocationStep("aisle");
      setStatus("AI summary confirmed. Add location and price.");
    } else {
      setStatus("Added to Smart Cart");
    }
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

  const getAiFieldIndicator = (field, hasValue) => {
    if (aiUserEditedFields[field]) {
      return {
        text: "?? User edited",
        style: styles.fieldConfidenceBadgeEdited,
      };
    }

    if (aiAutoLockedFields[field] && Number(aiFieldConfidence[field] || 0) >= 0.85 && hasValue) {
      return {
        text: "? Auto-detected",
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

    // price_type = "each" — try to normalize by size
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
    const barcodes = [...new Set((shoppingList || []).map((item) => item.barcode).filter(Boolean))];
    const totalItems = (shoppingList || []).length;

    const cartByBarcode = Object.fromEntries(
      (shoppingList || []).filter((i) => i.barcode).map((i) => [i.barcode, i])
    );

    const groupedByStore = (product_locations || []).reduce((acc, row) => {
      const storeId = row.store_id;
      const price = Number(row.avg_price || row.price);

      if (!storeId || Number.isNaN(price) || !barcodes.includes(row.barcode)) {
        return acc;
      }

      if (!acc[storeId]) {
        acc[storeId] = {
          store_id: storeId,
          store: row.stores || null,
          rowsByBarcode: {},
        };
      }

      const existing = acc[storeId].rowsByBarcode[row.barcode];
      if (!existing || price < Number(existing.avg_price || existing.price)) {
        acc[storeId].rowsByBarcode[row.barcode] = row;
      }

      return acc;
    }, {});

    return Object.values(groupedByStore)
      .map((storeGroup) => {
        const matchedBarcodes = Object.keys(storeGroup.rowsByBarcode);
        const matched = matchedBarcodes.length;
        const missingCount = Math.max(totalItems - matched, 0);
        const coverage = totalItems > 0 ? Math.round((matched / totalItems) * 100) : 0;

        let totalPrice = 0;
        let totalConfidence = 0;
        let exactBrandMatches = 0;
        let brandLockItems = 0;
        let hasEstimate = false;

        matchedBarcodes.forEach((bc) => {
          const row = storeGroup.rowsByBarcode[bc];
          const cartItem = cartByBarcode[bc];
          const price = Number(row.avg_price || row.price);
          totalPrice += price;
          totalConfidence += Number(row.price_confidence || 0);

          if (cartItem?.brand && row.brand) {
            if (cartItem.brand_lock) brandLockItems++;
            if (cartItem.brand && row.brand && cartItem.brand.toLowerCase() === row.brand.toLowerCase()) {
              exactBrandMatches++;
            }
          }

          if (!row.avg_price || Number(row.price_confidence || 0) < 40) {
            hasEstimate = true;
          }
        });

        const avgConfidence = matched > 0 ? Math.round(totalConfidence / matched) : 0;
        const brandMatchPct = matched > 0 ? Math.round((exactBrandMatches / matched) * 100) : 0;
        const missingPenalty = missingCount * 5;
        const brandPenalty = brandMode === "brand_match" ? (matched - exactBrandMatches) * 3 : 0;
        const score = totalPrice + missingPenalty + brandPenalty;

        return {
          store_id: storeGroup.store_id,
          store: storeGroup.store,
          matched_count: matched,
          total_price: totalPrice,
          coverage,
          score,
          missing_count: missingCount,
          avg_confidence: avgConfidence,
          brand_match_pct: brandMatchPct,
          is_estimate: hasEstimate,
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

    const barcodes = [...new Set(
      shoppingListItems.map((item) => item.barcode).filter(Boolean)
    )];

    if (barcodes.length === 0) {
      setError("No barcodes found in shopping list items");
      return;
    }

    setIsComparingCart(true);
    setError("");

    try {
      const { data, error: compareError } = await supabase
        .from("product_locations")
        .select("barcode, price, price_type, avg_price, price_count, price_confidence, store_id, stores(name, address, city, state)")
        .in("barcode", barcodes)
        .not("price", "is", null);

      if (compareError) {
        throw compareError;
      }

      const sortedResults = calculateBestStore(shoppingListItems, data || [], brandComparisonMode)
        .filter((result) => result.matched_count > 0);

      setCartComparison(sortedResults);
      setToast({ message: "Cart comparison complete", type: "success" });
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
      setAwaitingPhoto(false);
      setSubmissionMethod("manual barcode");

      const addResult = handleAddToShoppingList(knownProduct, knownLocation);

      if (!knownLocation && !addResult?.updated) {
        setActivePanel("location");
        setLocationPanelMode("quick");
        setLocationStep("aisle");
      }

      setStatus("Known product found from manual barcode.");
      return;
    }

    setAwaitingPhoto(true);
    setStatus("New barcode entered. Capture product photo.");
    await startLivePreview();
  };

  const renderLocationWizardStep = () => {
    if (locationStep === "aisle") {
      return (
        <div>
          <div style={styles.stepLabel}>Step 1 of 3</div>
          <h3 style={styles.stepTitle}>Enter aisle or area</h3>

          <label style={styles.label}>Aisle / Area</label>
          <input
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

          <div style={styles.buttonRow}>
            <button
              type="button"
              style={styles.primaryButton}
              onClick={() => {
                if (!locationForm.aisle.trim()) {
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
            {SECTION_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                style={{
                  ...styles.quickButton,
                  ...(locationForm.section === option ? styles.quickButtonActive : {}),
                }}
                onClick={() => setLocationForm((prev) => ({ ...prev, section: option }))}
              >
                {option}
              </button>
            ))}
            <button
              type="button"
              style={{
                ...styles.quickButton,
                ...(!locationForm.section ? styles.quickButtonActive : {}),
              }}
              onClick={() => setLocationForm((prev) => ({ ...prev, section: "" }))}
            >
              Skip section
            </button>
          </div>

          <label style={styles.label}>Shelf</label>
          <div style={styles.quickButtonRow}>
            {SHELF_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                style={{
                  ...styles.quickButton,
                  ...(locationForm.shelf === option ? styles.quickButtonActive : {}),
                }}
                onClick={() => setLocationForm((prev) => ({ ...prev, shelf: option }))}
              >
                {option}
              </button>
            ))}
            <button
              type="button"
              style={{
                ...styles.quickButton,
                ...(!locationForm.shelf ? styles.quickButtonActive : {}),
              }}
              onClick={() => setLocationForm((prev) => ({ ...prev, shelf: "" }))}
            >
              Skip shelf
            </button>
          </div>

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
      const isWeightedArea = ["Produce", "Meat / Poultry"].includes(locationForm.aisle);
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

          {/* â”€â”€ Size / Quantity â”€â”€ */}
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

          {/* â”€â”€ Egg package sizes â”€â”€ */}
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

          {/* â”€â”€ Price confirmation card â”€â”€ */}
          <label style={styles.label}>Price</label>

          {/* Source badge — always visible */}
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

          {/* AI price card — shown when AI detected a price and user hasn't confirmed yet */}
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

          {/* Green confirmation bar — shown after price is confirmed */}
          {priceConfirmed && locationForm.price ? (
            <div style={styles.aiPriceConfirmedBar}>
              ? Confirmed price: ${formatCentsToDollars(locationForm.price)}
              {detectedUnitLabel ? ` ${detectedUnitLabel}` : ` ${formatPriceType(locationForm.price_type)}`}
            </div>
          ) : null}

          {/* Price input — always visible; disabled when AI price exists and not yet editing */}
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

          {/* Manual confirm button — shown when no AI price, or after editing */}
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
              ? Confirm price: ${formatCentsToDollars(locationForm.price)}{" "}
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
          <div><strong>Aisle / Area:</strong> {locationForm.aisle || "—"}</div>
          <div><strong>Section:</strong> {locationForm.section || "—"}</div>
          <div><strong>Shelf:</strong> {locationForm.shelf || "—"}</div>
          <div><strong>Size:</strong> {locationForm.size_value || "—"} {locationForm.size_unit || ""}</div>
          <div><strong>Package Size:</strong> {locationForm.quantity || "—"}</div>
          <div><strong>Price:</strong> ${formatCentsToDollars(locationForm.price)} {formatPriceType(locationForm.price_type)}</div>
          {locationForm.price_source === "missing" ? (
            <div><strong>Price note:</strong> Price skipped — add later</div>
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
          <button type="button" style={styles.primaryButton} onClick={handleSaveLocation}>
            Save Location
          </button>
        </div>
      </div>
    );
  };

  // ============================================================================
  // RENDER - Main UI
  // ============================================================================

  if (isCheckingProfile) return null;

  if (!currentUserProfile && showOnboarding) {
    return (
      <div style={styles.fullScreenCenter}>
        <div style={styles.cardLarge}>
          <h2>How it works</h2>

          <p>📸 Snap product</p>
          <p>💲 Auto-detect price</p>
          <p>🛒 Build smart cart</p>
          <p>⚡ Save time shopping</p>

          <button
            style={styles.primaryButton}
            onClick={() => setShowOnboarding(false)}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  if (!currentUserProfile) {
    return (
      <div style={styles.fullScreenCenter}>
        <div style={styles.cardLarge}>
          <h1>Welcome</h1>

          <p>Start your smart shopping system</p>

          <input
            placeholder="Your name"
            value={profileForm.display_name}
            onChange={(e) =>
              setProfileForm((prev) => ({
                ...prev,
                display_name: e.target.value,
              }))
            }
          />

          <button
            style={styles.primaryButton}
            onClick={handleCreateProfile}
          >
            Continue
          </button>

          <button
            style={styles.secondaryButton}
            onClick={() => setShowOnboarding(true)}
          >
            How it works
          </button>
        </div>
      </div>
    );
  }

  if (currentUserProfile) {
    return (
      <div style={styles.page}>
        <div style={styles.container}>
          <div style={styles.profileHeader}>
            <span>{currentUserProfile.display_name}</span>
            <span>{currentUserProfile.total_points || 0} pts</span>
            <span>Level 1 Contributor</span>
            <button
              type="button"
              style={styles.changeStoreButton}
              onClick={handleResetProfile}
            >
              Switch Profile
            </button>
          </div>

        <div style={styles.headerMetaRow}>
          <div style={styles.pointsHeaderBadge}>
            <span style={styles.chipIcon}>?</span>
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

        {/* ================= PROFILE STATUS ================= */}
        <div style={{ ...styles.infoBox, marginBottom: 14, borderRadius: 14, boxShadow: "0 6px 18px rgba(15, 23, 42, 0.08)", background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#166534" }}>
            ? Logged in as: {currentUserProfile.display_name}
          </div>
        </div>

        {/* ================= SMART CART ================= */}
        <div style={{ ...styles.infoBox, marginBottom: 14, borderRadius: 14, boxShadow: "0 6px 18px rgba(15, 23, 42, 0.08)" }}>
          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
            <div style={{ fontSize: 19, fontWeight: 900, color: "#0f172a" }}>?? Smart Shopping</div>
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
              <div style={{ fontSize: 11, fontWeight: 800, color: "#92400e", textTransform: "uppercase" }}>Needs Location</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: "#0f172a" }}>{smartShoppingNeedsLocationCount}</div>
            </div>
          </div>

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
              Your Smart Cart is empty. Add items to begin.
            </div>
          ) : (
            <>
              {/* -- Items to Locate (always promoted to top) -- */}
              {smartShoppingItemsToLocate.length > 0 ? (
                <div style={{ border: "1px solid #fcd34d", background: "#fffbeb", borderRadius: 12, padding: 10, marginBottom: 14 }}>
                  <div style={{ fontSize: 14, fontWeight: 900, color: "#92400e", marginBottom: 8 }}>
                    ?? Help Locate These Items
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
                              price: item.price ? String(Math.round(item.price * 100)) : "",
                              price_type: item.price_type || "each",
                              price_source: "",
                              detected_price_unit: "unknown",
                            });
                            setActivePanel("location");
                            setLocationPanelMode("quick");
                            setLocationStep("aisle");
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
                                      {[smartItem.section && `Section: ${smartItem.section}`, smartItem.shelf && `Shelf: ${smartItem.shelf}`].filter(Boolean).join(" · ")}
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
                                        ? Trusted contributor impact active
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
                                          aisle: item.aisle || "",
                                          section: item.section || "",
                                          shelf: item.shelf || "",
                                          notes: item.notes || "",
                                          size_value: item.size_value || "",
                                          size_unit: item.size_unit || "",
                                          quantity: item.quantity || "",
                                          price: item.price ? String(Math.round(item.price * 100)) : "",
                                          price_type: item.price_type || "each",
                                          price_source: "",
                                          detected_price_unit: "unknown",
                                        });
                                        setActivePanel("location");
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
                  {activeAisleView ? (
                    <button
                      type="button"
                      onClick={() => setActiveAisleView(null)}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "#1e40af",
                        fontSize: 13,
                        fontWeight: 800,
                        padding: 0,
                        marginBottom: 10,
                        cursor: "pointer",
                      }}
                    >
                      ? Back to All Aisles
                    </button>
                  ) : null}

                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
                    {smartShoppingVisibleAisleGroups.map((group) => {
                      const aisleBadge = getConfidenceBadge(group.aisleConfidence);
                      return (
                        <div
                          key={`browse-aisle-${group.aisleLabel}`}
                          style={{ border: "1px solid #dbeafe", background: "#ffffff", borderRadius: 12, padding: 10, cursor: "pointer" }}
                          onClick={() => setActiveAisleView(group.aisleLabel)}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}>
                            <div style={{ fontSize: 14, fontWeight: 800, color: "#1e40af" }}>{group.aisleLabel}</div>
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
                              const confidenceText = score >= 90
                                ? "High confidence"
                                : score >= 70
                                  ? "Moderate confidence"
                                  : "Needs verification";
                              const isTrustedContributor = currentUserProfile?.trust_score >= 50;
                              return (
                                <div
                                  key={`browse-item-${smartItem.originalIndex}`}
                                  style={{
                                    padding: "10px 8px",
                                    borderTop: itemIndex > 0 ? "1px solid #e2e8f0" : "none",
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                >
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
                                      {[smartItem.section && `Section: ${smartItem.section}`, smartItem.shelf && `Shelf: ${smartItem.shelf}`].filter(Boolean).join(" · ")}
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
                                        ? Trusted contributor impact active
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
                                          aisle: item.aisle || "",
                                          section: item.section || "",
                                          shelf: item.shelf || "",
                                          notes: item.notes || "",
                                          size_value: item.size_value || "",
                                          size_unit: item.size_unit || "",
                                          quantity: item.quantity || "",
                                          price: item.price ? String(Math.round(item.price * 100)) : "",
                                          price_type: item.price_type || "each",
                                          price_source: "",
                                          detected_price_unit: "unknown",
                                        });
                                        setActivePanel("location");
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
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <div style={styles.rewardsSection}>
          <div style={styles.rewardsSectionHeader}>Shopping List / Smart Cart</div>
          <button
            type="button"
            onClick={() => {
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
          <div style={styles.rewardDescription}>
            Build your cart first, then MVP can help suggest the most frugal or sensible store based on known prices and item availability.
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 14, marginBottom: 14 }}>
            <input
              type="text"
              value={manualListItemName}
              onChange={(e) => setManualListItemName(e.target.value)}
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

          {shoppingListItems.length > 0 ? (
            <>
              <div style={{ fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, color: "#475569", margin: "2px 2px 8px" }}>
                Detailed cart
              </div>
              <div style={styles.rewardsGrid}>
              {smartCartAisleGroups.map(([aisleLabel, groupedItems]) => (
                <div key={`aisle-${aisleLabel}`} style={{ gridColumn: "1 / -1" }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 800,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      color: "#1e3a8a",
                      margin: "8px 2px 10px",
                    }}
                  >
                    {aisleLabel}
                  </div>

                  <div style={styles.rewardsGrid}>
                    {groupedItems.map((smartItem) => {
                      const item = smartItem.item;
                      const index = smartItem.originalIndex;
                      const itemPrice = item.avg_price ?? item.price;
                      const priceTypeLabel = formatPriceType(item.price_type);
                      const isEditing = editingCartItemIndex === index;
                      const isEggCartItem = isEggText(item.product_name);

                      return (
                        <div
                          key={`${item.barcode || item.product_name || "item"}-${index}`}
                          style={styles.rewardCard}
                        >
                  <div style={styles.rewardTitle}>{item.product_name}</div>
                  <div style={styles.rewardDescription}>
                    {item.brand || "Unknown brand"}
                    {item.size_value || item.size_unit
                      ? ` • ${item.size_value || ""}${item.size_unit ? ` ${item.size_unit}` : ""}`
                      : ""}
                    {item.quantity ? ` • qty ${item.quantity}` : ""}
                    {itemPrice != null
                      ? ` • $${Number(itemPrice).toFixed(2)} ${priceTypeLabel}`
                      : item.price_source === "missing"
                        ? " • Price not added yet"
                        : ""}
                    {item.notes ? ` • note: ${item.notes}` : ""}
                  </div>

                  <div style={{ ...styles.rewardDescription, marginTop: -2 }}>
                    Confidence: {Number(smartItem.confidence_score || 0)}%
                    {smartItem.needsContribution ? " • Needs contribution" : " • Known location"}
                  </div>

                  <div style={{ ...styles.rewardDescription, marginTop: -2 }}>
                    {item.price_badge_source === "manual" ? "🟡 User edited" : "🟢 AI detected"}
                  </div>

                  {isEditing && cartEditForm ? (
                    <div style={{ marginTop: 8 }}>
                      <label style={styles.label}>Product name</label>
                      <input
                        type="text"
                        value={cartEditForm.product_name}
                        onChange={(e) =>
                          setCartEditForm((prev) => ({ ...prev, product_name: e.target.value }))
                        }
                        style={styles.input}
                      />

                      <label style={styles.label}>Quantity</label>
                      <input
                        type="text"
                        value={cartEditForm.quantity}
                        onChange={(e) =>
                          setCartEditForm((prev) => ({ ...prev, quantity: e.target.value }))
                        }
                        style={styles.input}
                        placeholder="e.g. 1, dozen, 2 pack"
                      />

                      <label style={styles.label}>Size</label>
                      <input
                        type="text"
                        value={cartEditForm.size_value}
                        onChange={(e) =>
                          setCartEditForm((prev) => ({ ...prev, size_value: e.target.value }))
                        }
                        style={styles.input}
                        placeholder="e.g. 16"
                      />

                      <label style={styles.label}>Unit</label>
                      <input
                        type="text"
                        value={cartEditForm.size_unit}
                        onChange={(e) =>
                          setCartEditForm((prev) => ({ ...prev, size_unit: e.target.value }))
                        }
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
                              onClick={() =>
                                setCartEditForm((prev) => ({ ...prev, quantity: option.value }))
                              }
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
                        onChange={(e) =>
                          setCartEditForm((prev) => ({ ...prev, price: e.target.value }))
                        }
                        style={styles.input}
                        placeholder="e.g. 3.49"
                        inputMode="decimal"
                      />

                      <label style={styles.label}>Area / location notes</label>
                      <textarea
                        value={cartEditForm.notes}
                        onChange={(e) =>
                          setCartEditForm((prev) => ({ ...prev, notes: e.target.value }))
                        }
                        style={styles.textarea}
                        placeholder="Optional note"
                      />

                      {cartEditError ? <div style={styles.errorBox}>{cartEditError}</div> : null}

                      <div style={styles.buttonRow}>
                        <button
                          type="button"
                          onClick={() => saveEditedCartItem(index)}
                          style={styles.primaryButton}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={cancelEditingCartItem}
                          style={styles.secondaryButton}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveShoppingListItem(index)}
                          style={styles.editButton}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {item.brand ? (
                    <div style={{ display: "flex", gap: 6, marginTop: 6, marginBottom: 6 }}>
                      <button
                        type="button"
                        onClick={() =>
                          setShoppingListItems((prev) =>
                            prev.map((el, i) => i === index ? { ...el, brand_lock: false } : el)
                          )
                        }
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
                        onClick={() =>
                          setShoppingListItems((prev) =>
                            prev.map((el, i) => i === index ? { ...el, brand_lock: true } : el)
                          )
                        }
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
                  {!isEditing ? (
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button
                        type="button"
                        onClick={() => startEditingCartItem(item, index)}
                        style={styles.secondaryButton}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveShoppingListItem(index)}
                        style={styles.editButton}
                      >
                        Remove
                      </button>
                    </div>
                  ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
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
              onClick={() => setBrandComparisonMode("flexible")}
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
              onClick={() => setBrandComparisonMode("brand_match")}
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
            onClick={handleCompareCart}
            disabled={shoppingListItems.length === 0 || isComparingCart}
            style={{ ...styles.primaryButton, width: "100%", marginTop: 12 }}
          >
            {isComparingCart ? "Comparing..." : "Find Cheapest Store"}
          </button>

          {cartComparison ? (
            cartComparison.length > 0 ? (
              <div style={{ ...styles.rewardsGrid, marginTop: 12 }}>
                <div style={styles.rewardCard}>
                  <div style={styles.rewardTitle}>
                    ?? Best Value Store: {cartComparison[0].store?.name || "Unknown store"}
                  </div>
                  <div style={styles.rewardDescription}>
                    ?? Estimated Total: ${Number(cartComparison[0].total_price || 0).toFixed(2)}
                  </div>
                  <div style={styles.rewardDescription}>
                    ?? Cart Coverage: {cartComparison[0].coverage}%
                  </div>
                  <div style={styles.rewardDescription}>
                    ??? Brand Match: {cartComparison[0].brand_match_pct ?? "—"}%
                  </div>
                  <div style={styles.rewardDescription}>
                    ?? Price Confidence: {cartComparison[0].avg_confidence ?? "—"}%
                  </div>
                  <div style={styles.rewardDescription}>
                    ??? Brand mode: {brandComparisonMode === "brand_match" ? "Exact brand preferred" : "Flexible"}
                  </div>
                  {cartComparison[0].is_estimate ? (
                    <div style={{ fontSize: 12, color: "#92400e", background: "#fef3c7", borderRadius: 8, padding: "4px 8px", marginTop: 6 }}>
                      Comparison estimate — more scans improve accuracy.
                    </div>
                  ) : null}
                </div>

                {cartComparison.length > 1 ? (
                  <div style={styles.infoBox}>
                    <div style={styles.rewardTitle}>Alternatives</div>
                    {cartComparison.slice(1).map((result, index) => (
                      <div
                        key={`${result.store_id || "store-alt"}-${index}`}
                        style={{ ...styles.rewardDescription, marginBottom: 6 }}
                      >
                        {`${index + 2}?? ${result.store?.name || "Unknown store"} — $${Number(result.total_price || 0).toFixed(2)} • ${result.coverage}% coverage • ${result.brand_match_pct ?? "—"}% brand match`}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div style={{ ...styles.rewardEmptyState, marginTop: 12 }}>
                No price matches found for this cart.
              </div>
            )
          ) : null}
        </div>

        {!selectedStore ? (
          <div style={styles.card}>
            <div style={styles.sectionTitle}>Choose Your Store</div>
            <p style={{ fontSize: 15, color: '#475569', marginBottom: 16, lineHeight: 1.5 }}>
              Select the store before scanning so item locations stay accurate.
            </p>

            <button
              onClick={handleDetectStore}
              disabled={isDetectingStore || isFindingNearbyStores}
              style={{ ...styles.secondaryButton, width: '100%', marginBottom: 16, minHeight: 48 }}
            >
              {isDetectingStore || isFindingNearbyStores ? '?? Searching...' : '?? Use My Location to Find Stores'}
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
                        {s.address ? <span style={{ fontSize: 12, color: '#64748b' }}>{s.address}</span> : null}
                        {s.city ? <span style={{ fontSize: 12, color: '#94a3b8' }}>{s.city}{s.state ? `, ${s.state}` : ''}</span> : null}
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
                {suggestedStore.city && suggestedStore.city !== 'Unknown' && (
                  <div style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
                    {suggestedStore.city}{suggestedStore.state ? `, ${suggestedStore.state}` : ''}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    onClick={() => {
                      console.info("STORE DETECT: confirmed suggested store", suggestedStore);
                      setSelectedStore(suggestedStore);
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
              placeholder="e.g. Target, Walmart, Safeway…"
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
                        latitude: s.latitude ?? null,
                        longitude: s.longitude ?? null,
                        google_place_id: s.google_place_id ?? null,
                      };

                      console.info("STORE SEARCH: selected store option", localStore);
                      handlePickStore(localStore);
                    }}
                    style={styles.storeOptionButton}
                  >
                    <span style={{ fontWeight: 700 }}>{s.name}</span>
                    {s.city || s.address ? (
                      <span style={{ fontSize: 13, color: '#64748b', marginLeft: 8 }}>
                        {s.city ? `${s.city}${s.state ? `, ${s.state}` : ""}` : s.address}
                      </span>
                    ) : null}
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
                    <span style={{ fontWeight: 700 }}>âž• Use "{manualStoreName.trim()}" as my store</span>
                  </button>
                )}

                {storeSearchQuery && filteredStores.length === 0 && (
                  <div style={{ fontSize: 14, color: '#94a3b8', marginTop: 4 }}>
                    No matching stores found. Tap “Find Nearby Stores” or use the option above to add it manually.
                  </div>
                )}
              </div>
            )}

            {error ? <div style={styles.errorBox}>{error}</div> : null}
          </div>
        ) : (
          <>
            <div style={styles.storeBadgeRow}>
              <div style={styles.storeBadge}>
                <span style={styles.chipIcon}>??</span>
                Store: {selectedStore.name}
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
          <div style={{ ...styles.scannerContainer, opacity: availableCameras.length > 0 ? 1 : 0, transform: availableCameras.length > 0 ? 'translateY(0)' : 'translateY(10px)', transition: 'opacity 0.6s ease, transform 0.6s ease' }}>
            <div style={styles.scannerFrame}>
              <div style={styles.scannerCornerTopLeft}></div>
              <div style={styles.scannerCornerTopRight}></div>
              <div style={styles.scannerCornerBottomLeft}></div>
              <div style={styles.scannerCornerBottomRight}></div>
              
              <div style={styles.videoWrap}>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  style={styles.video}
                />
                {!isScanning && !awaitingPhoto && (
                  <div style={styles.overlay}>
                    <div style={styles.overlayIcon}>??</div>
                    <div style={styles.overlayText}>
                      Ready to scan barcodes
                    </div>
                    <div style={styles.overlaySubtext}>
                      Hold barcode anywhere inside the box. Try good lighting and keep the label flat.
                    </div>
                  </div>
                )}
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
                    <div style={{ fontSize: 48, marginBottom: 12 }}>??</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: "#fff", marginBottom: 8 }}>
                      Photo Required
                    </div>
                    <div style={{ fontSize: 15, color: "#e5e7eb", maxWidth: 260 }}>
                      Take a clear front-label photo so MVP can identify this product.
                    </div>
                  </div>
                )}
              </div>
              <canvas ref={canvasRef} style={styles.hiddenCanvas} />
            </div>

            <div style={styles.scannerControls}>
              {!awaitingPhoto ? (!isScanning ? (
                <div style={{ width: "100%" }}>
                  <button onClick={handleStartPhotoFirst} style={styles.scanButton}>
                    <span style={styles.scanButtonIcon}>??</span>
                    Identify Item with Photo
                  </button>
                  <div style={{ ...styles.infoBox, marginTop: 10 }}>
                    Photo-first flow: take or upload a product photo, confirm the AI result, then add location and price.
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button
                      onClick={() => {
                        if (awaitingProductConfirmation) {
                          setShowOptionalBarcodeInput(true);
                          setStatus("Attach a barcode manually or keep it blank.");
                          return;
                        }
                        startScanner();
                      }}
                      style={{ ...styles.secondaryButton, minHeight: 46, flex: "0 0 auto", padding: "0 14px" }}
                    >
                      Add/Scan Barcode (Optional)
                    </button>
                    <input
                      type="text"
                      value={manualBarcode}
                      onChange={(e) => setManualBarcode(e.target.value)}
                      placeholder="Optional barcode entry"
                      style={{ ...styles.input, marginBottom: 0, flex: 1 }}
                    />
                    <button
                      onClick={handleManualBarcodeSubmit}
                      style={{ ...styles.secondaryButton, minHeight: 46, flex: "0 0 auto", padding: "0 14px" }}
                    >
                      Attach
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={stopScanner} style={styles.stopButton}>
                  <span style={styles.stopButtonIcon}>??</span>
                  Stop Scanner
                </button>
              )) : null}
            </div>
          </div>

          {awaitingPhoto && (
            <div style={styles.photoPromptBox}>
              {/* â”€â”€ Header â”€â”€ */}
              <div style={{
                ...styles.infoBox,
                border: "2px solid #f59e0b",
                background: "#fffbeb",
                color: "#92400e",
                fontWeight: 800,
                fontSize: 18,
                marginBottom: 12,
              }}>
                ?? Photo-first item identification
              </div>

              {/* Per-role capture instruction card */}
              {capturedPhotos.length < MAX_PHOTOS && (() => {
                const nextRole = PHOTO_ROLE_SEQUENCE[capturedPhotos.length];
                const roleInstructions = [
                  "Point camera at the product front label — ensure name and brand are clearly visible.",
                  "Point camera at the net weight or size label — usually found on the side or back.",
                  "Point camera at the shelf price tag — include the unit price if visible.",
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
                      ?? Photo {capturedPhotos.length + 1} of {MAX_PHOTOS}
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

              {/* â”€â”€ Photo count progress â”€â”€ */}
              <div style={{ fontSize: 14, color: "#475569", marginBottom: 12, fontWeight: 600 }}>
                {capturedPhotos.length === 0
                  ? "Take up to 3 photos: front label, size/weight label, price sign"
                  : capturedPhotos.length < MAX_PHOTOS
                  ? `${capturedPhotos.length} of ${MAX_PHOTOS} photos captured — keep going!`
                  : `All ${MAX_PHOTOS} photos captured`}
              </div>

              {/* â”€â”€ Captured photo thumbnails with remove buttons â”€â”€ */}
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

              {/* â”€â”€ Analyze button (shown after â‰¥1 photo) â”€â”€ */}
              {capturedPhotos.length > 0 && (
                <button
                  onClick={() => analyzeAllPhotos(selectedFiles)}
                  style={{ ...styles.confirmButton, width: "100%", minHeight: 56, fontSize: 17, fontWeight: 800, marginBottom: 10 }}
                  disabled={photoAnalysisStatus === 'uploading' || photoAnalysisStatus === 'analyzing' || processingRef.current}
                >
                  {photoAnalysisStatus === 'uploading'
                    ? "Uploading..."
                    : photoAnalysisStatus === 'analyzing'
                    ? "Analyzing with AI..."
                    : `? Analyze ${capturedPhotos.length} Photo${capturedPhotos.length > 1 ? "s" : ""} Now`}
                </button>
              )}

              {/* â”€â”€ Capture / Upload controls (shown when < MAX_PHOTOS) â”€â”€ */}
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
                      : `?? ${capturedPhotos.length === 0 ? "Take" : "Add"} Photo ${capturedPhotos.length + 1} of ${MAX_PHOTOS}: ${PHOTO_ROLE_SEQUENCE[capturedPhotos.length]?.label || "Additional photo"}`}
                  </button>

                  <button
                    type="button"
                    style={{ ...styles.libraryButton, marginBottom: 10 }}
                    onClick={() => {
                      document.getElementById("cameraInput")?.click();
                    }}
                  >
                    {capturedPhotos.length === 0
                      ? "Upload Photo 1 of 3: Product front label"
                      : `Upload Photo ${capturedPhotos.length + 1} of ${MAX_PHOTOS}: ${PHOTO_ROLE_SEQUENCE[capturedPhotos.length]?.label || "Additional photo"}`}
                  </button>
                  <input
                    id="cameraInput"
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handleImageUpload}
                    style={{ display: "none" }}
                  />
                </>
              )}

              <div style={styles.photoHelpText}>
                Suggested: Photo 1 = front label, Photo 2 = net weight/size, Photo 3 = price sign. Barcode is optional — add it after AI identifies the product.
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
            <div style={styles.statusChip}>
              <span style={styles.chipIcon}>??</span>
              {status}
            </div>
            {aiDebug?.data?.debug_version && (
              <div style={styles.methodChip}>
                <span style={styles.chipIcon}>??</span>
                AI Debug: {aiDebug.data.debug_version}
              </div>
            )}
            {aiDebug?.data?.product_name && (
              <div style={styles.confirmChip}>
                <span style={styles.chipIcon}>??</span>
                AI Product: {aiDebug.data.product_name}
              </div>
            )}
            {barcode && (
              <div style={styles.barcodeChip}>
                <span style={styles.chipIcon}>??</span>
                {barcode}
              </div>
            )}
            {submissionMethod && (
              <div style={styles.methodChip}>
                <span style={styles.chipIcon}>??</span>
                {submissionMethod}
              </div>
            )}
            {userPoints > 0 && (
              <div style={styles.pointsChip}>
                <span style={styles.chipIcon}>?</span>
                {userPoints} pts
              </div>
            )}
            {locationConfirmationCount > 0 && (
              <div style={styles.confirmChip}>
                <span style={styles.chipIcon}>?</span>
                {locationConfirmationCount} confirms
              </div>
            )}
            {locationConfidenceScore > 0 && (
              <div style={styles.confidenceChip}>
                <span style={styles.chipIcon}>??</span>
                {locationConfidenceScore}% confidence
              </div>
            )}
          </div>

          {product && !isCurrentProductInCart ? (
            <button
              onClick={() => handleAddToShoppingList(product)}
              style={{ ...styles.secondaryButton, width: "100%", marginTop: 12 }}
            >
              ?? Add to Shopping List
            </button>
          ) : null}

          {product && isCurrentProductInCart ? (
            <button
              onClick={handleRemoveProductFromCart}
              style={{ ...styles.secondaryButton, width: "100%", marginTop: 12 }}
            >
              Remove from Cart
            </button>
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
                        {correctionForm.brand ? (
                          <div style={styles.aiSummaryBrand}>{correctionForm.brand}</div>
                        ) : null}
                        <div style={styles.aiSummaryMeta}>Category: {summaryCategoryText}</div>
                        <div style={styles.aiSummaryMeta}>{summarySizeText}</div>
                        <div style={styles.aiSummaryMeta}>Qty: {summaryQuantityText}</div>
                        <div style={styles.aiSummaryPrice}>{summaryPriceText}</div>

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
                <div style={styles.inlineWarning}>Price skipped — add later</div>
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
                          • {Number(bestKnownLocation.price_count || 0)} {Number(bestKnownLocation.price_count || 0) === 1 ? "confirmation" : "confirmations"}
                          <br />
                          • {Number(bestKnownLocation.price_confidence || 0)}% confidence
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
                    No price data yet — be the first to add
                  </div>
                )}
              </div>

              <div style={styles.locationDetailsGrid}>
                <div style={styles.locationDetail}>
                  <div style={styles.locationDetailLabel}>Aisle</div>
                  <div style={styles.locationDetailValue}>{bestKnownLocation.aisle || "—"}</div>
                </div>
                <div style={styles.locationDetail}>
                  <div style={styles.locationDetailLabel}>Section</div>
                  <div style={styles.locationDetailValue}>{bestKnownLocation.section || "—"}</div>
                </div>
                <div style={styles.locationDetail}>
                  <div style={styles.locationDetailLabel}>Shelf</div>
                  <div style={styles.locationDetailValue}>{bestKnownLocation.shelf || "—"}</div>
                </div>
              </div>

              {bestKnownLocation.notes && (
                <div style={styles.locationNotesBox}>
                  <strong>Note:</strong> {bestKnownLocation.notes}
                </div>
              )}

              <div style={styles.locationMetaRow}>
                <div style={styles.locationMeta}>
                  <span style={styles.metaIcon}>?</span>
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

          </>
        )}

        <div style={styles.rewardsSection}>
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

      {activePanel === "location" && (
        <div style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          background: "#fff",
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          padding: 20,
          zIndex: 9999,
          boxShadow: "0 -4px 20px rgba(0,0,0,0.15)",
          maxHeight: "90vh",
          overflowY: "auto"
        }}>
          {renderLocationWizardStep()}

          <button
            type="button"
            onClick={() => setActivePanel(null)}
            style={{
              marginTop: 16,
              width: "100%",
              padding: 12,
              borderRadius: 12,
              background: "#e5e7eb",
              border: "none",
              fontWeight: 600
            }}
          >
            Close
          </button>
        </div>
      )}

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
              ? Item saved
            </h2>

            <p style={{ color: "#64748b", fontSize: 16, lineHeight: 1.5, marginBottom: 20 }}>
              Ready to scan the next product?
            </p>

            <button
              type="button"
              onClick={() => {
                setShowNextItemPrompt(false);

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
              Scan Next Item
            </button>

            <button
              type="button"
              onClick={() => {
                setShowNextItemPrompt(false);

                setProduct(null);
                setBarcode("");
                setBestKnownLocation(null);
                resetContributionFlow();

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
              Done for Now
            </button>
          </div>
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
// STYLES - All Inline Styles
// ============================================================================

const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)",
    color: "#1e293b",
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
  },
  cardLarge: {
    width: "90%",
    maxWidth: "400px",
    padding: "24px",
    borderRadius: "16px",
    background: "#fff",
    boxShadow: "0 4px 20px rgba(0,0,0,0.1)",
  },
  profileHeader: {
    display: "flex",
    justifyContent: "space-between",
    padding: "12px",
  },
  errorText: {
    fontSize: 13,
    color: "#dc2626",
    fontWeight: 700,
    marginBottom: 10,
  },
  headerMetaRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 10,
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
    padding: "6px 12px",
    fontSize: 13,
    fontWeight: 700,
  },
  progressPlaceholder: {
    display: "inline-flex",
    alignItems: "center",
    background: "#f8fafc",
    color: "#475569",
    border: "1px solid #e2e8f0",
    borderRadius: 999,
    padding: "6px 12px",
    fontSize: 13,
    fontWeight: 600,
  },
  title: {
    fontSize: 32,
    fontWeight: 800,
    marginBottom: 12,
    textAlign: "center",
    color: "#0f172a",
  },
  subtitle: {
    fontSize: 17,
    opacity: 0.8,
    marginBottom: 24,
    lineHeight: 1.5,
    textAlign: "center",
    color: "#475569",
  },
  card: {
    background: "#ffffff",
    borderRadius: 24,
    padding: 24,
    boxShadow: "0 8px 32px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)",
    border: "1px solid #f1f5f9",
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
    borderTop: "3px solid #3b82f6",
    borderLeft: "3px solid #3b82f6",
    borderTopLeftRadius: 12,
    zIndex: 10,
  },
  scannerCornerTopRight: {
    position: "absolute",
    top: 20,
    right: 20,
    width: 40,
    height: 40,
    borderTop: "3px solid #3b82f6",
    borderRight: "3px solid #3b82f6",
    borderTopRightRadius: 12,
    zIndex: 10,
  },
  scannerCornerBottomLeft: {
    position: "absolute",
    bottom: 20,
    left: 20,
    width: 40,
    height: 40,
    borderBottom: "3px solid #3b82f6",
    borderLeft: "3px solid #3b82f6",
    borderBottomLeftRadius: 12,
    zIndex: 10,
  },
  scannerCornerBottomRight: {
    position: "absolute",
    bottom: 20,
    right: 20,
    width: 40,
    height: 40,
    borderBottom: "3px solid #3b82f6",
    borderRight: "3px solid #3b82f6",
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
    boxShadow: "0 4px 20px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.8)",
    border: "2px solid #e2e8f0",
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
    background: "rgba(255,255,255,0.9)",
    color: "#334155",
    textAlign: "center",
    padding: "0 24px",
    backdropFilter: "blur(4px)",
  },
  overlayIcon: {
    fontSize: 56,
    marginBottom: 16,
    opacity: 0.7,
  },
  overlayText: {
    fontSize: 20,
    fontWeight: 600,
    marginBottom: 8,
    color: "#1e293b",
  },
  overlaySubtext: {
    fontSize: 16,
    opacity: 0.8,
    lineHeight: 1.4,
    color: "#64748b",
  },
  captureOverlay: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: 20,
    background: "rgba(255,255,255,0.95)",
    backdropFilter: "blur(12px)",
    border: "1px solid rgba(59, 130, 246, 0.2)",
    color: "#1e293b",
    padding: 20,
    borderRadius: 20,
    textAlign: "center",
    boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
  },
  captureIcon: {
    fontSize: 28,
    marginBottom: 12,
  },
  captureText: {
    fontSize: 18,
    fontWeight: 600,
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
    fontWeight: 700,
    background: "linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)",
    color: "#ffffff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 12,
    boxShadow: "0 4px 20px rgba(59, 130, 246, 0.3)",
    transition: "transform 0.2s ease, box-shadow 0.2s ease",
  },
  scanButtonIcon: {
    fontSize: 20,
  },
  stopButton: {
    minHeight: 64,
    padding: "0 36px",
    borderRadius: 32,
    border: "2px solid #dc2626",
    fontSize: 18,
    fontWeight: 700,
    background: "#dc2626",
    color: "#ffffff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 12,
    boxShadow: "0 4px 20px rgba(220, 38, 38, 0.3)",
    transition: "transform 0.2s ease, box-shadow 0.2s ease",
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
    minHeight: 56,
    borderRadius: 16,
    border: "2px solid #e2e8f0",
    fontSize: 16,
    fontWeight: 700,
    background: "#ffffff",
    color: "#475569",
    cursor: "pointer",
    transition: "all 0.2s ease",
    boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
  },
  confirmButton: {
    flex: 1,
    minHeight: 56,
    borderRadius: 16,
    border: "none",
    fontSize: 16,
    fontWeight: 700,
    background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
    color: "#ffffff",
    cursor: "pointer",
    transition: "transform 0.2s ease, box-shadow 0.2s ease",
    boxShadow: "0 4px 16px rgba(16, 185, 129, 0.2)",
  },
  editButton: {
    flex: 1,
    minHeight: 56,
    borderRadius: 16,
    border: "2px solid #e2e8f0",
    fontSize: 16,
    fontWeight: 700,
    background: "#f8fafc",
    color: "#64748b",
    cursor: "pointer",
    transition: "all 0.2s ease",
    boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
  },
  photoPromptBox: {
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
  },
  photoPromptText: {
    fontSize: 16,
    marginBottom: 12,
    color: "#374151",
  },
  photoButtonSolid: {
    width: "100%",
    minHeight: 56,
    borderRadius: 16,
    border: "none",
    fontSize: 16,
    fontWeight: 700,
    background: "linear-gradient(135deg, #f59e0b 0%, #d97706 100%)",
    color: "#ffffff",
    cursor: "pointer",
    marginBottom: 12,
    boxShadow: "0 4px 16px rgba(245, 158, 11, 0.2)",
  },
  libraryButton: {
    position: "relative",
    width: "100%",
    minHeight: 56,
    borderRadius: 16,
    border: "2px solid #e2e8f0",
    fontSize: 16,
    fontWeight: 700,
    background: "#ffffff",
    color: "#64748b",
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
    fontSize: 14,
    opacity: 0.8,
    lineHeight: 1.5,
    color: "#64748b",
  },
  fieldBlock: {
    marginBottom: 14,
  },
  label: {
    display: "block",
    marginBottom: 8,
    fontSize: 14,
    fontWeight: 600,
    color: "#334155",
  },
  stepLabel: {
    fontSize: 13,
    fontWeight: 800,
    color: "#2563eb",
    marginBottom: 8,
  },
  stepTitle: {
    fontSize: 24,
    fontWeight: 900,
    color: "#0f172a",
    marginBottom: 16,
  },
  select: {
    width: "100%",
    minHeight: 46,
    borderRadius: 14,
    border: "1px solid #d1d5db",
    background: "#ffffff",
    color: "#0f172a",
    padding: "12px 14px",
    fontSize: 15,
    boxShadow: "inset 0 1px 2px rgba(15, 23, 42, 0.06)",
  },
  input: {
    width: "100%",
    minHeight: 46,
    borderRadius: 14,
    border: "1px solid #d1d5db",
    background: "#ffffff",
    color: "#0f172a",
    padding: "12px 14px",
    fontSize: 15,
    marginBottom: 12,
    boxSizing: "border-box",
    boxShadow: "inset 0 1px 2px rgba(15, 23, 42, 0.06)",
  },
  textarea: {
    width: "100%",
    minHeight: 96,
    borderRadius: 14,
    border: "1px solid #d1d5db",
    background: "#ffffff",
    color: "#0f172a",
    padding: "12px 14px",
    fontSize: 15,
    marginBottom: 12,
    resize: "vertical",
    boxSizing: "border-box",
    boxShadow: "inset 0 1px 2px rgba(15, 23, 42, 0.06)",
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
    padding: "10px 12px",
    borderRadius: 999,
    border: "1px solid #dbe4ef",
    background: "#f8fafc",
    color: "#334155",
    fontSize: 13,
    fontWeight: 700,
  },
  quickAreaButtonActive: {
    background: "#2563eb",
    color: "#ffffff",
    border: "1px solid #2563eb",
  },
  quickButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 14,
    border: "1px solid #d1d5db",
    background: "#f8fafc",
    color: "#1f2937",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    padding: "0 12px",
  },
  quickButtonActive: {
    background: "#2563eb",
    color: "#ffffff",
    border: "1px solid #2563eb",
  },
  statusChips: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 20,
    alignItems: "center",
  },
  statusChip: {
    background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
    color: "#ffffff",
    padding: "10px 20px",
    borderRadius: 24,
    fontSize: 16,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    gap: 8,
    boxShadow: "0 4px 12px rgba(16, 185, 129, 0.25)",
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
    boxShadow: "0 1px 4px rgba(0,0,0,0.02)",
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
    boxShadow: "0 1px 4px rgba(0,0,0,0.02)",
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
    boxShadow: "0 4px 12px rgba(251, 191, 36, 0.3)",
    flex: "0 1 auto",
    minWidth: "fit-content",
  },
  confirmChip: {
    background: "#dbeafe",
    color: "#1e40af",
    padding: "8px 16px",
    borderRadius: 20,
    fontSize: 14,
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    gap: 6,
    boxShadow: "0 2px 8px rgba(59, 130, 246, 0.15)",
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
    boxShadow: "0 1px 4px rgba(0,0,0,0.02)",
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
    fontSize: 15,
    boxShadow: "0 2px 8px rgba(220, 38, 38, 0.1)",
  },
  successBox: {
    background: "#f0fdf4",
    border: "1px solid #bbf7d0",
    color: "#166534",
    padding: 16,
    borderRadius: 16,
    marginTop: 16,
    fontSize: 15,
    boxShadow: "0 2px 8px rgba(22, 163, 74, 0.1)",
  },
  infoBox: {
    background: "#eff6ff",
    border: "1px solid #bfdbfe",
    color: "#1e40af",
    borderRadius: 16,
    padding: 12,
    marginBottom: 16,
    fontWeight: 700,
  },
  priceSourceBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    border: "1px solid #cbd5e1",
    borderRadius: 999,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 700,
    marginBottom: 10,
  },
  aiPriceConfirmationCard: {
    border: "1px solid #bfdbfe",
    background: "#eff6ff",
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
  },
  aiPriceConfirmationTitle: {
    fontSize: 15,
    fontWeight: 800,
    color: "#1e3a8a",
    marginBottom: 10,
  },
  aiPriceConfirmedBar: {
    border: "1px solid #86efac",
    background: "#dcfce7",
    color: "#166534",
    borderRadius: 12,
    padding: "8px 10px",
    fontSize: 13,
    fontWeight: 700,
    marginBottom: 10,
  },
  aiSummaryCard: {
    border: "1px solid #cbd5e1",
    background: "#ffffff",
    borderRadius: 16,
    padding: 16,
    boxShadow: "0 6px 18px rgba(15, 23, 42, 0.08)",
  },
  aiSummaryImageWrap: {
    width: "100%",
    height: 180,
    borderRadius: 12,
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
    color: "#64748b",
    fontSize: 14,
    fontWeight: 600,
  },
  aiSummaryName: {
    fontSize: 24,
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
    fontSize: 16,
    color: "#334155",
    marginBottom: 3,
    fontWeight: 700,
  },
  aiSummaryPrice: {
    fontSize: 22,
    color: "#0f172a",
    marginTop: 4,
    marginBottom: 8,
    fontWeight: 900,
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
    color: "#1e40af",
    marginBottom: 10,
    fontWeight: 700,
  },
  inlineWarning: {
    border: "1px solid #fcd34d",
    background: "#fef3c7",
    color: "#92400e",
    borderRadius: 10,
    padding: "8px 10px",
    fontSize: 12,
    fontWeight: 700,
    marginBottom: 10,
  },
  bestKnownLocationCard: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: 20,
    padding: 20,
    marginBottom: 20,
    boxShadow: "0 4px 20px rgba(0,0,0,0.08)",
  },
  debugBox: {
    background: "#f8fafc",
    border: "1px solid #cbd5e1",
    color: "#334155",
    padding: 16,
    borderRadius: 16,
    marginBottom: 16,
    boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
  },
  debugTitle: {
    fontSize: 14,
    fontWeight: 700,
    marginBottom: 8,
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
    border: "1px solid #e2e8f0",
    borderRadius: 20,
    padding: 24,
    boxShadow: "0 4px 20px rgba(0,0,0,0.08)",
    marginBottom: 20,
  },
  productHeader: {
    fontSize: 16,
    opacity: 0.9,
    marginBottom: 20,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    display: "flex",
    alignItems: "center",
    gap: 10,
    color: "#374151",
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
    fontSize: 16,
    opacity: 0.8,
  },
  productDetails: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  productName: {
    fontSize: 26,
    fontWeight: 800,
    margin: 0,
    lineHeight: 1.2,
    color: "#0f172a",
  },
  productMeta: {
    fontSize: 16,
    opacity: 0.9,
    margin: 0,
    display: "flex",
    alignItems: "center",
    gap: 10,
    color: "#475569",
  },
  metaLabel: {
    fontWeight: 600,
    color: "#64748b",
    minWidth: 65,
  },
  barcodeCode: {
    background: "#f1f5f9",
    padding: "4px 8px",
    borderRadius: 6,
    fontFamily: "monospace",
    fontSize: 14,
    color: "#3b82f6",
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
    border: "1.5px solid #cbd5e1",
    fontSize: 15,
    fontWeight: 600,
    background: "#f8fafc",
    color: "#334155",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    transition: "all 0.25s ease",
  },
  sectionBox: {
    marginTop: 12,
    padding: 20,
    background: "#ffffff",
    borderRadius: 16,
    border: "1px solid #e2e8f0",
    boxShadow: "0 4px 16px rgba(15, 23, 42, 0.06)",
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 700,
    marginBottom: 16,
    color: "#0f172a",
  },
  panelTitle: {
    fontSize: 22,
    fontWeight: 800,
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
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 18,
    padding: 16,
    textAlign: "left",
    lineHeight: 1.8,
  },
  rewardsSection: {
    background: "#ffffff",
    borderRadius: 24,
    padding: 20,
    marginTop: 14,
    boxShadow: "0 8px 32px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)",
    border: "1px solid #f1f5f9",
  },
  rewardsSectionHeader: {
    fontSize: 18,
    fontWeight: 700,
    marginBottom: 12,
    color: "#0f172a",
  },
  rewardsGrid: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  rewardCard: {
    border: "1px solid #e2e8f0",
    borderRadius: 14,
    padding: 12,
    background: "#ffffff",
    boxShadow: "0 2px 10px rgba(15, 23, 42, 0.04)",
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
    padding: "5px 10px",
    fontSize: 13,
    fontWeight: 700,
    color: "#92400e",
    background: "linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)",
    border: "1px solid #fcd34d",
  },
  rewardEmptyState: {
    fontSize: 14,
    color: "#64748b",
  },
  closeButton: {
    background: "none",
    border: "none",
    color: "#64748b",
    fontSize: 20,
    cursor: "pointer",
    padding: 0,
    width: 28,
    height: 28,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    transition: "background 0.2s ease",
  },
  toast: {
    position: "fixed",
    bottom: 24,
    left: "50%",
    transform: "translateX(-50%) translateY(0)",
    background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
    color: "#ffffff",
    padding: "16px 24px",
    borderRadius: 28,
    fontSize: 15,
    fontWeight: 600,
    boxShadow: "0 8px 32px rgba(16, 185, 129, 0.3)",
    zIndex: 1000,
    border: "1px solid rgba(255,255,255,0.2)",
    opacity: 1,
    transition: "all 0.4s cubic-bezier(0.32, 0.72, 0, 1)",
  },
  locationCardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 18,
    gap: 12,
  },
  locationCardTitle: {
    fontSize: 20,
    fontWeight: 700,
    color: "#0f172a",
    marginBottom: 4,
  },
  locationCardSubtitle: {
    fontSize: 14,
    color: "#64748b",
    fontWeight: 500,
  },
  confidenceBadge: {
    background: "linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)",
    color: "#78350f",
    padding: "8px 16px",
    borderRadius: 20,
    fontSize: 16,
    fontWeight: 700,
    whiteSpace: "nowrap",
    boxShadow: "0 2px 8px rgba(251, 191, 36, 0.2)",
  },
  locationDetailsGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: 12,
    marginBottom: 16,
    padding: "12px",
    background: "#f8fafc",
    borderRadius: 12,
    border: "1px solid #e2e8f0",
  },
  locationDetail: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  locationDetailLabel: {
    fontSize: 12,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "#94a3b8",
  },
  locationDetailValue: {
    fontSize: 18,
    fontWeight: 700,
    color: "#0f172a",
  },
  locationNotesBox: {
    background: "#fef9e7",
    border: "1px solid #fde047",
    padding: 12,
    borderRadius: 10,
    fontSize: 14,
    color: "#713f12",
    marginBottom: 12,
    lineHeight: 1.4,
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
    color: "#16a34a",
  },
  metaText: {
    fontSize: 13,
  },
  primaryButton: {
    flex: 1,
    minHeight: 52,
    background: "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)",
    color: "#ffffff",
    border: "1px solid #1d4ed8",
    borderRadius: 14,
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    transition: "all 0.25s ease",
    boxShadow: "0 4px 12px rgba(37, 99, 235, 0.2)",
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
    background: "linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%)",
    color: "#0369a1",
    border: "1px solid #7dd3fc",
    borderRadius: 999,
    padding: "8px 16px",
    fontSize: 14,
    fontWeight: 700,
  },
  changeStoreButton: {
    background: "none",
    border: "1px solid #cbd5e1",
    borderRadius: 999,
    color: "#475569",
    fontSize: 13,
    fontWeight: 600,
    padding: "6px 14px",
    cursor: "pointer",
  },
  storeOptionButton: {
    width: "100%",
    minHeight: 52,
    borderRadius: 14,
    border: "1px solid #e2e8f0",
    background: "#f8fafc",
    color: "#1e293b",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    padding: "0 16px",
    gap: 6,
    textAlign: "left",
    boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
  },
  suggestedStoreCard: {
    background: "linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)",
    border: "1px solid #93c5fd",
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    boxShadow: "0 2px 8px rgba(59, 130, 246, 0.1)",
  },
  suggestedStoreTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: "#1e40af",
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
    background: "#f8fafc",
    borderColor: "#93c5fd",
    color: "#334155",
  },
  editInlineButton: {
    minHeight: 34,
    borderRadius: 10,
    border: "1px solid #93c5fd",
    background: "#eff6ff",
    color: "#1d4ed8",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    padding: "0 10px",
    marginBottom: 10,
  },
};



