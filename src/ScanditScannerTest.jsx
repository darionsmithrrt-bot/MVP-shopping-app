import { useCallback, useEffect, useRef, useState } from "react";
import {
  DataCaptureContext,
} from "@scandit/web-datacapture-core";
import {
  SparkScan,
  SparkScanSettings,
  SparkScanView,
  SparkScanViewSettings,
  Symbology,
  barcodeCaptureLoader,
} from "@scandit/web-datacapture-barcode";

const sdkLibraryLocation =
  "https://cdn.jsdelivr.net/npm/@scandit/web-datacapture-barcode@8.3.1/sdc-lib/";

function ScanditScannerTest({ onClose }) {
  const scannerRootRef = useRef(null);
  const contextRef = useRef(null);
  const sparkScanRef = useRef(null);
  const sparkScanViewRef = useRef(null);
  const listenerRef = useRef(null);
  const hasScannedRef = useRef(false);

  const [status, setStatus] = useState("idle");
  const [scanValue, setScanValue] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const licenseKey = String(import.meta.env.VITE_SCANDIT_LICENSE_KEY || "").trim();

  useEffect(() => {
    const setViewportHeight = () => {
      document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
    };

    setViewportHeight();
    window.addEventListener("resize", setViewportHeight);
    window.addEventListener("orientationchange", setViewportHeight);

    return () => {
      window.removeEventListener("resize", setViewportHeight);
      window.removeEventListener("orientationchange", setViewportHeight);
    };
  }, []);

  const teardownScanner = useCallback(async () => {
    setStatus("stopping");

    try {
      const sparkScan = sparkScanRef.current;
      const listener = listenerRef.current;
      if (sparkScan && listener) {
        sparkScan.removeListener(listener);
      }

      const sparkScanView = sparkScanViewRef.current;
      if (sparkScanView) {
        try {
          await sparkScanView.stopScanning();
        } catch {
          // Best-effort shutdown.
        }
      }

      const context = contextRef.current;
      if (context) {
        try {
          await context.dispose();
        } catch {
          // Best-effort cleanup.
        }
      }

      if (scannerRootRef.current) {
        scannerRootRef.current.innerHTML = "";
      }
    } finally {
      contextRef.current = null;
      sparkScanRef.current = null;
      sparkScanViewRef.current = null;
      listenerRef.current = null;
      hasScannedRef.current = false;
      setStatus("stopped");
    }
  }, []);

  const handleRescan = useCallback(async () => {
    setErrorMessage("");
    setScanValue("");
    hasScannedRef.current = false;

    const sparkScanView = sparkScanViewRef.current;
    if (!sparkScanView) {
      setErrorMessage("Scanner is not ready. Close and reopen scanner test.");
      return;
    }

    try {
      await sparkScanView.startScanning();
      setStatus("scanning");
    } catch (err) {
      setStatus("error");
      setErrorMessage(String(err?.message || "Unable to restart scanning."));
    }
  }, []);

  const handleClose = useCallback(async () => {
    await teardownScanner();
    if (typeof onClose === "function") {
      onClose();
    }
  }, [onClose, teardownScanner]);

  useEffect(() => {
    let isMounted = true;

    const initScanner = async () => {
      if (!licenseKey) {
        setStatus("error");
        setErrorMessage(
          "Scandit license key is missing. Add VITE_SCANDIT_LICENSE_KEY in the root .env file and reload the app."
        );
        return;
      }

      if (!scannerRootRef.current) {
        setStatus("error");
        setErrorMessage("Scanner container is unavailable.");
        return;
      }

      setStatus("initializing");
      setErrorMessage("");

      try {
        const context = await DataCaptureContext.forLicenseKey(licenseKey, {
          libraryLocation: sdkLibraryLocation,
          moduleLoaders: [barcodeCaptureLoader({ libraryLocation: sdkLibraryLocation })],
        });
        console.info("SCANDIT_STEP_CONTEXT_CREATED");

        const sparkScanSettings = new SparkScanSettings();
        sparkScanSettings.enableSymbologies([
          Symbology.EAN13UPCA,
          Symbology.UPCE,
          Symbology.EAN8,
          Symbology.Code128,
        ]);
        console.info("SCANDIT_RETAIL_SYMBOLOGIES_ENABLED", {
          symbologies: ["EAN13UPCA", "UPCE", "EAN8", "Code128"],
        });

        const sparkScan = SparkScan.forSettings(sparkScanSettings);
        console.info("SCANDIT_STEP_SPARKSCAN_CREATED");

        const listener = {
          didScan: async (_mode, session) => {
            if (hasScannedRef.current) return;

            const recognized = session?.newlyRecognizedBarcodes || [];
            if (!recognized.length) return;

            const scannedData = String(recognized[0]?.data || "").trim();
            if (!scannedData) return;

            console.info("SCANDIT_BARCODE_RESULT", { barcode: scannedData });

            hasScannedRef.current = true;
            if (isMounted) {
              setScanValue(scannedData);
              setStatus("scanned");
            }
          },
        };

        sparkScan.addListener(listener);

        const sparkScanViewSettings = new SparkScanViewSettings();
        const sparkScanView = SparkScanView.forElement(
          scannerRootRef.current,
          context,
          sparkScan,
          sparkScanViewSettings
        );
        console.info("SCANDIT_STEP_VIEW_CONNECTED", {
          hasScannerRoot: Boolean(scannerRootRef.current),
        });

        await sparkScanView.prepareScanning();
        console.info("SCANDIT_STEP_CAMERA_ON");

        contextRef.current = context;
        sparkScanRef.current = sparkScan;
        sparkScanViewRef.current = sparkScanView;
        listenerRef.current = listener;

        if (isMounted) {
          setStatus("scanning");
        }
        console.info("SCANDIT_SCAN_READY");
      } catch (err) {
        if (isMounted) {
          setStatus("error");
          setErrorMessage(String(err?.message || "Failed to initialize SparkScan."));
        }
      }
    };

    initScanner();

    return () => {
      isMounted = false;
      teardownScanner();
    };
  }, [licenseKey, teardownScanner]);

  return (
    <section style={styles.sheet} aria-label="Scandit scanner test">
      <div id="scandit-root" ref={scannerRootRef} style={styles.scannerRoot} />

      <div style={styles.overlayTop}>
        <h2 style={styles.title}>Scandit Scanner Test</h2>
        <div style={styles.diagnosticBadge}>SPARKSCAN BUILD 5 - SDK 8.3.1</div>
        {errorMessage ? (
          <div style={styles.errorBox} role="alert">
            {errorMessage}
          </div>
        ) : null}
      </div>

      <div style={styles.scanGuideZone} aria-hidden="true">
        <div style={styles.scanGuideBox} />
        <div style={styles.scanGuideText}>
          Center barcode in box • Hold 6-12 inches away • Avoid glare
        </div>
      </div>

      <div style={styles.resultBox}>
        <div style={styles.label}>Last scanned barcode</div>
        <div style={styles.value}>{scanValue || "No scan yet"}</div>
        <div style={styles.status}>Status: {status}</div>
      </div>

      <div style={styles.actions}>
        <button type="button" style={styles.primaryButton} onClick={handleRescan}>
          Rescan
        </button>
        <button type="button" style={styles.secondaryButton} onClick={handleClose}>
          Close Scanner
        </button>
        <button type="button" style={styles.tertiaryButton}>
          Enter Barcode Manually
        </button>
        <button type="button" style={styles.quaternaryButton} disabled aria-disabled="true">
          More barcode types
        </button>
      </div>
    </section>
  );
}

