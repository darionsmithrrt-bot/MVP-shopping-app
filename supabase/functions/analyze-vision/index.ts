import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type VisionAnalysisResult = {
  text: string;
  labels: Array<{ description: string; confidence: number }>;
  logos: Array<{ description: string; confidence: number }>;
  objects: Array<{ name: string; confidence: number }>;
  raw_text_blocks: string[];
  confidence: number;
  error?: string;
};

const SAFE_FALLBACK: VisionAnalysisResult = {
  text: "",
  labels: [],
  logos: [],
  objects: [],
  raw_text_blocks: [],
  confidence: 0,
};

type GoogleVisionResponse = {
  responses: Array<{
    textAnnotations?: Array<{ description: string; boundingPoly?: Record<string, unknown> }>;
    labelAnnotations?: Array<{ description: string; score: number }>;
    logoAnnotations?: Array<{ description: string; score: number }>;
    localizedObjectAnnotations?: Array<{ name: string; score: number }>;
    error?: { code: number; message: string };
  }>;
};

const logEnvVars = () => {
  const debugInfo = {
    has_google_cloud_vision_api_key: !!Deno.env.get("GOOGLE_CLOUD_VISION_API_KEY"),
    has_google_api_key: !!Deno.env.get("GOOGLE_API_KEY"),
    has_anthropic_api_key: !!Deno.env.get("ANTHROPIC_API_KEY"),
    version: "analyze-vision-v1",
  };
  console.log("ANALYZE_VISION ENV CHECK:", debugInfo);
  return debugInfo;
};

const analyzeWithGoogleVision = async (imageUrl: string): Promise<VisionAnalysisResult> => {
  const apiKey = Deno.env.get("GOOGLE_CLOUD_VISION_API_KEY") || Deno.env.get("GOOGLE_API_KEY");

  if (!apiKey) {
    console.warn("ANALYZE_VISION: No Google Cloud Vision API key configured");
    return SAFE_FALLBACK;
  }

  try {
    console.log("ANALYZE_VISION: Calling Google Cloud Vision API");
    
    const requestBody = {
      requests: [
        {
          image: { source: { imageUri: imageUrl } },
          features: [
            { type: "TEXT_DETECTION", maxResults: 10 },
            { type: "LABEL_DETECTION", maxResults: 10 },
            { type: "LOGO_DETECTION", maxResults: 5 },
            { type: "OBJECT_LOCALIZATION", maxResults: 10 },
          ],
        },
      ],
    };

    const response = await fetch("https://vision.googleapis.com/v1/images:annotate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("ANALYZE_VISION Google API error:", response.status, errorBody);
      return SAFE_FALLBACK;
    }

    const visionData: GoogleVisionResponse = await response.json();
    const result = visionData.responses?.[0];

    if (!result) {
      console.warn("ANALYZE_VISION: Empty response from Google Vision API");
      return SAFE_FALLBACK;
    }

    if (result.error) {
      console.warn("ANALYZE_VISION API returned error:", result.error);
      return SAFE_FALLBACK;
    }

    // Extract text (first annotation is the full text)
    const textAnnotations = result.textAnnotations || [];
    const fullText = textAnnotations.length > 0 ? textAnnotations[0].description || "" : "";

    // Extract all text blocks (skip the first one which is the full text)
    const textBlocks = textAnnotations.slice(1).map((ann) => ann.description || "").filter(Boolean);

    // Extract labels (general objects/concepts)
    const labels = (result.labelAnnotations || []).map((label) => ({
      description: label.description || "unknown",
      confidence: Number(label.score || 0),
    }));

    // Extract logos (brand/company logos)
    const logos = (result.logoAnnotations || []).map((logo) => ({
      description: logo.description || "unknown",
      confidence: Number(logo.score || 0),
    }));

    // Extract objects (localized objects)
    const objects = (result.localizedObjectAnnotations || []).map((obj) => ({
      name: obj.name || "unknown",
      confidence: Number(obj.score || 0),
    }));

    // Calculate overall confidence based on availability of results
    const resultCount = textAnnotations.length + labels.length + logos.length + objects.length;
    const confidence = resultCount > 0 ? Math.min(0.95, 0.3 + (resultCount * 0.1)) : 0;

    const analysisResult: VisionAnalysisResult = {
      text: fullText,
      labels: labels.slice(0, 10),
      logos: logos.slice(0, 5),
      objects: objects.slice(0, 10),
      raw_text_blocks: textBlocks.slice(0, 20),
      confidence,
    };

    console.log("ANALYZE_VISION SUCCESS:", {
      textLength: analysisResult.text.length,
      labelCount: analysisResult.labels.length,
      logoCount: analysisResult.logos.length,
      objectCount: analysisResult.objects.length,
      confidence: analysisResult.confidence,
    });

    return analysisResult;
  } catch (error) {
    console.error("ANALYZE_VISION exception:", error instanceof Error ? error.message : String(error));
    return SAFE_FALLBACK;
  }
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    logEnvVars();

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Malformed request body" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const imageUrl = typeof body?.imageUrl === "string" ? body.imageUrl.trim() : "";
    const role = typeof body?.role === "string" ? body.role.trim() : "unknown";

    if (!imageUrl) {
      console.warn("ANALYZE_VISION: No imageUrl provided");
      return new Response(JSON.stringify({ ...SAFE_FALLBACK, error: "No imageUrl provided" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isValidUrl = /^https?:\/\/.+/.test(imageUrl);
    if (!isValidUrl) {
      console.warn("ANALYZE_VISION: Invalid image URL format", imageUrl);
      return new Response(JSON.stringify({ ...SAFE_FALLBACK, error: "Invalid image URL" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("ANALYZE_VISION RECEIVED:", { role, urlLength: imageUrl.length });

    const analysisResult = await analyzeWithGoogleVision(imageUrl);

    return new Response(JSON.stringify({ ...analysisResult, role }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("ANALYZE_VISION handler exception:", error instanceof Error ? error.message : String(error));
    return new Response(JSON.stringify({ ...SAFE_FALLBACK, error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
