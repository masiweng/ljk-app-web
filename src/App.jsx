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
  FileCheck,
  Upload,
  Camera,
  Download,
  History,
  User,
  Users,
  Trash2,
  Settings,
  ScanLine,
  RefreshCw,
  Maximize,
  Zap,
  ZapOff,
  StopCircle,
  AlertTriangle,
  WifiOff,
} from "lucide-react";

export default function App() {
  // --- STATE MANAGEMENT ---

  // 1. Kunci Jawaban (Persistent)
  const [answerKey, setAnswerKey] = useState(() => {
    const saved = localStorage.getItem("ljk_answerKey");
    return saved ? JSON.parse(saved) : {};
  });

  useEffect(() => {
    localStorage.setItem("ljk_answerKey", JSON.stringify(answerKey));
  }, [answerKey]);

  // Data Siswa & Processing
  const [studentName, setStudentName] = useState("");
  const [studentAnswers, setStudentAnswers] = useState({});
  const [scanImage, setScanImage] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [sensitivity, setSensitivity] = useState(130);

  // Camera & Auto-Scan State
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [autoScanEnabled, setAutoScanEnabled] = useState(true);
  const [cameraError, setCameraError] = useState(null);

  // Data Global
  const [className, setClassName] = useState(
    () => localStorage.getItem("ljk_className") || ""
  );
  const [history, setHistory] = useState(() => {
    const saved = localStorage.getItem("ljk_history");
    return saved ? JSON.parse(saved) : [];
  });

  useEffect(() => {
    localStorage.setItem("ljk_history", JSON.stringify(history));
    localStorage.setItem("ljk_className", className);
  }, [history, className]);

  const [mode, setMode] = useState("key");
  const totalQuestions = 50;
  const options = ["A", "B", "C", "D", "E"];
  const questions = Array.from({ length: totalQuestions }, (_, i) => i + 1);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const scanIntervalRef = useRef(null);
  const uploadInputRef = useRef(null);

  // --- LOGIC UTAMA ---

  const handleBubbleClick = (qNum, option) => {
    if (mode === "key") {
      // Jika sudah dipilih, batalkan (toggle)
      setAnswerKey((prev) => {
        const newKey = { ...prev };
        if (newKey[qNum] === option) {
          delete newKey[qNum]; // Hapus jika diklik lagi
        } else {
          newKey[qNum] = option;
        }
        return newKey;
      });
    } else if (mode === "scan") {
      setStudentAnswers((prev) => ({ ...prev, [qNum]: option }));
    }
  };

  const calculateStats = (answers) => {
    let correct = 0;
    let wrong = 0;
    let empty = 0;

    questions.forEach((q) => {
      const key = answerKey[q];
      const ans = answers[q];
      if (!key) return;

      if (!ans) empty++;
      else if (ans === key) correct++;
      else wrong++;
    });

    const totalKeyed = Object.keys(answerKey).length;
    const score = totalKeyed > 0 ? Math.round((correct / totalKeyed) * 100) : 0;
    return { correct, wrong, empty, score, totalKeyed };
  };

  const currentStats = useMemo(
    () => calculateStats(studentAnswers),
    [answerKey, studentAnswers]
  );

  // --- OMR ENGINE (CORE LOGIC) ---

  const getRegionDarkness = (ctx, canvasW, canvasH, xPct, yPct, wPct, hPct) => {
    const x = Math.floor((xPct / 100) * canvasW);
    const y = Math.floor((yPct / 100) * canvasH);
    const w = Math.floor((wPct / 100) * canvasW);
    const h = Math.floor((hPct / 100) * canvasH);

    if (w <= 0 || h <= 0) return 255;

    const region = ctx.getImageData(x, y, w, h).data;
    let totalBrightness = 0;
    let pixels = 0;

    for (let i = 0; i < region.length; i += 16) {
      totalBrightness += region[i];
      pixels++;
    }
    return pixels > 0 ? totalBrightness / pixels : 255;
  };

  const processScan = useCallback(
    (sourceElement, returnResult = false) => {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      let width, height;
      if (sourceElement.tagName === "VIDEO") {
        width = sourceElement.videoWidth;
        height = sourceElement.videoHeight;
      } else {
        width = sourceElement.width;
        height = sourceElement.height;
      }

      if (width === 0 || height === 0) return null;

      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(sourceElement, 0, 0, width, height);

      const imageData = ctx.getImageData(0, 0, width, height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
        data[i] = avg;
        data[i + 1] = avg;
        data[i + 2] = avg;
      }
      ctx.putImageData(imageData, 0, 0);

      // 2. Read Name
      const nameStartX = 4.5;
      const nameStartY = 26;
      const nameColW = 2.8;
      const nameRowH = 0.9;
      let detectedName = "";
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

      for (let col = 0; col < 20; col++) {
        let darkestChar = "";
        let minBrightness = 255;
        for (let row = 0; row < 26; row++) {
          const x = nameStartX + col * nameColW;
          const y = nameStartY + row * nameRowH;
          const brightness = getRegionDarkness(
            ctx,
            width,
            height,
            x,
            y,
            1.5,
            0.7
          );

          if (brightness < sensitivity && brightness < minBrightness) {
            minBrightness = brightness;
            darkestChar = alphabet[row];
          }
        }
        detectedName += darkestChar || "";
      }
      detectedName = detectedName.trim();

      // 3. Read Answers
      const answerZones = [
        { startQ: 1, x: 5, y: 78 },
        { startQ: 11, x: 24, y: 78 },
        { startQ: 21, x: 43, y: 78 },
        { startQ: 31, x: 62, y: 78 },
        { startQ: 41, x: 81, y: 78 },
      ];
      const detectedAnswers = {};
      const rowHeight = 1.55;
      const optWidth = 2.5;

      answerZones.forEach((zone) => {
        for (let i = 0; i < 10; i++) {
          const qNum = zone.startQ + i;
          let bestOption = null;
          let minVal = 255;
          options.forEach((opt, optIdx) => {
            const x = zone.x + 2.5 + optIdx * optWidth;
            const y = zone.y + i * rowHeight;
            const brightness = getRegionDarkness(
              ctx,
              width,
              height,
              x,
              y,
              1.8,
              1.2
            );
            if (brightness < sensitivity && brightness < minVal) {
              minVal = brightness;
              bestOption = opt;
            }
          });
          if (bestOption) detectedAnswers[qNum] = bestOption;
        }
      });

      const result = {
        name: detectedName || "SISWA TANPA NAMA",
        answers: detectedAnswers,
      };

      if (returnResult) return result;

      setStudentName(result.name);
      setStudentAnswers(result.answers);
      setScanImage(canvas.toDataURL());
      setIsProcessing(false);
    },
    [sensitivity, options]
  );

  // --- LIVE CAMERA LOGIC (DIPERBARUI) ---

  const startCamera = async () => {
    setIsCameraOpen(true);
    setCameraError(null);

    // 1. Cek Protokol Keamanan (Wajib HTTPS atau localhost murni)
    if (!window.isSecureContext) {
      setCameraError("BLOCK_INSECURE_ORIGIN");
      return;
    }

    // 2. Cek Dukungan Browser
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError("Browser Anda tidak mendukung akses kamera langsung.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      streamRef.current = stream;

      if (autoScanEnabled) {
        scanIntervalRef.current = setInterval(checkAutoScan, 800);
      }
    } catch (err) {
      console.error("Camera Error:", err);
      let errorMessage = "Gagal mengakses kamera.";

      if (
        err.name === "NotAllowedError" ||
        err.name === "PermissionDeniedError"
      ) {
        errorMessage =
          "Izin kamera DITOLAK. Silakan reset izin di pengaturan situs.";
      } else if (err.name === "NotFoundError") {
        errorMessage = "Kamera tidak ditemukan pada perangkat ini.";
      } else if (err.name === "NotReadableError") {
        errorMessage = "Kamera sedang digunakan aplikasi lain.";
      }

      setCameraError(errorMessage);
    }
  };

  const stopCamera = () => {
    setIsCameraOpen(false);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }
    if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
  };

  const capturePhoto = () => {
    if (videoRef.current) {
      setIsProcessing(true);
      processScan(videoRef.current);
      stopCamera();
    }
  };

  const checkAutoScan = () => {
    if (!videoRef.current || !autoScanEnabled) return;
    const result = processScan(videoRef.current, true);
    if (result) {
      const filledAnswers = Object.keys(result.answers).length;
      const hasName =
        result.name.length > 3 && result.name !== "SISWA TANPA NAMA";
      if (hasName && filledAnswers >= 5) {
        clearInterval(scanIntervalRef.current);
        setIsProcessing(true);
        setTimeout(() => {
          setStudentName(result.name);
          setStudentAnswers(result.answers);
          setScanImage(canvasRef.current.toDataURL());
          stopCamera();
          setIsProcessing(false);
          if (navigator.vibrate) navigator.vibrate(100);
        }, 200);
      }
    }
  };

  // --- HANDLERS LAINNYA ---

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.src = e.target.result;
        img.onload = () => {
          setIsProcessing(true);
          setTimeout(() => processScan(img), 100);
        };
      };
      reader.readAsDataURL(file);
    }
  };

  const reScan = () => {
    if (scanImage) {
      const img = new Image();
      img.src = scanImage;
      img.onload = () => processScan(img);
    }
  };

  const saveToHistory = () => {
    if (!studentName.trim()) return alert("Nama Siswa wajib diisi!");

    const newEntry = {
      id: Date.now(),
      timestamp: new Date().toLocaleString(),
      name: studentName,
      className: className || "Tanpa Kelas",
      stats: currentStats,
      answers: studentAnswers,
    };

    setHistory((prev) => [newEntry, ...prev]);
    setStudentName("");
    setStudentAnswers({});
    setScanImage(null);
    alert("Data tersimpan!");
  };

  const downloadCSV = () => {
    if (history.length === 0) return alert("Belum ada data.");
    const headers = [
      "No",
      "Waktu Scan",
      "Nama Siswa",
      "Kelas",
      "Nilai",
      "Benar",
      "Salah",
      "Kosong",
    ];
    const rows = history.map((item, index) => [
      index + 1,
      `"${item.timestamp}"`,
      `"${item.name}"`,
      `"${item.className}"`,
      item.stats.score,
      item.stats.correct,
      item.stats.wrong,
      item.stats.empty,
    ]);
    const csvContent = [
      headers.join(","),
      ...rows.map((r) => r.join(",")),
    ].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `Hasil_LJK_${className || "Export"}_${Date.now()}.csv`;
    link.click();
  };

  // --- RENDER UI COMPONENTS ---

  const renderColumns = () => {
    const columns = [];
    const rowsPerCol = 10;

    for (let i = 0; i < 5; i++) {
      // PERBAIKAN LOGIKA INDEX SLICE DISINI
      const startIdx = i * rowsPerCol; // 0, 10, 20, 30, 40
      const endIdx = startIdx + rowsPerCol; // 10, 20, 30, 40, 50
      const colQuestions = questions.slice(startIdx, endIdx); // Ambil 10 soal pas

      const startNum = startIdx + 1;
      const endNum = endIdx;

      columns.push(
        <div
          key={i}
          className="bg-white p-2 rounded border border-gray-200 shadow-sm"
        >
          <h4 className="text-xs font-bold text-gray-400 uppercase mb-2 text-center">
            No. {startNum}-{endNum}
          </h4>
          {colQuestions.map((q) => (
            <div
              key={q}
              className="flex items-center gap-1 mb-1.5 justify-center"
            >
              <span className="w-5 text-right text-xs font-mono text-gray-500 mr-1">
                {q}
              </span>
              {options.map((opt) => {
                let style =
                  "w-7 h-7 rounded-full border flex items-center justify-center text-xs font-bold cursor-pointer transition-all ";
                const key = answerKey[q];
                const ans = studentAnswers[q];

                if (mode === "key") {
                  style +=
                    key === opt
                      ? "bg-blue-600 border-blue-600 text-white scale-110"
                      : "bg-white border-gray-300 text-gray-400";
                } else {
                  if (ans === opt) {
                    if (key)
                      style +=
                        ans === key
                          ? "bg-green-500 border-green-500 text-white"
                          : "bg-red-500 border-red-500 text-white";
                    else style += "bg-gray-800 border-gray-800 text-white";
                  } else if (key === opt && ans && ans !== key) {
                    style +=
                      "bg-green-50 border-green-300 text-green-600 ring-2 ring-green-200";
                  } else {
                    style += "bg-white border-gray-200 text-gray-300";
                  }
                }
                return (
                  <div
                    key={opt}
                    onClick={() => handleBubbleClick(q, opt)}
                    className={style}
                  >
                    {opt}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      );
    }
    return columns;
  };

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-800 pb-20">
      <canvas ref={canvasRef} className="hidden"></canvas>

      {/* --- LIVE CAMERA MODAL --- */}
      {isCameraOpen && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col">
          {/* Top Bar */}
          <div className="absolute top-0 left-0 right-0 p-4 flex justify-between items-center z-20 bg-gradient-to-b from-black/70 to-transparent text-white">
            <button
              onClick={stopCamera}
              className="p-2 rounded-full bg-white/20 backdrop-blur-sm"
            >
              <XCircle className="w-6 h-6" />
            </button>
            {!cameraError && (
              <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-full backdrop-blur-md border border-white/10">
                <button
                  onClick={() => setAutoScanEnabled(!autoScanEnabled)}
                  className={`flex items-center gap-2 text-xs font-bold px-2 py-1 rounded ${
                    autoScanEnabled ? "text-green-400" : "text-gray-400"
                  }`}
                >
                  {autoScanEnabled ? (
                    <Zap className="w-4 h-4 fill-current" />
                  ) : (
                    <ZapOff className="w-4 h-4" />
                  )}
                  {autoScanEnabled ? "Auto-Scan ON" : "Manual"}
                </button>
              </div>
            )}
          </div>

          {/* Video Feed */}
          <div className="relative flex-1 bg-black flex items-center justify-center overflow-hidden">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              className="absolute w-full h-full object-cover opacity-90"
            ></video>

            {/* OVERLAY GUIDE - Only if NO Error */}
            {!cameraError && (
              <div className="relative w-[90%] aspect-[3/4] border-2 border-green-400 rounded-lg shadow-[0_0_0_9999px_rgba(0,0,0,0.5)] pointer-events-none z-10 animate-pulse">
                <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-green-500 -mt-1 -ml-1"></div>
                <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-green-500 -mt-1 -mr-1"></div>
                <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-green-500 -mb-1 -ml-1"></div>
                <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-green-500 -mb-1 -mr-1"></div>

                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-green-400 text-center px-4">
                  <ScanLine className="w-12 h-12 mx-auto mb-2 opacity-80" />
                  <p className="text-sm font-bold bg-black/50 px-2 py-1 rounded backdrop-blur">
                    {autoScanEnabled ? "Tahan stabil..." : "Paskan LJK di sini"}
                  </p>
                </div>
              </div>
            )}

            {/* ERROR MESSAGE DISPLAY (Custom untuk Masalah IP/HTTP) */}
            {cameraError && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/90 text-white p-8 text-center z-30">
                <div className="max-w-xs">
                  {cameraError === "BLOCK_INSECURE_ORIGIN" ? (
                    <>
                      <WifiOff className="w-16 h-16 text-red-500 mx-auto mb-6" />
                      <h3 className="text-lg font-bold mb-2">
                        Kamera Diblokir Browser
                      </h3>
                      <p className="text-sm text-gray-300 mb-6">
                        Anda mengakses via IP (HTTP). Browser memblokir kamera
                        untuk alasan keamanan.
                      </p>
                      <div className="bg-gray-800 p-3 rounded text-xs text-left mb-6">
                        <strong>Solusi:</strong>
                        <br />
                        1. Gunakan fitur <strong>Upload File</strong> (Foto LJK
                        lewat aplikasi kamera bawaan HP).
                        <br />
                        2. Atau gunakan <code>localhost</code> via kabel USB
                        debugging.
                      </div>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="w-16 h-16 text-yellow-500 mx-auto mb-6" />
                      <h3 className="text-lg font-bold mb-2">Error Kamera</h3>
                      <p className="text-sm text-gray-300 mb-6">
                        {cameraError}
                      </p>
                    </>
                  )}

                  <div className="flex flex-col gap-3">
                    {cameraError !== "BLOCK_INSECURE_ORIGIN" && (
                      <button
                        onClick={() => startCamera()}
                        className="w-full px-4 py-3 bg-indigo-600 hover:bg-indigo-700 rounded-lg font-bold text-sm transition"
                      >
                        Coba Lagi
                      </button>
                    )}
                    <button
                      onClick={stopCamera}
                      className="w-full px-4 py-3 bg-white text-black hover:bg-gray-200 rounded-lg font-bold text-sm transition"
                    >
                      Tutup & Upload Manual
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Bottom Controls */}
          {!cameraError && (
            <div className="bg-black p-6 pb-10 flex justify-center items-center gap-8">
              {!autoScanEnabled && (
                <button
                  onClick={capturePhoto}
                  className="w-20 h-20 bg-white rounded-full border-4 border-gray-300 flex items-center justify-center active:scale-95 transition-transform shadow-[0_0_20px_rgba(255,255,255,0.3)]"
                >
                  <div className="w-16 h-16 bg-white rounded-full border-2 border-black"></div>
                </button>
              )}
              {autoScanEnabled && (
                <div className="text-center text-gray-400 text-xs animate-pulse">
                  Sedang memindai...
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* HEADER */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-20 shadow-sm px-4 py-3">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-2">
            <FileCheck className="w-6 h-6 text-indigo-600" />
            <div>
              <h1 className="text-lg font-bold leading-none">
                LJK Scanner Pro
              </h1>
              <p className="text-[10px] text-gray-500">
                Live Auto-Scan Enabled
              </p>
            </div>
          </div>
          <div className="text-xs font-mono bg-indigo-50 text-indigo-700 px-2 py-1 rounded">
            Kelas: {className || "Umum"}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* SIDEBAR */}
        <div className="lg:col-span-3 space-y-4">
          <div className="bg-white p-2 rounded-xl shadow-sm border border-gray-200 flex flex-col gap-1">
            {[
              { id: "key", icon: Key, label: "1. Kunci Jawaban" },
              { id: "scan", icon: ScanLine, label: "2. Scan & Koreksi" },
              { id: "history", icon: History, label: "3. Riwayat Data" },
            ].map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                  mode === m.id
                    ? "bg-indigo-50 text-indigo-700 shadow-sm"
                    : "text-gray-600 hover:bg-gray-50"
                }`}
              >
                <m.icon className="w-5 h-5" /> {m.label}
              </button>
            ))}
          </div>

          {mode === "scan" && (
            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200 sticky top-20">
              <h3 className="text-xs font-bold text-gray-400 uppercase mb-3">
                Skor Sementara
              </h3>
              <div className="text-center mb-4">
                <div
                  className={`text-5xl font-bold ${
                    currentStats.score >= 75 ? "text-green-600" : "text-red-600"
                  }`}
                >
                  {currentStats.score}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="bg-green-50 p-1 rounded">
                  <b className="text-green-700 block text-lg">
                    {currentStats.correct}
                  </b>
                  Benar
                </div>
                <div className="bg-red-50 p-1 rounded">
                  <b className="text-red-700 block text-lg">
                    {currentStats.wrong}
                  </b>
                  Salah
                </div>
                <div className="bg-gray-50 p-1 rounded">
                  <b className="text-gray-600 block text-lg">
                    {currentStats.empty}
                  </b>
                  Kosong
                </div>
              </div>
            </div>
          )}
        </div>

        {/* CONTENT AREA */}
        <div className="lg:col-span-9">
          {/* MODE: KUNCI JAWABAN */}
          {mode === "key" && (
            <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-bold">Input Kunci Jawaban</h2>
                <button
                  onClick={() => {
                    if (confirm("Reset Kunci?")) setAnswerKey({});
                  }}
                  className="text-red-600 text-sm hover:underline"
                >
                  Reset Kunci
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                {renderColumns()}
              </div>
            </div>
          )}

          {/* MODE: SCAN */}
          {mode === "scan" && (
            <div className="space-y-6">
              {/* SECTION 1: UPLOAD & IMAGE */}
              <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-bold text-gray-700 mb-2">
                      Ambil Data LJK
                    </label>

                    {/* BUTTONS UNTUK BUKA KAMERA / UPLOAD */}
                    <div className="flex flex-col gap-2 mb-3">
                      <button
                        onClick={startCamera}
                        className="w-full bg-indigo-600 text-white py-3 rounded-lg hover:bg-indigo-700 flex justify-center items-center gap-2 shadow-md transition-transform active:scale-95"
                      >
                        <Maximize className="w-5 h-5" /> Buka Kamera Live
                        (Auto-Scan)
                      </button>

                      <div className="flex gap-2">
                        <button
                          onClick={() => uploadInputRef.current.click()}
                          className="flex-1 bg-white border border-gray-300 text-gray-700 py-2 rounded-lg hover:bg-gray-50 flex justify-center items-center gap-2 text-sm"
                        >
                          <Upload className="w-4 h-4" /> Upload File
                        </button>
                      </div>

                      <input
                        type="file"
                        accept="image/*"
                        ref={uploadInputRef}
                        className="hidden"
                        onChange={handleFileUpload}
                      />
                    </div>

                    {/* Image Preview & Settings */}
                    <div className="relative w-full h-64 bg-gray-900 rounded-lg overflow-hidden border-2 border-gray-300 flex items-center justify-center group shadow-inner">
                      {scanImage ? (
                        <>
                          <img
                            src={scanImage}
                            alt="LJK Scan"
                            className="w-full h-full object-contain"
                          />
                          {isProcessing && (
                            <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center text-white z-10">
                              <RefreshCw className="w-10 h-10 animate-spin mb-2" />
                              <span>Memproses...</span>
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="text-gray-500 flex flex-col items-center">
                          <ScanLine className="w-10 h-10 mb-2 opacity-50" />
                          <span className="text-xs">Preview Hasil Scan</span>
                        </div>
                      )}
                    </div>

                    {/* Sensitivity Slider */}
                    {scanImage && (
                      <div className="mt-3 bg-gray-50 p-3 rounded border border-gray-200">
                        <div className="flex justify-between text-xs mb-1">
                          <span className="font-bold text-gray-600 flex items-center gap-1">
                            <Settings className="w-3 h-3" /> Sensitivitas
                          </span>
                          <span>{sensitivity}</span>
                        </div>
                        <input
                          type="range"
                          min="50"
                          max="200"
                          step="5"
                          value={sensitivity}
                          onChange={(e) =>
                            setSensitivity(Number(e.target.value))
                          }
                          onMouseUp={reScan}
                          onTouchEnd={reScan}
                          className="w-full h-2 bg-gray-300 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                        />
                      </div>
                    )}
                  </div>

                  {/* Form Identitas */}
                  <div className="flex flex-col justify-between">
                    <div className="space-y-4">
                      <div>
                        <label className="text-xs font-bold text-gray-500 uppercase">
                          Nama Kelas
                        </label>
                        <div className="relative">
                          <Users className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                          <input
                            type="text"
                            value={className}
                            onChange={(e) => setClassName(e.target.value)}
                            placeholder="XII IPA 1"
                            className="w-full pl-9 pr-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="text-xs font-bold text-gray-500 uppercase">
                          Nama Siswa (Hasil Scan)
                        </label>
                        <div className="relative">
                          <User className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                          <input
                            type="text"
                            value={studentName}
                            onChange={(e) => setStudentName(e.target.value)}
                            placeholder="Hasil scan otomatis..."
                            className="w-full pl-9 pr-3 py-2 border rounded-lg text-sm font-bold text-gray-800 focus:ring-2 focus:ring-indigo-500 outline-none bg-yellow-50"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="mt-6 flex gap-2">
                      <button
                        onClick={saveToHistory}
                        className="flex-1 bg-green-600 hover:bg-green-700 text-white py-2.5 rounded-lg font-medium flex items-center justify-center gap-2 shadow-sm"
                      >
                        <Save className="w-4 h-4" /> Simpan Data
                      </button>
                      <button
                        onClick={() => {
                          setStudentAnswers({});
                          setStudentName("");
                          setScanImage(null);
                        }}
                        className="px-3 border rounded-lg hover:bg-gray-100"
                      >
                        <Trash2 className="w-4 h-4 text-gray-500" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Hasil Scan Jawaban */}
              <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
                <h3 className="font-bold text-gray-700 mb-4">
                  Hasil Scan Lembar Jawaban
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  {renderColumns()}
                </div>
              </div>
            </div>
          )}

          {/* MODE: HISTORY */}
          {mode === "history" && (
            <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-bold">
                  Riwayat Data ({history.length})
                </h2>
                <div className="flex gap-2">
                  <button
                    onClick={() => setHistory([])}
                    className="text-red-600 text-xs font-bold hover:bg-red-50 px-3 py-2 rounded"
                  >
                    Hapus Semua
                  </button>
                  <button
                    onClick={downloadCSV}
                    className="bg-indigo-600 text-white text-xs font-bold px-4 py-2 rounded hover:bg-indigo-700 flex items-center gap-2"
                  >
                    <Download className="w-3 h-3" /> Export CSV
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left text-gray-500">
                  <thead className="text-xs text-gray-700 uppercase bg-gray-50">
                    <tr>
                      <th className="px-4 py-3">Waktu</th>
                      <th className="px-4 py-3">Nama</th>
                      <th className="px-4 py-3">Nilai</th>
                      <th className="px-4 py-3 text-center">B/S/K</th>
                      <th className="px-4 py-3 text-center">Aksi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((item) => (
                      <tr
                        key={item.id}
                        className="bg-white border-b hover:bg-gray-50"
                      >
                        <td className="px-4 py-3 text-xs">
                          {item.timestamp.split(",")[1]}
                        </td>
                        <td className="px-4 py-3 font-bold text-gray-800">
                          {item.name}
                          <br />
                          <span className="text-[10px] font-normal text-gray-400">
                            {item.className}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-bold text-indigo-600">
                          {item.stats.score}
                        </td>
                        <td className="px-4 py-3 text-center text-xs">
                          <span className="text-green-600 font-bold">
                            {item.stats.correct}
                          </span>{" "}
                          /
                          <span className="text-red-600 font-bold">
                            {item.stats.wrong}
                          </span>{" "}
                          /
                          <span className="text-gray-400">
                            {item.stats.empty}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => deleteHistoryItem(item.id)}
                            className="text-red-500 hover:bg-red-50 p-1 rounded"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
