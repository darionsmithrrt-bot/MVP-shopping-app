import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  CameraPosition,
  DataCaptureContext,
  DataCaptureView,
  FrameSourceState,
} from "@scandit/web-datacapture-core";
import {
  Symbology,
  BarcodeCapture,
  BarcodeCaptureSettings,
  barcodeCaptureLoader,
} from "@scandit/web-datacapture-barcode";

function ScanditScannerTest({ onClose }) {
  const scannerContainerRef = useRef(null);
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

  const teardownScanner = useCallback(async () => {
    setStatus("stopping");

    try {
      const barcodeCapture = barcodeCaptureRef.current;
      if (barcodeCapture && listenerRef.current) {
        barcodeCapture.removeListener(listenerRef.current);
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
          // Best-effort view cleanup.
        }
      }

      const camera = cameraRef.current;
      if (camera) {
        try {
          await camera.switchToDesiredState(FrameSourceState.Off);
        } catch {
          // Best-effort camera shutdown.
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
          // Best-effort context cleanup.
        }
      }

      if (scannerContainerRef.current) {
        scannerContainerRef.current.innerHTML = "";
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

      if (!scannerContainerRef.current) {
        setStatus("error");
        setErrorMessage("Scanner container is unavailable.");
        return;
      }

      const hostRect = scannerContainerRef.current.getBoundingClientRect();
      console.info("SCANDIT_CONTAINER_DIMENSIONS", {
        width: Math.round(hostRect.width),
        height: Math.round(hostRect.height),
      });

      setStatus("initializing");
      setErrorMessage("");

      try {
        const context = await DataCaptureContext.forLicenseKey(licenseKey, {
          libraryLocation:
            "https://cdn.jsdelivr.net/npm/@scandit/web-datacapture-barcode@8.3.1/sdc-lib/",
          moduleLoaders: [
            barcodeCaptureLoader({
              libraryLocation:
                "https://cdn.jsdelivr.net/npm/@scandit/web-datacapture-barcode@8.3.1/sdc-lib/",
            }),
          ],
        });

        const barcodeCaptureSettings = new BarcodeCaptureSettings();
        barcodeCaptureSettings.enableSymbologies([
          Symbology.EAN13UPCA,
          Symbology.Code128,
          Symbology.QR,
        ]);

        const barcodeCapture = BarcodeCapture.forSettings(barcodeCaptureSettings);

        const listener = {
          didCapture: async (_mode, session) => {
            const newlyRecognized = session?.newlyRecognizedBarcodes || [];
            if (!newlyRecognized.length || hasScannedRef.current) return;

            const barcode = newlyRecognized[0];
            const scannedData = String(barcode?.data || "").trim();
            if (!scannedData) return;

            console.info("SCANDIT_BARCODE_RESULT", {
              barcode: scannedData,
            });

            hasScannedRef.current = true;
            if (isMounted) {
              setScanValue(scannedData);
              setStatus("scanned");
            }

            try {
              await barcodeCapture.setEnabled(false);
            } catch {
              // Ignore if capture already disabled.
            }
          },
        };

        barcodeCapture.addListener(listener);

        const camera = Camera.pickBestGuessForPosition(CameraPosition.WorldFacing);

        await context.setFrameSource(camera);
        await camera.switchToDesiredState(FrameSourceState.On);
        await context.addMode(barcodeCapture);

        const dataCaptureView = DataCaptureView.forElement(scannerContainerRef.current);
        dataCaptureView.context = context;
        dataCaptureView.addOverlay(barcodeCapture.createOverlay());

        console.info("SCANDIT_INIT_SUCCESS", {
          mountedTo: "scannerContainerRef",
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
      <style>{`
        .scandit-test-scanner-container {
          display: block;
          overflow: hidden;
          width: 100%;
          height: 100%;
        }

        .scandit-test-scanner-container > div[data-capture-view] {
          width: 100% !important;
          height: 100% !important;
        }

        .scandit-test-scanner-container video,
        .scandit-test-scanner-container canvas {
          width: 100% !important;
          height: 100% !important;
          object-fit: cover !important;
        }
      `}</style>
      <header style={styles.header}>
        <h2 style={styles.title}>Scandit Scanner Test</h2>
        <p style={styles.subtitle}>Mobile test for grocery barcode speed and camera behavior.</p>
      </header>

      {errorMessage ? (
        <div style={styles.errorBox} role="alert">
          {errorMessage}
        </div>
      ) : null}

      <div style={styles.cameraWrap}>
        <div
          ref={scannerContainerRef}
          className="scandit-test-scanner-container"
          style={styles.scannerContainer}
        />
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
    zIndex: 9999,
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "16px",
    background: "linear-gradient(180deg, #0e1729 0%, #152a4a 100%)",
    color: "#f8fbff",
    overflow: "hidden",
  },
  header: {
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: "1.25rem",
    lineHeight: 1.2,
    fontWeight: 700,
  },
  subtitle: {
    margin: "6px 0 0",
    fontSize: "0.95rem",
    lineHeight: 1.3,
    opacity: 0.88,
  },
  errorBox: {
    borderRadius: "12px",
    padding: "12px",
    background: "#592525",
    border: "1px solid #f06a6a",
    fontSize: "0.95rem",
    lineHeight: 1.35,
  },
  cameraWrap: {
    width: "100%",
    flexShrink: 0,
  },
  scannerContainer: {
    width: "100%",
    height: "460px",
    minHeight: "420px",
    position: "relative",
    borderRadius: "24px",
    background: "#0a111f",
    border: "1px solid rgba(255,255,255,0.16)",
    overflow: "hidden",
  },
  resultBox: {
    flexShrink: 0,
    borderRadius: "12px",
    padding: "12px",
    background: "rgba(255,255,255,0.09)",
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
    flexShrink: 0,
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: "10px",
    paddingBottom: "max(8px, env(safe-area-inset-bottom))",
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
