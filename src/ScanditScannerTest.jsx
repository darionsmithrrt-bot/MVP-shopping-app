import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  CameraPosition,
  DataCaptureContext,
  DataCaptureView,
  FrameSourceState,
} from "@scandit/web-datacapture-core";
import {
  BarcodeCapture,
  BarcodeCaptureSettings,
  Symbology,
  barcodeCaptureLoader,
} from "@scandit/web-datacapture-barcode";

const sdkLibraryLocation =
  "https://cdn.jsdelivr.net/npm/@scandit/web-datacapture-barcode@8.3.1/sdc-lib/";

function ScanditScannerTest({ onClose }) {
  const scannerRootRef = useRef(null);
  const contextRef = useRef(null);
  const barcodeCaptureRef = useRef(null);
  const dataCaptureViewRef = useRef(null);
  const cameraRef = useRef(null);
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
      const barcodeCapture = barcodeCaptureRef.current;
      const listener = listenerRef.current;
      if (barcodeCapture && listener) {
        barcodeCapture.removeListener(listener);
      }
      if (barcodeCapture) {
        try {
          await barcodeCapture.setEnabled(false);
        } catch {
          // Best-effort disable.
        }
      }

      const dataCaptureView = dataCaptureViewRef.current;
      if (dataCaptureView) {
        try {
          dataCaptureView.dispose();
        } catch {
          // Best-effort cleanup.
        }
      }

      const camera = cameraRef.current;
      if (camera) {
        try {
          await camera.switchToDesiredState(FrameSourceState.Off);
        } catch {
          // Best-effort shutdown.
        }
      }

      const context = contextRef.current;
      if (context) {
        try {
          await context.setFrameSource(null);
        } catch {
          // Ignore if already detached.
        }
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
      barcodeCaptureRef.current = null;
      dataCaptureViewRef.current = null;
      cameraRef.current = null;
      listenerRef.current = null;
      hasScannedRef.current = false;
      setStatus("stopped");
    }
  }, []);

  const handleRescan = useCallback(async () => {
    setErrorMessage("");
    setScanValue("");
    hasScannedRef.current = false;

    const barcodeCapture = barcodeCaptureRef.current;
    if (!barcodeCapture) {
      setErrorMessage("Scanner is not ready. Close and reopen scanner test.");
      return;
    }

    try {
      await barcodeCapture.setEnabled(true);
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

        const barcodeCaptureSettings = new BarcodeCaptureSettings();
        barcodeCaptureSettings.enableSymbologies([
          Symbology.EAN13UPCA,
          Symbology.Code128,
          Symbology.QR,
        ]);

        const barcodeCapture = await BarcodeCapture.forContext(context, barcodeCaptureSettings);

        const listener = {
          didCapture: async (_mode, session) => {
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

            try {
              await barcodeCapture.setEnabled(false);
            } catch {
              // Ignore if already paused.
            }
          },
        };

        barcodeCapture.addListener(listener);

        const camera = Camera.pickBestGuessForPosition(CameraPosition.WorldFacing);
        await context.setFrameSource(camera);
        await camera.switchToDesiredState(FrameSourceState.On);

        console.info("SCANDIT_VIEW_CREATED", {
          hasScannerRoot: Boolean(scannerRootRef.current),
        });

        let dataCaptureView;
        try {
          dataCaptureView = await DataCaptureView.forContext(context);
          dataCaptureView.connectToElement(scannerRootRef.current);
          console.info("SCANDIT_VIEW_ATTACHED", {
            attachedTo: "scandit-root",
          });
        } catch (attachError) {
          console.error("SCANDIT_VIEW_ATTACH_FAILED", {
            message: String(attachError?.message || attachError),
          });
          throw attachError;
        }

        if (dataCaptureView.element) {
          dataCaptureView.element.style.width = "100vw";
          dataCaptureView.element.style.height = "100dvh";
          dataCaptureView.element.style.position = "fixed";
          dataCaptureView.element.style.inset = "0";
        }

        await new Promise((resolve) => window.setTimeout(resolve, 250));
        if (dataCaptureView.element) {
          dataCaptureView.element.style.width = "100vw";
          dataCaptureView.element.style.height = "100dvh";
        }

        const containerRect = scannerRootRef.current.getBoundingClientRect();
        const viewRect = dataCaptureView.element
          ? dataCaptureView.element.getBoundingClientRect()
          : null;

        console.info("SCANDIT_INIT_SUCCESS", { mountedTo: "scandit-root" });
        console.info("SCANDIT_DIAGNOSTICS", {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          orientationType: window.screen?.orientation?.type || "unknown",
          scannerContainerBounds: {
            left: Math.round(containerRect.left),
            top: Math.round(containerRect.top),
            right: Math.round(containerRect.right),
            bottom: Math.round(containerRect.bottom),
            width: Math.round(containerRect.width),
            height: Math.round(containerRect.height),
          },
          viewElementBounds: viewRect
            ? {
                left: Math.round(viewRect.left),
                top: Math.round(viewRect.top),
                right: Math.round(viewRect.right),
                bottom: Math.round(viewRect.bottom),
                width: Math.round(viewRect.width),
                height: Math.round(viewRect.height),
              }
            : null,
        });

        contextRef.current = context;
        barcodeCaptureRef.current = barcodeCapture;
        dataCaptureViewRef.current = dataCaptureView;
        cameraRef.current = camera;
        listenerRef.current = listener;

        if (isMounted) {
          setStatus("scanning");
        }
      } catch (err) {
        if (isMounted) {
          setStatus("error");
          setErrorMessage(String(err?.message || "Failed to initialize BarcodeCapture."));
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
        {errorMessage ? (
          <div style={styles.errorBox} role="alert">
            {errorMessage}
          </div>
        ) : null}
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
    border: "2px solid red",
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
  resultBox: {
    position: "fixed",
    left: "12px",
    right: "12px",
    bottom: "152px",
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
};

export default ScanditScannerTest;