const styles = {
  sheet: {
    position: "fixed",
    inset: 0,
    width: "100vw",
    height: "var(--app-height)",
    background: "black",
    zIndex: 999999,
    overflow: "hidden",
    touchAction: "none",
    WebkitOverflowScrolling: "touch",
    transform: "translateZ(0)",
    color: "#f8fbff",
  },
  scannerRoot: {
    position: "fixed",
    inset: 0,
    width: "100vw",
    height: "var(--app-height)",
    background: "black",
    zIndex: 999999,
    overflow: "hidden",
    touchAction: "none",
    WebkitOverflowScrolling: "touch",
    transform: "translateZ(0)",
  },
  overlayTop: {
    position: "fixed",
    top: "max(8px, env(safe-area-inset-top))",
    left: "12px",
    right: "12px",
    zIndex: 1000000,
    pointerEvents: "none",
  },
  title: {
    margin: 0,
    fontSize: "1rem",
    fontWeight: 700,
    lineHeight: 1.2,
    textShadow: "0 1px 2px rgba(0,0,0,0.8)",
  },
  diagnosticBadge: {
    marginTop: "8px",
    display: "inline-block",
    padding: "4px 8px",
    borderRadius: "8px",
    background: "rgba(255,255,255,0.16)",
    border: "1px solid rgba(255,255,255,0.35)",
    fontSize: "0.75rem",
    fontWeight: 700,
    letterSpacing: "0.02em",
    textShadow: "none",
    pointerEvents: "none",
  },
  errorBox: {
    marginTop: "8px",
    borderRadius: "12px",
    padding: "10px 12px",
    background: "#592525",
    border: "1px solid #f06a6a",
    fontSize: "0.92rem",
    lineHeight: 1.35,
    pointerEvents: "auto",
  },
  scanGuideZone: {
    position: "fixed",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    zIndex: 1000000,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "10px",
    pointerEvents: "none",
  },
  scanGuideBox: {
    width: "min(82vw, 360px)",
    height: "90px",
    borderRadius: "14px",
    border: "2px solid rgba(255,255,255,0.9)",
    boxShadow: "0 0 0 9999px rgba(0,0,0,0.2)",
    background: "transparent",
  },
  scanGuideText: {
    maxWidth: "min(92vw, 520px)",
    padding: "6px 10px",
    borderRadius: "10px",
    background: "rgba(0,0,0,0.55)",
    border: "1px solid rgba(255,255,255,0.2)",
    fontSize: "0.82rem",
    lineHeight: 1.35,
    textAlign: "center",
    fontWeight: 600,
    color: "#f8fbff",
  },
  resultBox: {
    position: "fixed",
    left: "12px",
    right: "12px",
    bottom: "182px",
    zIndex: 1000000,
    borderRadius: "12px",
    padding: "12px",
    background: "rgba(0,0,0,0.55)",
    border: "1px solid rgba(255,255,255,0.2)",
  },
  label: {
    fontSize: "0.78rem",
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    opacity: 0.8,
    marginBottom: "4px",
  },
  value: {
    fontSize: "1.05rem",
    lineHeight: 1.35,
    fontWeight: 700,
    wordBreak: "break-all",
  },
  status: {
    marginTop: "8px",
    fontSize: "0.9rem",
    opacity: 0.88,
  },
  actions: {
    position: "fixed",
    left: "12px",
    right: "12px",
    bottom: "max(8px, env(safe-area-inset-bottom))",
    zIndex: 1000000,
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: "10px",
  },
  primaryButton: {
    width: "100%",
    minHeight: "52px",
    borderRadius: "12px",
    border: "none",
    background: "#2ecc71",
    color: "#07210f",
    fontSize: "1rem",
    fontWeight: 800,
  },
  secondaryButton: {
    width: "100%",
    minHeight: "52px",
    borderRadius: "12px",
    border: "1px solid rgba(255,255,255,0.28)",
    background: "rgba(255,255,255,0.08)",
    color: "#f8fbff",
    fontSize: "1rem",
    fontWeight: 700,
  },
  tertiaryButton: {
    width: "100%",
    minHeight: "48px",
    borderRadius: "12px",
    border: "1px dashed rgba(255,255,255,0.5)",
    background: "rgba(0,0,0,0.45)",
    color: "#f8fbff",
    fontSize: "0.95rem",
    fontWeight: 700,
  },
  quaternaryButton: {
    width: "100%",
    minHeight: "46px",
    borderRadius: "12px",
    border: "1px dashed rgba(255,255,255,0.35)",
    background: "rgba(255,255,255,0.05)",
    color: "rgba(248,251,255,0.85)",
    fontSize: "0.92rem",
    fontWeight: 600,
    cursor: "not-allowed",
    opacity: 0.8,
  },
};

export default ScanditScannerTest;
