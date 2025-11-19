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
  const [calibrationStatus, setCalibrationStatus] = useState({
    success: false,
    message: "Menunggu Gambar",
  });

  // Camera State
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [autoCapture, setAutoCapture] = useState(true); // Fitur Auto-Scan Kembali!
  const [cameraFeedback, setCameraFeedback] = useState("Mencari LJK...");

  // Image State
  const [originalImage, setOriginalImage] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [filters, setFilters] = useState({
    threshold: 120,
    brightness: 10,
    contrast: 20,
  });

  // Detected Anchors (Dynamic Coordinates)
  const [detectedRows, setDetectedRows] = useState([]);
  const [anchorTopLeft, setAnchorTopLeft] = useState(null);

  const canvasRef = useRef(null); // Processing canvas
  const videoRef = useRef(null);
  const streamRef = useRef(null);
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

  // --- CORE DETECTION LOGIC (Reusable) ---

  const analyzeImage = useCallback(
    (ctx, width, height, customThreshold = null) => {
      const threshold = customThreshold || filters.threshold;
      const imageData = ctx.getImageData(0, 0, width, height);
      const data = imageData.data;

      // 1. Binarize on the fly (for detection only)
      for (let i = 0; i < data.length; i += 4) {
        const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
        const val = avg < threshold ? 0 : 255;
        data[i] = val; // R (Only use R channel for check)
      }

      // 2. Find Timing Marks (Left Margin)
      const scanX = Math.floor(width * 0.03); // 3% from left
      let marks = [];
      let inMark = false;
      let markStart = 0;

      for (let y = 0; y < height; y++) {
        const isBlack = data[(y * width + scanX) * 4] === 0;
        if (isBlack) {
          if (!inMark) {
            inMark = true;
            markStart = y;
          }
        } else {
          if (inMark) {
            inMark = false;
            const h = y - markStart;
            if (h > height * 0.003 && h < height * 0.05) {
              marks.push(markStart + h / 2);
            }
          }
        }
      }

      const validMarks = marks.filter((y) => y > height * 0.5); // Tanda di bawah (jawaban)

      return { validMarks };
    },
    [filters.threshold]
  );

  // --- CAMERA AUTO-CAPTURE LOGIC ---

  const startCamera = async () => {
    setIsCameraOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          if (autoCapture) startAutoCaptureLoop();
        };
      }
      streamRef.current = stream;
    } catch (err) {
      alert("Gagal akses kamera. Gunakan upload manual.");
      setIsCameraOpen(false);
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

      const video = videoRef.current;
      if (video.readyState !== 4) return;

      // Create tiny canvas for fast analysis
      const w = 320; // Low res for speed
      const h = Math.floor(w * (video.videoHeight / video.videoWidth));

      const cvs = document.createElement("canvas");
      cvs.width = w;
      cvs.height = h;
      const ctx = cvs.getContext("2d");
      ctx.drawImage(video, 0, 0, w, h);

      // Analyze
      const { validMarks } = analyzeImage(ctx, w, h, 100); // Threshold 100 for camera

      // Logic: Jika menemukan 10 baris atau lebih, berarti LJK terdeteksi & fokus
      if (validMarks.length >= 10) {
        setCameraFeedback("LJK Terdeteksi! Tahan stabil...");
        clearInterval(scanIntervalRef.current); // Stop loop

        // Delay capture sedikit agar stabil
        setTimeout(() => {
          capturePhoto();
          if (navigator.vibrate) navigator.vibrate(100);
        }, 500);
      } else {
        setCameraFeedback("Mencari Tanda Baris...");
      }
    }, 400); // Check every 400ms
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

  // --- MAIN PREVIEW LOGIC (EDITOR) ---

  const updatePreviewAndDetect = useCallback(() => {
    if (!originalImage || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    canvas.width = originalImage.width;
    canvas.height = originalImage.height;

    // Draw Original
    ctx.drawImage(originalImage, 0, 0);

    // Apply Filters for Display/Detection
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const thres = filters.threshold;

    for (let i = 0; i < data.length; i += 4) {
      // Grayscale & Threshold logic
      const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const val = avg < thres ? 0 : 255;
      data[i] = val;
      data[i + 1] = val;
      data[i + 2] = val;
    }
    ctx.putImageData(imageData, 0, 0);

    // Dynamic Detection (High Res)
    const { validMarks } = analyzeImage(ctx, canvas.width, canvas.height);

    // Filter marks logic specific for LJK 3
    let rowsY = [];
    if (validMarks.length >= 10) {
      rowsY = validMarks.slice(-10); // Ambil 10 terbawah
      setCalibrationStatus({
        success: true,
        message: `Siap Scan: ${rowsY.length} Baris`,
      });
    } else {
      setCalibrationStatus({
        success: false,
        message: "Sesuaikan Threshold hingga garis hijau muncul",
      });
    }
    setDetectedRows(rowsY);

    // Find Anchor (Top Left)
    // Simple scan for big black box at top-left
    let anchor = null;
    const searchW = Math.floor(canvas.width * 0.2);
    const searchH = Math.floor(canvas.height * 0.3);
    const searchData = ctx.getImageData(0, 0, searchW, searchH).data;

    for (let y = 20; y < searchH; y += 5) {
      for (let x = 20; x < searchW; x += 5) {
        if (searchData[(y * searchW + x) * 4] === 0) {
          // Found black pixel, assume anchor for now
          anchor = { x, y };
          break;
        }
      }
      if (anchor) break;
    }
    setAnchorTopLeft(anchor);

    // --- DEBUG OVERLAY ---
    if (showDebugOverlay) {
      const w = canvas.width;

      // Draw Rows (Green Lines)
      ctx.strokeStyle = "#00ff00";
      ctx.lineWidth = 3;
      rowsY.forEach((y, i) => {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.fillStyle = "#00ff00";
        ctx.font = "20px sans";
        ctx.fillText(`${i + 1}`, 10, y - 5);
      });

      // Draw Anchor (Blue Box)
      if (anchor) {
        ctx.strokeStyle = "blue";
        ctx.lineWidth = 4;
        ctx.strokeRect(anchor.x, anchor.y, 30, 30);
      }
    }

    setPreviewUrl(canvas.toDataURL());
  }, [originalImage, filters, showDebugOverlay, analyzeImage]);

  useEffect(() => {
    updatePreviewAndDetect();
  }, [updatePreviewAndDetect]);

  // --- FINAL SCAN ---

  const getDarkness = (ctx, x, y, radius) => {
    // Simplified darkness check
    if (x < 0 || y < 0) return 0;
    const size = Math.floor(radius * 2);
    const img = ctx.getImageData(
      Math.floor(x - radius),
      Math.floor(y - radius),
      size,
      size
    );
    let black = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 0) black++;
    return (black / (img.data.length / 4)) * 100;
  };

  const processScan = async () => {
    if (!canvasRef.current) return;
    setIsProcessing(true);
    setProcessingStep("Menganalisis...");

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    // Redraw clean B/W for reading
    ctx.drawImage(originalImage, 0, 0);
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3 < filters.threshold ? 0 : 255;
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
    }
    ctx.putImageData(imgData, 0, 0);

    // 1. READ ANSWERS
    const answers = {};
    let yCoords = detectedRows;
    // Fallback if detection failed
    if (yCoords.length < 10) {
      yCoords = Array.from({ length: 10 }, (_, i) => (0.805 + i * 0.0165) * h);
    } else {
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
          if (dark > 40 && dark > maxD) {
            maxD = dark;
            best = opt;
          }
        });
        if (best) answers[qNum] = best;
      }
    });
    setStudentAnswers(answers);

    // 2. OCR
    setProcessingStep("OCR Nama...");
    let nx = w * 0.025,
      ny = h * 0.225;
    if (anchorTopLeft) {
      nx = anchorTopLeft.x;
      ny = anchorTopLeft.y + h * 0.055;
    }

    const nameCvs = document.createElement("canvas");
    nameCvs.width = w * 0.56;
    nameCvs.height = h * 0.045;
    nameCvs
      .getContext("2d")
      .drawImage(
        canvas,
        nx,
        ny,
        w * 0.56,
        h * 0.045,
        0,
        0,
        w * 0.56,
        h * 0.045
      );

    let name = "SISWA TANPA NAMA";
    if (tesseractReady && window.Tesseract) {
      try {
        const res = await window.Tesseract.recognize(
          nameCvs.toDataURL(),
          "eng",
          {
            tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ ",
            tessedit_pageseg_mode: "7",
          }
        );
        const clean = res.data.text.replace(/[^A-Z ]/g, "").trim();
        if (clean.length > 2) name = clean;
      } catch (e) {}
    }
    setStudentName(name);
    setIsProcessing(false);
    setScanStage("result");
  };

  // --- RENDER ---

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-800 max-w-md mx-auto border-x shadow-xl pb-20 relative">
      {/* CAMERA OVERLAY */}
      {isCameraOpen && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col">
          <div className="absolute top-0 w-full p-4 flex justify-between z-20 text-white bg-gradient-to-b from-black/80 to-transparent">
            <button onClick={stopCamera}>
              <XCircle />
            </button>
            <button
              onClick={() => {
                setAutoCapture(!autoCapture);
                if (!autoCapture && videoRef.current) startAutoCaptureLoop();
                else if (scanIntervalRef.current)
                  clearInterval(scanIntervalRef.current);
              }}
              className={`flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold border ${
                autoCapture
                  ? "bg-green-500/20 border-green-400 text-green-400"
                  : "bg-gray-800 border-gray-600 text-gray-400"
              }`}
            >
              {autoCapture ? (
                <Zap className="w-3 h-3 fill-current" />
              ) : (
                <ZapOff className="w-3 h-3" />
              )}
              {autoCapture ? "Auto-ON" : "Manual"}
            </button>
          </div>

          <div className="flex-1 relative bg-black">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              className="w-full h-full object-cover opacity-80"
            />

            {/* Guide Frame */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div
                className={`w-[90%] aspect-[3/4] border-2 rounded-lg transition-colors duration-300 ${
                  cameraFeedback.includes("Terdeteksi")
                    ? "border-green-400 shadow-[0_0_50px_rgba(0,255,0,0.3)]"
                    : "border-white/30"
                }`}
              >
                {/* Corner Markers */}
                <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-white -mt-1 -ml-1" />
                <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-white -mt-1 -mr-1" />
                <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-white -mb-1 -ml-1" />
                <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-white -mb-1 -mr-1" />
              </div>
            </div>

            {/* Feedback Text */}
            <div className="absolute bottom-24 left-0 right-0 text-center pointer-events-none">
              <div className="inline-block px-4 py-2 bg-black/60 backdrop-blur text-white rounded-full font-bold text-sm animate-pulse">
                {cameraFeedback}
              </div>
            </div>
          </div>

          <div className="p-8 bg-black flex justify-center items-center relative z-20">
            <button
              onClick={capturePhoto}
              className="w-16 h-16 bg-white rounded-full border-4 border-gray-300 active:scale-95 transition-transform"
            />
          </div>
        </div>
      )}

      {/* EDITOR OVERLAY */}
      {scanStage === "preview" && (
        <div className="fixed inset-0 z-40 bg-gray-900 flex flex-col">
          <div className="bg-gray-800 p-3 flex justify-between items-center text-white border-b border-gray-700">
            <h3 className="font-bold flex items-center gap-2">
              <Target className="w-4 h-4 text-green-400" /> Konfirmasi Scan
            </h3>
            <button onClick={() => setScanStage("capture")}>
              <XCircle className="text-gray-400 hover:text-white" />
            </button>
          </div>

          <div className="flex-1 bg-black relative overflow-auto flex items-center justify-center p-4">
            {previewUrl && (
              <img
                src={previewUrl}
                className="max-w-full border border-gray-700"
                alt="Preview"
              />
            )}
            {/* Status Badge */}
            <div
              className={`absolute top-4 px-3 py-1 rounded-full text-xs font-bold backdrop-blur shadow flex items-center gap-2 ${
                calibrationStatus.success
                  ? "bg-green-500/90 text-white"
                  : "bg-red-500/90 text-white"
              }`}
            >
              {calibrationStatus.success ? (
                <CheckCircle2 className="w-3 h-3" />
              ) : (
                <XCircle className="w-3 h-3" />
              )}
              {calibrationStatus.message}
            </div>
            {isProcessing && (
              <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center text-white z-50">
                <RefreshCw className="animate-spin w-10 h-10 text-indigo-400 mb-3" />
                <p>{processingStep}</p>
              </div>
            )}
          </div>

          <div className="bg-gray-800 p-4 border-t border-gray-700">
            <div className="flex items-center gap-3 mb-3">
              <span className="text-[10px] text-gray-400 uppercase font-bold flex-1">
                Threshold ({filters.threshold})
              </span>
              <button
                onClick={() => setShowDebugOverlay(!showDebugOverlay)}
                className="text-gray-400 hover:text-white"
              >
                <Eye className="w-4 h-4" />
              </button>
            </div>
            <input
              type="range"
              min="50"
              max="200"
              value={filters.threshold}
              onChange={(e) =>
                setFilters((f) => ({ ...f, threshold: Number(e.target.value) }))
              }
              className="w-full h-2 bg-gray-600 rounded-lg accent-indigo-500 cursor-pointer mb-4"
            />

            <button
              onClick={processScan}
              disabled={!calibrationStatus.success}
              className={`w-full py-3 rounded-lg font-bold flex justify-center items-center gap-2 transition ${
                calibrationStatus.success
                  ? "bg-green-600 text-white hover:bg-green-500"
                  : "bg-gray-600 text-gray-400 cursor-not-allowed"
              }`}
            >
              {calibrationStatus.success
                ? "Proses Data LJK"
                : "Tanda Tidak Terdeteksi"}
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
            v4
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
              className="bg-indigo-600 text-white p-6 rounded-xl shadow-lg shadow-indigo-200 hover:bg-indigo-700 transition flex flex-col items-center gap-2"
            >
              <Camera className="w-8 h-8" />
              <span className="font-bold">Mulai Kamera Auto-Scan</span>
            </button>
            <button
              onClick={() => uploadInputRef.current.click()}
              className="bg-white border border-gray-300 text-gray-700 p-4 rounded-xl hover:bg-gray-50 flex items-center justify-center gap-2 font-bold text-sm"
            >
              <Upload className="w-5 h-5" /> Upload Foto Manual
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
            <p className="text-center text-xs text-gray-400 mt-2">
              Tips: Auto-Scan akan otomatis memotret saat LJK terdeteksi stabil.
            </p>
          </div>
        )}

        {mode === "scan" && scanStage === "result" && (
          <div className="bg-white p-4 rounded-lg shadow border space-y-4 animate-in fade-in slide-in-from-bottom-4">
            <div className="flex justify-between items-center border-b pb-2">
              <h2 className="font-bold text-lg text-gray-800">Hasil Koreksi</h2>
              <div className="bg-indigo-100 text-indigo-700 px-3 py-1 rounded-lg font-bold text-xl">
                {useMemo(() => {
                  const k = Object.keys(answerKey);
                  if (!k.length) return 0;
                  let c = 0;
                  k.forEach((q) => {
                    if (studentAnswers[q] === answerKey[q]) c++;
                  });
                  return Math.round((c / k.length) * 100);
                }, [studentAnswers, answerKey])}
              </div>
            </div>

            <div className="flex gap-3">
              <div className="w-24 h-24 bg-gray-100 rounded border shrink-0 overflow-hidden">
                {/* Placeholder for user name crop could go here if stored */}
                <Type className="w-full h-full p-6 text-gray-300" />
              </div>
              <div className="flex-1 space-y-1">
                <label className="text-[10px] font-bold text-gray-400 uppercase">
                  Nama Siswa
                </label>
                <input
                  value={studentName}
                  onChange={(e) => setStudentName(e.target.value)}
                  className="w-full font-bold text-lg border-b-2 border-indigo-100 focus:border-indigo-500 outline-none bg-transparent uppercase"
                  placeholder="NAMA..."
                />
                <div className="flex gap-2 mt-2">
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
                          stats: { score: 0 },
                        },
                        ...h,
                      ]);
                      setScanStage("capture");
                      setStudentName("");
                      setStudentAnswers({});
                    }}
                    className="bg-green-600 text-white px-4 py-2 rounded text-xs font-bold flex-1"
                  >
                    Simpan
                  </button>
                  <button
                    onClick={() => setScanStage("capture")}
                    className="bg-gray-100 px-3 py-2 rounded text-xs font-bold"
                  >
                    Batal
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-5 gap-1 text-[10px] pt-2">
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
          </div>
        )}

        {mode === "key" && (
          <div className="bg-white p-4 rounded shadow border">
            <h3 className="font-bold mb-4 text-gray-700 flex justify-between">
              Kunci Jawaban{" "}
              <span className="text-xs font-normal bg-gray-100 px-2 py-1 rounded">
                {Object.keys(answerKey).length} Soal Terisi
              </span>
            </h3>
            <div className="grid grid-cols-5 gap-1">
              {Array.from({ length: 50 }, (_, i) => i + 1).map((q) => (
                <div
                  key={q}
                  className={`flex items-center justify-between text-[10px] border p-1 rounded ${
                    answerKey[q] ? "border-indigo-200 bg-indigo-50" : ""
                  }`}
                >
                  <span className="text-gray-400 w-4">{q}</span>
                  <select
                    value={answerKey[q] || ""}
                    onChange={(e) =>
                      setAnswerKey((k) => ({ ...k, [q]: e.target.value }))
                    }
                    className="font-bold text-indigo-600 bg-transparent outline-none w-8 text-right"
                  >
                    <option value="">-</option>
                    {["A", "B", "C", "D", "E"].map((o) => (
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
            {history.length === 0 && (
              <div className="text-center text-gray-400 py-8">
                Belum ada riwayat scan.
              </div>
            )}
            {history.map((h) => (
              <div
                key={h.id}
                className="bg-white p-3 border rounded flex justify-between items-center hover:shadow-sm"
              >
                <div>
                  <div className="font-bold text-gray-800">{h.name}</div>
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
