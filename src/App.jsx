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

  // Image State
  const [originalImage, setOriginalImage] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [filters, setFilters] = useState({
    threshold: 120,
    brightness: 10,
    contrast: 20,
  });

  // Detected Anchors (Dynamic Coordinates)
  const [detectedRows, setDetectedRows] = useState([]); // Y coordinates of the 10 rows
  const [anchorTopLeft, setAnchorTopLeft] = useState(null); // {x, y} of top-left big square

  const canvasRef = useRef(null);
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

  // --- ALGORITMA DETEKSI TANDA (CORE LOGIC) ---

  const findTimingMarks = (ctx, width, height) => {
    // 1. Scan margin kiri (sekitar 1% - 5% dari lebar gambar)
    // Kita mencari pola "Hitam - Putih - Hitam" vertikal
    const scanX = Math.floor(width * 0.025); // Scan di 2.5% lebar
    const imageData = ctx.getImageData(scanX, 0, 1, height);
    const data = imageData.data;

    const marks = [];
    let inMark = false;
    let markStart = 0;

    // Helper: Cek apakah pixel hitam
    const isBlack = (y) => {
      const idx = y * 4;
      // Karena sudah dibinarisasi di preview, cukup cek satu channel
      return data[idx] === 0;
    };

    // Cari blob hitam vertikal
    for (let y = 0; y < height; y++) {
      if (isBlack(y)) {
        if (!inMark) {
          inMark = true;
          markStart = y;
        }
      } else {
        if (inMark) {
          inMark = false;
          const markHeight = y - markStart;
          const markCenter = markStart + markHeight / 2;

          // Filter noise: Tanda harus cukup besar tapi tidak terlalu besar (untuk membedakan dengan garis border)
          // Asumsi tanda tinggi minimal 0.3% tinggi gambar
          if (markHeight > height * 0.003 && markHeight < height * 0.05) {
            marks.push({
              y: markCenter,
              h: markHeight,
              start: markStart,
              end: y,
            });
          }
        }
      }
    }

    // LJK 3.jpg memiliki 2 area tanda:
    // 1. Bagian atas (Header/Nama) - Biasanya tanda lebih jarang
    // 2. Bagian bawah (Jawaban) - Ada deretan tanda rapat (Timing Track)

    // Kita cari 10 tanda yang jaraknya relatif sama di bagian bawah (Jawaban)
    // Logika: Cari sequence 10 tanda yang spacing-nya konsisten

    // Filter hanya tanda di 60% ke bawah halaman (karena jawaban ada di bawah)
    const bottomMarks = marks.filter((m) => m.y > height * 0.6);

    // Jika kita menemukan sekitar 10 tanda, itu kemungkinan baris jawaban
    // LJK 3 punya tanda kotak kecil di kiri persis sebelah nomor
    if (bottomMarks.length >= 10) {
      // Ambil 10 tanda terakhir (biasanya paling relevan untuk 10 baris soal)
      // Atau logic yang lebih pintar: Cari grup dengan jarak rata-rata yang sama
      const candidates = bottomMarks.slice(-10);
      return candidates.map((m) => m.y);
    }

    return []; // Gagal deteksi dinamis
  };

  const findTopAnchor = (ctx, width, height) => {
    // Cari kotak besar di pojok kiri atas (0-15% lebar, 0-30% tinggi)
    // Ini untuk referensi posisi Nama
    const searchW = Math.floor(width * 0.15);
    const searchH = Math.floor(height * 0.3);
    const imageData = ctx.getImageData(0, 0, searchW, searchH);
    const data = imageData.data;

    // Simple Grid Search untuk blob hitam terbesar
    // (Implementasi sederhana: cari titik hitam pertama yang punya "tetangga" hitam luas)
    for (let y = Math.floor(height * 0.05); y < searchH; y += 5) {
      for (let x = Math.floor(width * 0.02); x < searchW; x += 5) {
        const idx = (y * searchW + x) * 4;
        if (data[idx] === 0) {
          // Ketemu hitam, cek apakah ini kotak besar?
          // Anggap saja ini anchor point
          return { x, y };
        }
      }
    }
    return null;
  };

  // --- IMAGE PROCESSING ---

  const applyImageFilters = useCallback(
    (ctx, width, height) => {
      const imageData = ctx.getImageData(0, 0, width, height);
      const data = imageData.data;
      const thres = filters.threshold;

      // Fast Binarization
      for (let i = 0; i < data.length; i += 4) {
        // Grayscale approx
        const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
        // Thresholding
        const val = avg < thres ? 0 : 255;
        data[i] = val;
        data[i + 1] = val;
        data[i + 2] = val;
      }
      ctx.putImageData(imageData, 0, 0);
    },
    [filters]
  );

  const updatePreviewAndDetect = useCallback(() => {
    if (!originalImage || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    canvas.width = originalImage.width;
    canvas.height = originalImage.height;

    // 1. Draw Original
    ctx.drawImage(originalImage, 0, 0);

    // 2. Apply B/W Filter (Wajib untuk deteksi tanda)
    applyImageFilters(ctx, canvas.width, canvas.height);

    // 3. DYNAMIC DETECTION
    const rowsY = findTimingMarks(ctx, canvas.width, canvas.height);
    const anchor = findTopAnchor(ctx, canvas.width, canvas.height);

    setDetectedRows(rowsY);
    setAnchorTopLeft(anchor);

    if (rowsY.length >= 10) {
      setCalibrationStatus({
        success: true,
        message: `Terdeteksi ${rowsY.length} Baris Dinamis`,
      });
    } else {
      setCalibrationStatus({
        success: false,
        message: "Gagal mendeteksi tanda baris di kiri. Coba atur Threshold.",
      });
    }

    // 4. Draw Debug Overlay
    if (showDebugOverlay) {
      const w = canvas.width;

      // A. Gambar Garis Deteksi Baris (HIJAU)
      ctx.strokeStyle = "#00ff00";
      ctx.lineWidth = 3;
      rowsY.forEach((y, idx) => {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y); // Garis horizontal penuh melintasi halaman
        ctx.stroke();

        // Label Nomor Baris
        ctx.fillStyle = "#00ff00";
        ctx.font = "bold 20px sans-serif";
        ctx.fillText(`Row ${idx + 1}`, 10, y - 5);
      });

      // B. Gambar Grid Jawaban (Estimasi berdasarkan garis baris)
      if (rowsY.length > 0) {
        const colPositions = [0.045, 0.24, 0.435, 0.63, 0.825]; // Estimasi X relatif lebar kertas

        rowsY.forEach((y) => {
          colPositions.forEach((xPct) => {
            const startX = w * xPct;
            // Gambar 5 lingkaran opsi A-E
            for (let k = 0; k < 5; k++) {
              const optX = startX + 25 + k * (w * 0.028); // 2.8% gap
              ctx.beginPath();
              ctx.arc(optX, y, w * 0.008, 0, 2 * Math.PI);
              ctx.strokeStyle = "rgba(255, 0, 0, 0.5)"; // Merah transparan
              ctx.stroke();
            }
          });
        });
      }

      // C. Gambar Anchor Nama (BIRU)
      if (anchor) {
        ctx.strokeStyle = "blue";
        ctx.lineWidth = 5;
        ctx.strokeRect(anchor.x, anchor.y, 20, 20); // Tandai titik anchor

        // Estimasi Kotak Nama relatif terhadap anchor
        const nameX = anchor.x;
        const nameY = anchor.y + canvas.height * 0.05; // Turun dikit dari anchor
        const nameW = canvas.width * 0.56;
        const nameH = canvas.height * 0.05;
        ctx.strokeStyle = "rgba(0,0,255,0.5)";
        ctx.strokeRect(nameX, nameY, nameW, nameH);
      }
    }

    setPreviewUrl(canvas.toDataURL());
  }, [originalImage, filters, showDebugOverlay]);

  useEffect(() => {
    updatePreviewAndDetect();
  }, [updatePreviewAndDetect]);

  // --- SCANNING LOGIC ---

  const getDarkness = (ctx, x, y, radius) => {
    const size = Math.floor(radius * 2);
    if (size <= 0) return 0;
    const startX = Math.floor(x - radius);
    const startY = Math.floor(y - radius);

    // Safety check
    if (startX < 0 || startY < 0) return 0;

    const imageData = ctx.getImageData(startX, startY, size, size);
    const data = imageData.data;
    let blackPixels = 0;
    let totalPixels = 0;

    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === 0) blackPixels++;
      totalPixels++;
    }
    return totalPixels > 0 ? (blackPixels / totalPixels) * 100 : 0;
  };

  const processScan = async () => {
    if (!canvasRef.current) return;
    setIsProcessing(true);
    setProcessingStep("Memproses Jawaban...");

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    // Re-draw clean image (no overlay)
    ctx.drawImage(originalImage, 0, 0);
    applyImageFilters(ctx, w, h);

    // 1. SCAN JAWABAN MENGGUNAKAN DETECTED ROWS
    // Jika deteksi gagal, kita bisa fallback ke statis atau throw error.
    // Di sini kita pakai detectedRows jika ada.

    let yCoords = detectedRows;

    // FALLBACK STATIS (Jika tanda gagal dideteksi)
    if (yCoords.length < 10) {
      console.warn("Fallback to Static Coordinates");
      const startYPct = 80.5;
      const rowHeightPct = 1.65;
      yCoords = Array.from(
        { length: 10 },
        (_, i) => ((startYPct + i * rowHeightPct) / 100) * h
      );
    } else {
      // Ambil 10 baris terakhir yang terdeteksi (asumsi urutan 1-10)
      yCoords = yCoords.slice(-10);
    }

    const detected = {};
    const radius = w * 0.006;

    // Kolom X (Masih semi-statis relatif lebar kertas, bisa ditingkatkan dengan deteksi pojok kanan)
    // Berdasarkan LJK 3.jpg
    const colStarts = [
      { startQ: 1, xPct: 0.045 },
      { startQ: 11, xPct: 0.24 },
      { startQ: 21, xPct: 0.435 },
      { startQ: 31, xPct: 0.63 },
      { startQ: 41, xPct: 0.825 },
    ];
    const optGap = w * 0.028; // Jarak A ke B

    colStarts.forEach((col) => {
      const baseX = w * col.xPct;

      for (let i = 0; i < 10; i++) {
        const qNum = col.startQ + i;
        const rowY = yCoords[i]; // DYNAMIS DARI TIMING MARKS

        let bestOpt = null;
        let maxBlack = 0;

        ["A", "B", "C", "D", "E"].forEach((opt, optIdx) => {
          // 25px offset awal + gap
          const x = baseX + 25 + optIdx * optGap;

          const darkness = getDarkness(ctx, x, rowY, radius);
          if (darkness > 40 && darkness > maxBlack) {
            maxBlack = darkness;
            bestOpt = opt;
          }
        });

        if (bestOpt) detected[qNum] = bestOpt;
      }
    });

    setStudentAnswers(detected);

    // 2. OCR NAMA (Relatif terhadap Top Anchor)
    setProcessingStep("OCR Nama...");

    let nx, ny, nw, nh;

    if (anchorTopLeft) {
      // Dinamis relative anchor
      nx = anchorTopLeft.x;
      ny = anchorTopLeft.y + h * 0.055; // Offset manual dikit ke bawah anchor
      nw = w * 0.56;
      nh = h * 0.045;
    } else {
      // Fallback Statis
      nx = w * 0.025;
      ny = h * 0.225;
      nw = w * 0.56;
      nh = h * 0.045;
    }

    // Extract Name Image
    const nameCanvas = document.createElement("canvas");
    nameCanvas.width = nw;
    nameCanvas.height = nh;
    const nameCtx = nameCanvas.getContext("2d");
    nameCtx.fillStyle = "white";
    nameCtx.fillRect(0, 0, nw, nh);
    nameCtx.drawImage(canvas, nx, ny, nw, nh, 0, 0, nw, nh);

    const nameUrl = nameCanvas.toDataURL();

    let extractedName = "SISWA TANPA NAMA";
    if (tesseractReady && window.Tesseract) {
      try {
        const result = await window.Tesseract.recognize(nameUrl, "eng", {
          tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ ",
          tessedit_pageseg_mode: "7",
        });
        const clean = result.data.text.replace(/[^A-Z ]/g, "").trim();
        if (clean.length > 2) extractedName = clean;
      } catch (e) {
        console.error(e);
      }
    }

    setStudentName(extractedName);
    setIsProcessing(false);
    setScanStage("result");
  };

  // --- RENDER UI ---

  const renderEditor = () => (
    <div className="fixed inset-0 z-50 bg-gray-900 flex flex-col">
      <div className="bg-gray-800 p-3 flex justify-between items-center text-white border-b border-gray-700">
        <h3 className="font-bold flex items-center gap-2">
          <Target className="w-4 h-4 text-green-400" /> Kalibrasi Dinamis
        </h3>
        <button onClick={() => setScanStage("capture")}>
          <XCircle />
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

        {/* Calibration Status Badge */}
        <div
          className={`absolute top-6 px-4 py-2 rounded-full text-xs font-bold backdrop-blur shadow-lg flex items-center gap-2 ${
            calibrationStatus.success
              ? "bg-green-500/90 text-white"
              : "bg-red-500/90 text-white"
          }`}
        >
          {calibrationStatus.success ? (
            <CheckCircle2 className="w-4 h-4" />
          ) : (
            <XCircle className="w-4 h-4" />
          )}
          {calibrationStatus.message}
        </div>
      </div>

      <div className="bg-gray-800 p-4 border-t border-gray-700">
        <div className="max-w-xl mx-auto space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="text-[10px] text-gray-400 uppercase font-bold">
                Threshold (Geser agar tanda baris hijau muncul)
              </label>
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
            <button
              onClick={() => setShowDebugOverlay(!showDebugOverlay)}
              className="bg-gray-700 p-2 rounded text-gray-300 border border-gray-600"
            >
              {showDebugOverlay ? (
                <Eye className="w-5 h-5" />
              ) : (
                <EyeOff className="w-5 h-5" />
              )}
            </button>
          </div>
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
              ? "Scan LJK Sekarang"
              : "Tanda Tidak Terdeteksi"}
          </button>
        </div>
      </div>
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );

  // (Sisanya: renderResult, renderHistory, main UI mirip sebelumnya, disederhanakan untuk konteks)

  const renderResult = () => (
    <div className="bg-white p-4 rounded-lg shadow border space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="font-bold text-lg">Hasil Scan</h2>
        <div className="text-2xl font-bold text-indigo-600">
          {useMemo(() => {
            const total = Object.keys(answerKey).length || 1;
            let correct = 0;
            Object.keys(studentAnswers).forEach((q) => {
              if (studentAnswers[q] === answerKey[q]) correct++;
            });
            return Math.round((correct / total) * 100);
          }, [studentAnswers, answerKey])}
        </div>
      </div>
      <div className="space-y-2">
        <label className="text-xs text-gray-500 font-bold">
          NAMA SISWA (OCR)
        </label>
        <input
          value={studentName}
          onChange={(e) => setStudentName(e.target.value)}
          className="w-full text-lg font-bold border-b-2 border-indigo-100 focus:border-indigo-500 outline-none"
        />
      </div>
      <div className="grid grid-cols-5 gap-1 text-[10px]">
        {Array.from({ length: 50 }, (_, i) => i + 1).map((q) => (
          <div
            key={q}
            className={`p-1 text-center border rounded ${
              studentAnswers[q] === answerKey[q] && answerKey[q]
                ? "bg-green-100 text-green-700 border-green-200"
                : studentAnswers[q]
                ? "bg-red-100 text-red-700"
                : "bg-gray-50 text-gray-400"
            }`}
          >
            {q}. {studentAnswers[q] || "-"}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => {
            if (!studentName) return alert("Nama kosong");
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
            ]); // Simplified stats
            setScanStage("capture");
            setStudentName("");
            setStudentAnswers({});
          }}
          className="flex-1 bg-indigo-600 text-white py-2 rounded font-bold"
        >
          Simpan
        </button>
        <button
          onClick={() => setScanStage("capture")}
          className="px-4 border rounded hover:bg-gray-50"
        >
          Batal
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-800 max-w-md mx-auto border-x shadow-xl pb-20">
      {scanStage === "preview" && renderEditor()}

      <header className="bg-white p-4 border-b flex items-center gap-2 sticky top-0 z-10">
        <ScanLine className="text-indigo-600" />
        <h1 className="font-bold text-indigo-800">
          LJK Scanner{" "}
          <span className="text-xs bg-green-100 text-green-700 px-1 rounded">
            Dynamic
          </span>
        </h1>
      </header>

      <main className="p-4 space-y-4">
        {/* Navigation */}
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
          <div
            className="border-2 border-dashed border-gray-300 rounded-xl p-8 bg-gray-50 text-center space-y-4"
            onClick={() => uploadInputRef.current.click()}
          >
            <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto">
              <Upload className="text-indigo-600 w-8 h-8" />
            </div>
            <div>
              <h3 className="font-bold text-gray-700">Upload Foto LJK</h3>
              <p className="text-xs text-gray-500 mt-1">
                Pastikan tanda kotak hitam di kiri terlihat jelas
              </p>
            </div>
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

        {mode === "scan" && scanStage === "result" && renderResult()}

        {mode === "key" && (
          <div className="bg-white p-4 rounded shadow">
            <h3 className="font-bold mb-4 border-b pb-2">Kunci Jawaban</h3>
            <div className="grid grid-cols-5 gap-1">
              {Array.from({ length: 50 }, (_, i) => i + 1).map((q) => (
                <div
                  key={q}
                  className="flex items-center justify-between text-[10px] border p-1 rounded"
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
            {history.map((h) => (
              <div
                key={h.id}
                className="bg-white p-3 border rounded flex justify-between items-center"
              >
                <div>
                  <div className="font-bold">{h.name}</div>
                  <div className="text-xs text-gray-400">{h.timestamp}</div>
                </div>
                <button
                  onClick={() =>
                    setHistory((p) => p.filter((x) => x.id !== h.id))
                  }
                  className="text-red-400 text-xs"
                >
                  Hapus
                </button>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
