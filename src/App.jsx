import React, {
  useState,
  useMemo,
  useRef,
  useEffect,
  useCallback,
} from "react";
import {
  CheckCircle2,
  XCircle,
  Key,
  Save,
  Upload,
  Camera,
  Download,
  History,
  Trash2,
  Settings,
  ScanLine,
  RefreshCw,
  Check,
  RotateCcw,
  Type,
  Eye,
  EyeOff,
  Target,
  Zap,
  ZapOff,
  Focus,
  ZoomIn,
  Wand2,
  SlidersHorizontal,
} from "lucide-react";

// --- TESSERACT LOADER ---
const useTesseract = () => {
  const [isLoaded, setIsLoaded] = useState(false);
  useEffect(() => {
    if (window.Tesseract) {
      setIsLoaded(true);
      return;
    }
    const script = document.createElement("script");
    script.src =
      "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    script.async = true;
    script.onload = () => setIsLoaded(true);
    document.body.appendChild(script);
  }, []);
  return isLoaded;
};

export default function App() {
  const tesseractReady = useTesseract();

  // --- STATE ---
  const [answerKey, setAnswerKey] = useState(() => {
    const saved = localStorage.getItem("ljk_answerKey");
    return saved ? JSON.parse(saved) : {};
  });

  const [history, setHistory] = useState(() => {
    const saved = localStorage.getItem("ljk_history");
    return saved ? JSON.parse(saved) : [];
  });

  const [className, setClassName] = useState(
    localStorage.getItem("ljk_className") || ""
  );
  const [studentName, setStudentName] = useState("");
  const [studentAnswers, setStudentAnswers] = useState({});

  const [mode, setMode] = useState("scan");
  const [scanStage, setScanStage] = useState("capture");
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStep, setProcessingStep] = useState("");
  const [showDebugOverlay, setShowDebugOverlay] = useState(true);

  // Camera State
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [autoCapture, setAutoCapture] = useState(false);
  const [cameraFeedback, setCameraFeedback] = useState("Arahkan ke LJK");
  const [zoomLevel, setZoomLevel] = useState(1);
  const [maxZoom, setMaxZoom] = useState(1);

  // Image State
  const [originalImage, setOriginalImage] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);

  // Filter Settings
  const [filterMode, setFilterMode] = useState("magic");
  const [filters, setFilters] = useState({
    threshold: 110,
    brightness: 10,
    contrast: 20,
  });

  // Detected Anchors (Dynamic Coordinates)
  const [detectedRows, setDetectedRows] = useState([]);
  const [anchorTopLeft, setAnchorTopLeft] = useState(null);

  const canvasRef = useRef(null);
  const blurCanvasRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const trackRef = useRef(null);
  const scanIntervalRef = useRef(null);
  const uploadInputRef = useRef(null);

  // Persistence
  useEffect(() => {
    localStorage.setItem("ljk_answerKey", JSON.stringify(answerKey));
  }, [answerKey]);
  useEffect(() => {
    localStorage.setItem("ljk_history", JSON.stringify(history));
  }, [history]);
  useEffect(() => {
    localStorage.setItem("ljk_className", className);
  }, [className]);

  const currentScore = useMemo(() => {
    const k = Object.keys(answerKey);
    if (!k.length) return 0;
    let c = 0;
    k.forEach((q) => {
      if (studentAnswers[q] === answerKey[q]) c++;
    });
    return Math.round((c / k.length) * 100);
  }, [studentAnswers, answerKey]);

  // --- IMAGE PROCESSING ENGINE ---

  const applyMagicFilter = (ctx, width, height) => {
    const imgData = ctx.getImageData(0, 0, width, height);
    const src = imgData.data;

    let blurCtx = blurCanvasRef.current?.getContext("2d");
    if (!blurCanvasRef.current) {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      blurCtx = c.getContext("2d");
      blurCanvasRef.current = c;
    } else {
      blurCanvasRef.current.width = width;
      blurCanvasRef.current.height = height;
    }

    blurCtx.filter = "blur(20px)";
    blurCtx.drawImage(ctx.canvas, 0, 0);
    const blurData = blurCtx.getImageData(0, 0, width, height).data;

    const sensitivity = 30;

    for (let i = 0; i < src.length; i += 4) {
      const gray = (src[i] + src[i + 1] + src[i + 2]) / 3;
      const bg = (blurData[i] + blurData[i + 1] + blurData[i + 2]) / 3;
      const val = gray < bg - sensitivity ? 0 : 255;
      src[i] = val;
      src[i + 1] = val;
      src[i + 2] = val;
    }
    ctx.putImageData(imgData, 0, 0);
  };

  const applyManualFilter = (ctx, width, height) => {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const thres = filters.threshold;
    for (let i = 0; i < data.length; i += 4) {
      const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const val = avg < thres ? 0 : 255;
      data[i] = val;
      data[i + 1] = val;
      data[i + 2] = val;
    }
    ctx.putImageData(imageData, 0, 0);
  };

  // --- DETECTION LOGIC (IMPROVED) ---

  const analyzeImage = useCallback((ctx, width, height) => {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    // Scan margin kiri (3% dari kiri)
    const scanX = Math.floor(width * 0.03);
    let marks = [];
    let inMark = false;
    let markStart = 0;

    for (let y = 0; y < height; y++) {
      const idx = (y * width + scanX) * 4;
      const isBlack = data[idx] === 0;

      if (isBlack) {
        if (!inMark) {
          inMark = true;
          markStart = y;
        }
      } else {
        if (inMark) {
          inMark = false;
          const h = y - markStart;
          // FILTER 1: Validasi Tinggi
          // Min 0.3% (untuk ignore noise)
          // Max 2.5% (PENTING: Kotak Anchor biasanya > 3%, jadi ini akan memfilter kotak bawah)
          if (h > height * 0.003 && h < height * 0.025) {
            marks.push(markStart + h / 2);
          }
        }
      }
    }

    // FILTER 2: Validasi Posisi Y
    // Ambil tanda yang ada di area jawaban (55% - 89% tinggi kertas)
    // Batas 89% ini penting agar kotak anchor di posisi 90-95% tidak terambil
    const validMarks = marks.filter(
      (y) => y > height * 0.55 && y < height * 0.89
    );

    return { validMarks };
  }, []);

  // --- CAMERA LOGIC ---

  const startCamera = async () => {
    setIsCameraOpen(true);
    try {
      const constraints = {
        video: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          focusMode: "continuous",
        },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          if (autoCapture) startAutoCaptureLoop();
        };
      }
      streamRef.current = stream;

      const track = stream.getVideoTracks()[0];
      trackRef.current = track;
      const caps = track.getCapabilities();
      if (caps.zoom) {
        setMaxZoom(caps.zoom.max);
        setZoomLevel(caps.zoom.min || 1);
      }
    } catch (err) {
      alert("Error Kamera: " + err.message);
      setIsCameraOpen(false);
    }
  };

  const handleZoom = (e) => {
    const z = Number(e.target.value);
    setZoomLevel(z);
    if (trackRef.current?.applyConstraints)
      trackRef.current.applyConstraints({ advanced: [{ zoom: z }] });
  };

  const triggerFocus = async () => {
    if (trackRef.current?.applyConstraints) {
      try {
        await trackRef.current.applyConstraints({
          advanced: [{ focusMode: "manual", focusDistance: 0.5 }],
        });
        setTimeout(
          async () =>
            await trackRef.current.applyConstraints({
              advanced: [{ focusMode: "continuous" }],
            }),
          200
        );
      } catch (e) {}
    }
  };

  const stopCamera = () => {
    setIsCameraOpen(false);
    if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
    if (streamRef.current)
      streamRef.current.getTracks().forEach((t) => t.stop());
  };

  const startAutoCaptureLoop = () => {
    if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
    scanIntervalRef.current = setInterval(() => {
      if (!videoRef.current || !autoCapture) return;
    }, 500);
  };

  const capturePhoto = () => {
    if (videoRef.current) {
      const video = videoRef.current;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0);
      const img = new Image();
      img.onload = () => {
        setOriginalImage(img);
        setScanStage("preview");
        stopCamera();
      };
      img.src = canvas.toDataURL();
    }
  };

  // --- PREVIEW & EDITOR ---

  const updatePreviewAndDetect = useCallback(() => {
    if (!originalImage || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    canvas.width = originalImage.width;
    canvas.height = originalImage.height;

    ctx.drawImage(originalImage, 0, 0);

    if (filterMode === "magic") {
      applyMagicFilter(ctx, canvas.width, canvas.height);
    } else {
      applyManualFilter(ctx, canvas.width, canvas.height);
    }

    const { validMarks } = analyzeImage(ctx, canvas.width, canvas.height);

    // FILTER 3: Smart Selection (Ambil 10 baris paling masuk akal)
    let rowsY = [];
    if (validMarks.length >= 10) {
      // Jika terdeteksi lebih dari 10, kita harus hati-hati.
      // Ambil 10 baris terakhir, TAPI karena kita sudah filter area bawah (<89%),
      // seharusnya aman.
      rowsY = validMarks.slice(-10);
      setCameraFeedback("Mode Dinamis: OK");
    } else {
      setCameraFeedback("Mode Statis (Fallback)");
      const startY = canvas.height * 0.805;
      const stepY = canvas.height * 0.0165;
      rowsY = Array.from({ length: 10 }, (_, i) => startY + i * stepY);
    }
    setDetectedRows(rowsY);

    if (showDebugOverlay) {
      const w = canvas.width;
      rowsY.forEach((y, i) => {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.strokeStyle = validMarks.length >= 10 ? "#00ff00" : "#ff0000";
        ctx.lineWidth = validMarks.length >= 10 ? 4 : 2;
        ctx.stroke();
      });
    }
    setPreviewUrl(canvas.toDataURL());
  }, [originalImage, filterMode, filters, showDebugOverlay, analyzeImage]);

  useEffect(() => {
    updatePreviewAndDetect();
  }, [updatePreviewAndDetect]);

  // --- SCAN PROCESS ---

  const getDarkness = (ctx, x, y, radius) => {
    if (x < 0 || y < 0) return 0;
    const size = Math.floor(radius * 2);
    const img = ctx.getImageData(x - radius, y - radius, size, size);
    let black = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 0) black++;
    return (black / (img.data.length / 4)) * 100;
  };

  const processScan = async () => {
    if (!canvasRef.current) return;
    setIsProcessing(true);
    setProcessingStep("Analisis Jawaban...");

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;

    const answers = {};
    let yCoords = detectedRows;

    // Double check saat proses final
    if (yCoords.length < 10) {
      const startY = canvas.height * 0.805;
      yCoords = Array.from(
        { length: 10 },
        (_, i) => startY + i * (canvas.height * 0.0165)
      );
    } else {
      // Pastikan kita pakai 10 baris terbawah dari hasil filter yang ketat
      yCoords = yCoords.slice(-10);
    }

    const colX = [0.045, 0.24, 0.435, 0.63, 0.825];
    const optGap = w * 0.028;

    colX.forEach((cx, cIdx) => {
      const startQ = cIdx * 10 + 1;
      const baseX = w * cx;
      for (let r = 0; r < 10; r++) {
        const y = yCoords[r];
        const qNum = startQ + r;
        let best = null;
        let maxD = 0;

        ["A", "B", "C", "D", "E"].forEach((opt, oIdx) => {
          const x = baseX + 25 + oIdx * optGap;
          const dark = getDarkness(ctx, x, y, w * 0.006);
          if (dark > 35 && dark > maxD) {
            maxD = dark;
            best = opt;
          }
        });
        if (best) answers[qNum] = best;
      }
    });
    setStudentAnswers(answers);

    setProcessingStep("OCR Nama...");
    setTimeout(() => {
      setIsProcessing(false);
      setScanStage("result");
    }, 500);
  };

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-800 max-w-md mx-auto border-x shadow-xl pb-20 relative">
      {/* CAMERA OVERLAY */}
      {isCameraOpen && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col">
          <div className="absolute top-0 w-full p-4 flex justify-between z-20 text-white bg-gradient-to-b from-black/80 to-transparent">
            <button onClick={stopCamera}>
              <XCircle />
            </button>
            {maxZoom > 1 && (
              <div className="flex items-center gap-2 bg-black/50 px-3 py-1 rounded-full backdrop-blur">
                <ZoomIn className="w-4 h-4" />
                <input
                  type="range"
                  min="1"
                  max={maxZoom}
                  step="0.1"
                  value={zoomLevel}
                  onChange={handleZoom}
                  className="w-20 h-1 accent-white"
                />
                <span className="text-xs font-mono">
                  {zoomLevel.toFixed(1)}x
                </span>
              </div>
            )}
          </div>

          <div
            className="flex-1 relative bg-black flex flex-col items-center justify-center"
            onClick={triggerFocus}
          >
            <video
              ref={videoRef}
              autoPlay
              playsInline
              className="w-full h-full object-cover opacity-90"
            />
            <div className="absolute pointer-events-none text-white/70 text-sm animate-pulse mt-40 font-medium drop-shadow-md">
              Ketuk layar agar fokus
            </div>
          </div>

          <div className="p-8 bg-black flex justify-around items-center relative z-20">
            <button
              onClick={capturePhoto}
              className="w-20 h-20 bg-white rounded-full border-4 border-gray-300 active:scale-95 transition-transform flex items-center justify-center shadow-[0_0_30px_rgba(255,255,255,0.3)]"
            >
              <div className="w-18 h-18 border-2 border-black rounded-full"></div>
            </button>
          </div>
        </div>
      )}

      {/* EDITOR OVERLAY */}
      {scanStage === "preview" && (
        <div className="fixed inset-0 z-40 bg-gray-900 flex flex-col">
          <div className="bg-gray-800 p-3 flex justify-between items-center text-white border-b border-gray-700">
            <h3 className="font-bold flex items-center gap-2">
              <Target className="w-4 h-4 text-green-400" /> Editor Scan
            </h3>
            <button onClick={() => setScanStage("capture")}>
              <XCircle className="text-gray-400 hover:text-white" />
            </button>
          </div>

          <div className="flex-1 bg-black relative overflow-auto flex items-center justify-center p-4">
            {previewUrl && (
              <img
                src={previewUrl}
                className="max-w-full border border-gray-700 shadow-2xl"
                alt="Preview"
              />
            )}

            {/* Status Indicator */}
            <div className="absolute top-4 left-4 space-y-1">
              {detectedRows.length >= 10 ? (
                <div className="flex items-center gap-2 bg-green-500/90 text-white px-3 py-1 rounded-full text-[10px] font-bold shadow backdrop-blur">
                  <CheckCircle2 className="w-3 h-3" /> LJK Terdeteksi (Dinamis)
                </div>
              ) : (
                <div className="flex items-center gap-2 bg-red-500/90 text-white px-3 py-1 rounded-full text-[10px] font-bold shadow backdrop-blur">
                  <XCircle className="w-3 h-3" /> Mode Fallback (Statis)
                </div>
              )}
            </div>

            {isProcessing && (
              <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center text-white z-50">
                <RefreshCw className="animate-spin w-10 h-10 text-indigo-400 mb-3" />
                <p>{processingStep}</p>
              </div>
            )}
          </div>

          {/* FILTER CONTROLS */}
          <div className="bg-gray-800 p-4 border-t border-gray-700 space-y-4">
            {/* Filter Toggle */}
            <div className="flex bg-gray-700 p-1 rounded-lg">
              <button
                onClick={() => setFilterMode("magic")}
                className={`flex-1 py-2 rounded-md text-xs font-bold flex items-center justify-center gap-2 transition ${
                  filterMode === "magic"
                    ? "bg-indigo-600 text-white shadow"
                    : "text-gray-400"
                }`}
              >
                <Wand2 className="w-3 h-3" /> Magic Enhance
              </button>
              <button
                onClick={() => setFilterMode("manual")}
                className={`flex-1 py-2 rounded-md text-xs font-bold flex items-center justify-center gap-2 transition ${
                  filterMode === "manual"
                    ? "bg-gray-600 text-white shadow"
                    : "text-gray-400"
                }`}
              >
                <SlidersHorizontal className="w-3 h-3" /> Manual
              </button>
            </div>

            {/* Manual Slider */}
            {filterMode === "manual" && (
              <div className="space-y-1 animate-in fade-in">
                <div className="flex justify-between text-[10px] text-gray-400">
                  <span>Gelap</span>
                  <span>Threshold: {filters.threshold}</span>
                  <span>Terang</span>
                </div>
                <input
                  type="range"
                  min="50"
                  max="200"
                  value={filters.threshold}
                  onChange={(e) =>
                    setFilters((f) => ({
                      ...f,
                      threshold: Number(e.target.value),
                    }))
                  }
                  className="w-full h-2 bg-gray-600 rounded-lg accent-indigo-500 cursor-pointer"
                />
              </div>
            )}

            {filterMode === "magic" && (
              <p className="text-[10px] text-gray-400 text-center">
                Mode Magic otomatis membersihkan bayangan dan mempertajam tanda
                LJK agar Garis Hijau muncul.
              </p>
            )}

            <button
              onClick={processScan}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold flex justify-center items-center gap-2 shadow-lg transition active:scale-95"
            >
              <Check className="w-5 h-5" /> Proses Jawaban
            </button>
          </div>
          <canvas ref={canvasRef} className="hidden" />
        </div>
      )}

      {/* HEADER */}
      <header className="bg-white p-4 border-b flex justify-between items-center sticky top-0 z-10">
        <div className="flex items-center gap-2 font-bold text-indigo-800">
          <ScanLine /> LJK Pro{" "}
          <span className="text-xs bg-indigo-100 text-indigo-600 px-1 rounded">
            Enhance
          </span>
        </div>
        <div className="text-xs text-gray-500">{history.length} Data</div>
      </header>

      {/* MAIN CONTENT */}
      <main className="p-4 space-y-4">
        <div className="flex bg-gray-200 p-1 rounded-lg">
          {["scan", "key", "history"].map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 py-2 text-xs font-bold rounded capitalize ${
                mode === m ? "bg-white shadow text-indigo-600" : "text-gray-500"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {mode === "scan" && scanStage === "capture" && (
          <div className="grid grid-cols-1 gap-3">
            <button
              onClick={startCamera}
              className="bg-indigo-600 text-white p-6 rounded-xl shadow-lg shadow-indigo-200 hover:bg-indigo-700 transition flex flex-col items-center gap-2 group"
            >
              <div className="p-3 bg-white/10 rounded-full group-hover:scale-110 transition">
                <Camera className="w-8 h-8" />
              </div>
              <span className="font-bold">Buka Kamera</span>
            </button>
            <button
              onClick={() => uploadInputRef.current.click()}
              className="bg-white border border-gray-300 text-gray-700 p-4 rounded-xl hover:bg-gray-50 flex items-center justify-center gap-2 font-bold text-sm"
            >
              <Upload className="w-5 h-5" /> Upload Foto
            </button>
            <input
              ref={uploadInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                if (e.target.files[0]) {
                  const img = new Image();
                  img.onload = () => {
                    setOriginalImage(img);
                    setScanStage("preview");
                  };
                  img.src = URL.createObjectURL(e.target.files[0]);
                }
              }}
            />
          </div>
        )}

        {mode === "scan" && scanStage === "result" && (
          <div className="bg-white p-4 rounded-lg shadow border space-y-4">
            <div className="flex justify-between items-center border-b pb-2">
              <h2 className="font-bold text-lg text-gray-800">Hasil</h2>
              <div
                className={`text-2xl font-bold ${
                  currentScore >= 75 ? "text-green-600" : "text-red-600"
                }`}
              >
                {currentScore}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-bold text-gray-400 uppercase">
                Nama Siswa
              </label>
              <input
                value={studentName}
                onChange={(e) => setStudentName(e.target.value)}
                className="w-full font-bold text-lg border-b-2 border-indigo-100 focus:border-indigo-500 outline-none uppercase"
                placeholder="KETIK NAMA..."
              />
            </div>

            <div className="grid grid-cols-5 gap-1 text-[10px]">
              {Array.from({ length: 50 }, (_, i) => i + 1).map((q) => {
                const isCorrect = studentAnswers[q] === answerKey[q];
                const filled = studentAnswers[q];
                return (
                  <div
                    key={q}
                    className={`border rounded p-1 text-center ${
                      isCorrect && answerKey[q]
                        ? "bg-green-100 text-green-800 border-green-300"
                        : filled
                        ? "bg-red-100 text-red-800 border-red-200"
                        : "bg-gray-50 text-gray-400"
                    }`}
                  >
                    <span className="opacity-50 mr-1">{q}</span>
                    <span className="font-bold">{filled || "-"}</span>
                  </div>
                );
              })}
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (!studentName) return alert("Isi nama dulu");
                  setHistory((h) => [
                    {
                      id: Date.now(),
                      name: studentName,
                      className,
                      answers: studentAnswers,
                      timestamp: new Date().toLocaleString(),
                      stats: { score: currentScore },
                    },
                    ...h,
                  ]);
                  setScanStage("capture");
                  setStudentName("");
                  setStudentAnswers({});
                }}
                className="bg-green-600 text-white px-4 py-2 rounded font-bold flex-1"
              >
                Simpan
              </button>
              <button
                onClick={() => setScanStage("capture")}
                className="bg-gray-100 px-4 py-2 rounded font-bold"
              >
                Batal
              </button>
            </div>
          </div>
        )}

        {/* ... Key & History Section (No Changes) ... */}
        {mode === "key" && (
          <div className="bg-white p-4 rounded shadow border">
            <div className="flex justify-between mb-4">
              <h3 className="font-bold">Kunci Jawaban</h3>
              <button
                onClick={() => setAnswerKey({})}
                className="text-xs text-red-500"
              >
                Reset
              </button>
            </div>
            <div className="grid grid-cols-5 gap-1">
              {Array.from({ length: 50 }, (_, i) => i + 1).map((q) => (
                <div
                  key={q}
                  className={`flex justify-between text-[10px] border p-1 rounded ${
                    answerKey[q] ? "bg-indigo-50 border-indigo-200" : ""
                  }`}
                >
                  <span className="text-gray-400">{q}</span>
                  <select
                    value={answerKey[q] || ""}
                    onChange={(e) =>
                      setAnswerKey((k) => ({ ...k, [q]: e.target.value }))
                    }
                    className="font-bold text-indigo-600 bg-transparent outline-none"
                  >
                    <option value="">-</option>
                    {"ABCDE".split("").map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}

        {mode === "history" && (
          <div className="space-y-2">
            {history.map((h) => (
              <div
                key={h.id}
                className="bg-white p-3 border rounded flex justify-between items-center"
              >
                <div>
                  <div className="font-bold">{h.name}</div>
                  <div className="text-[10px] text-gray-400">{h.timestamp}</div>
                </div>
                <button
                  onClick={() =>
                    setHistory((p) => p.filter((x) => x.id !== h.id))
                  }
                  className="text-red-400 hover:bg-red-50 p-2 rounded"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
