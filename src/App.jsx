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
  Edit3,
  Image as ImageIcon,
  Sliders,
  Check,
  RotateCcw,
  Type
} from "lucide-react";

// Load Tesseract.js from CDN for OCR
const useTesseract = () => {
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (window.Tesseract) {
      setIsLoaded(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    script.async = true;
    script.onload = () => setIsLoaded(true);
    document.body.appendChild(script);
  }, []);

  return isLoaded;
};

export default function App() {
  const tesseractReady = useTesseract();

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
  
  // Scan Stage: 'capture' | 'preview' | 'result'
  const [scanStage, setScanStage] = useState('capture'); 
  
  // Image States
  const [originalImage, setOriginalImage] = useState(null); // Gambar asli dari kamera/upload
  const [processedImageURL, setProcessedImageURL] = useState(null); // Gambar hasil filter untuk UI
  
  // Filter Settings (Google Drive Style)
  const [filters, setFilters] = useState({
    threshold: 120, // Penting untuk LJK: memisahkan hitam/putih
    brightness: 0,
    contrast: 0,
    mode: 'binary' // 'original', 'grayscale', 'binary'
  });

  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStep, setProcessingStep] = useState("");

  // Camera State
  const [isCameraOpen, setIsCameraOpen] = useState(false);
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

  const [mode, setMode] = useState("scan"); // Default ke scan biar langsung action
  const totalQuestions = 50;
  const options = ["A", "B", "C", "D", "E"];
  const questions = Array.from({ length: totalQuestions }, (_, i) => i + 1);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const previewCanvasRef = useRef(null);
  const streamRef = useRef(null);
  const uploadInputRef = useRef(null);
  
  // Name Crop State for Manual Verification
  const [nameCrop, setNameCrop] = useState(null);

  // --- IMAGE PROCESSING ENGINE (FILTERS) ---

  // Fungsi ini dipanggil setiap kali slider filter berubah
  const applyFilters = useCallback(() => {
    if (!originalImage || !previewCanvasRef.current) return;

    const canvas = previewCanvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    
    // Reset canvas ke ukuran gambar asli
    canvas.width = originalImage.width;
    canvas.height = originalImage.height;
    
    // Gambar original
    ctx.drawImage(originalImage, 0, 0);
    
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const threshold = filters.threshold;
    const contrast = filters.contrast; // -100 to 100
    const brightness = filters.brightness; // -100 to 100

    // Faktor kontras
    const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));

    for (let i = 0; i < data.length; i += 4) {
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];

      // 1. Grayscale (Luminosity method)
      let gray = 0.21 * r + 0.72 * g + 0.07 * b;

      // 2. Brightness & Contrast
      gray = factor * (gray - 128) + 128 + brightness;

      // 3. Mode Processing
      if (filters.mode === 'binary') {
        // Thresholding keras untuk LJK (Hitam atau Putih saja)
        const val = gray < threshold ? 0 : 255;
        data[i] = val;
        data[i + 1] = val;
        data[i + 2] = val;
      } else if (filters.mode === 'grayscale') {
        data[i] = gray;
        data[i + 1] = gray;
        data[i + 2] = gray;
      }
      // else original: do nothing
    }

    ctx.putImageData(imageData, 0, 0);
    setProcessedImageURL(canvas.toDataURL());
  }, [originalImage, filters]);

  useEffect(() => {
    applyFilters();
  }, [applyFilters]);

  // --- OMR & OCR ENGINE ---

  const getRegionDarkness = (ctx, canvasW, canvasH, xPct, yPct, wPct, hPct) => {
    const x = Math.floor((xPct / 100) * canvasW);
    const y = Math.floor((yPct / 100) * canvasH);
    const w = Math.floor((wPct / 100) * canvasW);
    const h = Math.floor((hPct / 100) * canvasH);

    if (w <= 0 || h <= 0) return 255;

    const region = ctx.getImageData(x, y, w, h).data;
    let totalPixelCount = 0;
    let blackPixelCount = 0;

    // Karena gambar sudah Binary (Hitam Putih) berkat filter,
    // Kita hanya perlu menghitung persentase pixel hitam.
    for (let i = 0; i < region.length; i += 4) {
      // Ambil channel merah saja (karena B&W, r=g=b)
      if (region[i] < 100) { // Hitam
        blackPixelCount++;
      }
      totalPixelCount++;
    }
    
    // Kembalikan persentase kegelapan (0 - 100)
    // Semakin tinggi = semakin hitam/bulat
    return totalPixelCount > 0 ? (blackPixelCount / totalPixelCount) * 100 : 0;
  };

  const executeScan = async () => {
    if (!previewCanvasRef.current) return;
    setIsProcessing(true);
    setProcessingStep("Menganalisis Jawaban...");

    const canvas = previewCanvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const width = canvas.width;
    const height = canvas.height;

    // 1. Read Answers (OMR)
    // Koordinat disesuaikan dengan Layout LJK (1).jpg yang umum
    // Kolom 1 (No 1-10): X ~ 5%, Y ~ 78% (Berdasarkan visual user sebelumnya, tapi sepertinya LJK user ada di bawah)
    // Mari kita perbaiki koordinat berdasarkan gambar LJK user.
    // Gambar user: Jawaban ada di bawah, 5 blok kolom.
    // Header Nama ada di tengah.
    
    const answerZones = [
      { startQ: 1, x: 4.8, y: 78 },   // Kolom 1
      { startQ: 11, x: 23.8, y: 78 }, // Kolom 2
      { startQ: 21, x: 42.8, y: 78 }, // Kolom 3
      { startQ: 31, x: 61.8, y: 78 }, // Kolom 4
      { startQ: 41, x: 81.0, y: 78 }, // Kolom 5
    ];
    
    const detectedAnswers = {};
    const rowHeight = 1.55; // Jarak antar nomor vertikal
    const optWidth = 2.5;   // Jarak antar opsi (A ke B)

    // Threshold sensitivitas untuk pixel hitam (Binary Image)
    // Jika lebih dari 35% area kotak itu hitam, dianggap dibulat
    const fillThreshold = 35; 

    answerZones.forEach((zone) => {
      for (let i = 0; i < 10; i++) {
        const qNum = zone.startQ + i;
        let bestOption = null;
        let maxDarkness = 0; // Cari yang paling hitam
        
        options.forEach((opt, optIdx) => {
          // Koordinat opsi
          const x = zone.x + 2.5 + optIdx * optWidth;
          const y = zone.y + i * rowHeight;
          
          // Cek area kecil di tengah bulatan
          const darknessPct = getRegionDarkness(ctx, width, height, x, y, 1.8, 1.2);
          
          if (darknessPct > maxDarkness && darknessPct > fillThreshold) {
            maxDarkness = darknessPct;
            bestOption = opt;
          }
        });
        
        if (bestOption) detectedAnswers[qNum] = bestOption;
      }
    });

    setStudentAnswers(detectedAnswers);

    // 2. OCR NAMA (Ambil dari kotak nama, bukan bulatan)
    setProcessingStep("Membaca Nama (OCR)...");
    
    // Koordinat Kotak Nama (Perkiraan dari LJK user)
    // Area: "NAMA PESERTA"
    // X: 3% s/d 55%, Y: 25% s/d 28% (Kira-kira satu baris kotak)
    const nameBoxX = Math.floor(width * 0.03);
    const nameBoxY = Math.floor(height * 0.245);
    const nameBoxW = Math.floor(width * 0.55);
    const nameBoxH = Math.floor(height * 0.05);

    // Crop area nama untuk ditampilkan ke user (Human Verification)
    const nameCanvas = document.createElement('canvas');
    nameCanvas.width = nameBoxW;
    nameCanvas.height = nameBoxH;
    const nameCtx = nameCanvas.getContext('2d');
    nameCtx.drawImage(canvas, nameBoxX, nameBoxY, nameBoxW, nameBoxH, 0, 0, nameBoxW, nameBoxH);
    
    const nameDataUrl = nameCanvas.toDataURL();
    setNameCrop(nameDataUrl);

    let scannedText = "SISWA TANPA NAMA";

    if (tesseractReady && window.Tesseract) {
      try {
        // Gunakan Tesseract pada potongan gambar nama
        // Kita whitelist karakter agar lebih akurat (Hanya huruf kapital dan spasi)
        const result = await window.Tesseract.recognize(nameDataUrl, 'eng', {
          logger: m => console.log(m),
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ' 
        });
        
        const cleanText = result.data.text.replace(/[^A-Z ]/g, '').trim();
        if (cleanText.length > 2) {
          scannedText = cleanText;
        }
      } catch (err) {
        console.error("OCR Failed", err);
      }
    }

    // Fallback: Jika OCR gagal total atau kosong, coba baca bulatan nama (backup)
    if (scannedText === "SISWA TANPA NAMA") {
       // Logika baca bulatan nama (seperti kode lama) bisa ditaruh sini
       // Tapi demi performa, kita pakai hasil OCR dulu, user bisa edit nanti.
    }

    setStudentName(scannedText);
    setIsProcessing(false);
    setScanStage('result');
  };

  // --- CAMERA & INPUT HANDLERS ---

  const startCamera = async () => {
    setIsCameraOpen(true);
    setCameraError(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError("Browser tidak mendukung kamera.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      if (videoRef.current) videoRef.current.srcObject = stream;
      streamRef.current = stream;
    } catch (err) {
      setCameraError("Gagal akses kamera. Gunakan upload file.");
    }
  };

  const stopCamera = () => {
    setIsCameraOpen(false);
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
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
        setScanStage('preview');
        stopCamera();
      };
      img.src = canvas.toDataURL();
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          setOriginalImage(img);
          setScanStage('preview');
        };
        img.src = event.target.result;
      };
      reader.readAsDataURL(file);
    }
  };

  // --- OTHER LOGIC ---

  const handleBubbleClick = (qNum, option) => {
    if (mode === "key") {
      setAnswerKey((prev) => {
        const newKey = { ...prev };
        if (newKey[qNum] === option) delete newKey[qNum];
        else newKey[qNum] = option;
        return newKey;
      });
    } else if (scanStage === 'result') {
      setStudentAnswers((prev) => ({ ...prev, [qNum]: option }));
    }
  };

  const calculateStats = useMemo(() => {
    let correct = 0, wrong = 0, empty = 0;
    questions.forEach((q) => {
      const key = answerKey[q];
      const ans = studentAnswers[q];
      if (!key) return;
      if (!ans) empty++;
      else if (ans === key) correct++;
      else wrong++;
    });
    const totalKeyed = Object.keys(answerKey).length;
    const score = totalKeyed > 0 ? Math.round((correct / totalKeyed) * 100) : 0;
    return { correct, wrong, empty, score, totalKeyed };
  }, [answerKey, studentAnswers]);

  const saveToHistory = () => {
    if (!studentName.trim()) return alert("Nama Siswa wajib diisi!");
    const newEntry = {
      id: Date.now(),
      timestamp: new Date().toLocaleString(),
      name: studentName,
      className: className || "Tanpa Kelas",
      stats: calculateStats,
      answers: studentAnswers,
    };
    setHistory((prev) => [newEntry, ...prev]);
    setScanStage('capture');
    setStudentName("");
    setStudentAnswers({});
    setOriginalImage(null);
    alert("Data tersimpan!");
  };

  const downloadCSV = () => {
     // ... (Kode CSV sama seperti sebelumnya)
     if (history.length === 0) return alert("Belum ada data.");
     const headers = ["No", "Waktu", "Nama", "Kelas", "Nilai", "Benar", "Salah", "Kosong"];
     const rows = history.map((item, index) => [
       index + 1, `"${item.timestamp}"`, `"${item.name}"`, `"${item.className}"`,
       item.stats.score, item.stats.correct, item.stats.wrong, item.stats.empty
     ]);
     const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
     const link = document.createElement("a");
     link.href = URL.createObjectURL(new Blob([csvContent], { type: "text/csv;charset=utf-8;" }));
     link.download = `Nilai_${className}_${Date.now()}.csv`;
     link.click();
  };

  // --- UI SUB-COMPONENTS ---

  const renderEditor = () => (
    <div className="fixed inset-0 z-50 bg-gray-900 flex flex-col">
      {/* Header Editor */}
      <div className="px-4 py-3 bg-gray-800 border-b border-gray-700 flex justify-between items-center text-white">
        <h3 className="font-bold flex items-center gap-2">
          <Edit3 className="w-4 h-4 text-indigo-400" /> Editor Scan
        </h3>
        <button onClick={() => setScanStage('capture')} className="text-gray-400 hover:text-white">
          <XCircle className="w-6 h-6" />
        </button>
      </div>

      {/* Canvas Preview Area */}
      <div className="flex-1 relative overflow-auto bg-black flex items-center justify-center p-4">
        <canvas 
          ref={previewCanvasRef} 
          className="max-w-full max-h-full shadow-2xl border border-gray-700" 
        />
        {isProcessing && (
           <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center z-10 text-white">
             <RefreshCw className="w-12 h-12 animate-spin text-indigo-500 mb-4" />
             <p className="text-lg font-bold animate-pulse">{processingStep}</p>
           </div>
        )}
      </div>

      {/* Toolbar Filter (Google Drive Style) */}
      <div className="bg-gray-800 p-4 pb-8 border-t border-gray-700">
        <div className="max-w-md mx-auto space-y-4">
          
          {/* Mode Selector */}
          <div className="flex justify-center gap-2 mb-2">
             {['original', 'grayscale', 'binary'].map(m => (
               <button 
                key={m}
                onClick={() => setFilters(f => ({...f, mode: m}))}
                className={`px-3 py-1 rounded-full text-xs font-bold capitalize ${filters.mode === m ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-gray-300'}`}
               >
                 {m}
               </button>
             ))}
          </div>

          {/* Sliders */}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Settings className="w-4 h-4 text-gray-400" />
              <span className="text-xs text-gray-400 w-16">Threshold</span>
              <input 
                type="range" min="0" max="255" 
                value={filters.threshold}
                onChange={(e) => setFilters(f => ({...f, threshold: Number(e.target.value)}))}
                className="flex-1 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-indigo-500"
              />
              <span className="text-xs text-white w-8 text-right">{filters.threshold}</span>
            </div>
          </div>

          <div className="flex gap-3 mt-4">
            <button 
              onClick={executeScan}
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white py-3 rounded-lg font-bold flex justify-center items-center gap-2"
            >
              <Check className="w-5 h-5" /> Proses LJK
            </button>
          </div>
          <p className="text-[10px] text-gray-500 text-center">
            Tips: Geser threshold sampai bulatan terlihat hitam pekat & latar bersih.
          </p>
        </div>
      </div>
    </div>
  );

  const renderResult = () => (
    <div className="space-y-6">
      {/* 1. Identitas & Skor */}
      <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm flex flex-col md:flex-row gap-6">
        
        {/* OCR Correction Section */}
        <div className="flex-1 space-y-4">
          <div>
             <label className="text-xs font-bold text-gray-500 uppercase mb-1 flex items-center gap-2">
                <Type className="w-3 h-3" /> Nama Siswa (Edit jika salah)
             </label>
             {/* Tampilkan potongan gambar nama untuk referensi */}
             {nameCrop && (
               <div className="mb-2 border border-indigo-100 rounded overflow-hidden bg-gray-50">
                 <img src={nameCrop} alt="Crop Nama" className="h-10 object-contain mx-auto opacity-80" />
               </div>
             )}
             <div className="flex gap-2">
               <input 
                  type="text" 
                  value={studentName} 
                  onChange={(e) => setStudentName(e.target.value.toUpperCase())}
                  className="flex-1 border-2 border-indigo-100 rounded-lg px-3 py-2 font-bold text-gray-800 focus:border-indigo-500 outline-none"
               />
               <button onClick={() => setScanStage('preview')} className="p-2 bg-gray-100 rounded-lg text-gray-600 hover:bg-gray-200">
                 <RotateCcw className="w-5 h-5" />
               </button>
             </div>
          </div>

          <div className="flex gap-3">
            <div className="flex-1 bg-gray-50 p-3 rounded-lg border text-center">
               <div className="text-xs text-gray-500">Kelas</div>
               <input 
                  value={className}
                  onChange={e => setClassName(e.target.value)}
                  placeholder="-"
                  className="w-full bg-transparent text-center font-bold outline-none"
               />
            </div>
            <div className={`flex-1 p-3 rounded-lg border text-center ${calculateStats.score >= 75 ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
               <div className="text-xs opacity-70">Nilai</div>
               <div className="text-2xl font-bold">{calculateStats.score}</div>
            </div>
          </div>

          <button onClick={saveToHistory} className="w-full bg-indigo-600 text-white py-3 rounded-lg font-bold shadow-md hover:bg-indigo-700 flex justify-center items-center gap-2">
            <Save className="w-4 h-4" /> Simpan ke Riwayat
          </button>
        </div>

        {/* Quick Stats */}
        <div className="flex flex-col justify-center gap-2 text-sm min-w-[150px]">
           <div className="flex justify-between p-2 bg-green-50 rounded text-green-800">
             <span>Benar</span> <span className="font-bold">{calculateStats.correct}</span>
           </div>
           <div className="flex justify-between p-2 bg-red-50 rounded text-red-800">
             <span>Salah</span> <span className="font-bold">{calculateStats.wrong}</span>
           </div>
           <div className="flex justify-between p-2 bg-gray-100 rounded text-gray-600">
             <span>Kosong</span> <span className="font-bold">{calculateStats.empty}</span>
           </div>
        </div>
      </div>

      {/* 2. Detail Jawaban Grid */}
      <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
        <h3 className="font-bold text-gray-700 mb-4 border-b pb-2">Detail Jawaban</h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {renderAnswerGrid()}
        </div>
      </div>
    </div>
  );

  const renderAnswerGrid = () => {
    const cols = [];
    for(let i=0; i<5; i++){
      const start = i*10;
      const end = start+10;
      cols.push(
        <div key={i} className="border rounded p-2 bg-gray-50">
           {questions.slice(start, end).map(q => {
             const sAns = studentAnswers[q];
             const kAns = answerKey[q];
             let statusColor = "text-gray-400";
             if(sAns && kAns) statusColor = sAns === kAns ? "text-green-600" : "text-red-500";
             
             return (
               <div key={q} className="flex items-center justify-between text-xs mb-1.5">
                 <span className="w-5 font-mono text-gray-500">{q}.</span>
                 <div className="flex gap-0.5">
                   {options.map(opt => {
                     const isSelected = sAns === opt;
                     const isKey = kAns === opt;
                     let bg = "bg-white border-gray-300 text-gray-300";
                     
                     // Logika pewarnaan hasil
                     if (mode === 'key') {
                       if(isKey) bg = "bg-blue-600 border-blue-600 text-white";
                     } else {
                       if(isKey && isSelected) bg = "bg-green-500 border-green-500 text-white";
                       else if(isSelected && !isKey) bg = "bg-red-500 border-red-500 text-white";
                       else if(isKey && !isSelected) bg = "bg-green-100 border-green-300 text-green-600"; // Kunci tapi ga dijawab
                     }

                     return (
                       <div 
                        key={opt} 
                        onClick={() => handleBubbleClick(q, opt)}
                        className={`w-5 h-5 rounded-full border flex items-center justify-center font-bold cursor-pointer ${bg}`}
                       >
                         {opt}
                       </div>
                     )
                   })}
                 </div>
               </div>
             )
           })}
        </div>
      )
    }
    return cols;
  };

  // --- MAIN RENDER ---

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-800 pb-20">
      
      {/* GLOBAL OVERLAYS */}
      {scanStage === 'preview' && renderEditor()}
      
      {isCameraOpen && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col">
          <div className="absolute top-0 w-full p-4 flex justify-between z-10">
             <button onClick={stopCamera} className="p-2 bg-black/50 rounded-full text-white"><XCircle/></button>
          </div>
          <div className="flex-1 relative bg-black flex items-center justify-center">
             <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover opacity-80"></video>
             {/* Frame LJK Guide */}
             <div className="absolute inset-0 pointer-events-none border-[2rem] border-black/50">
                <div className="w-full h-full border-2 border-green-400 opacity-70 relative">
                  <div className="absolute top-2 left-2 bg-green-500 text-black text-[10px] font-bold px-2 rounded">AREA LJK</div>
                </div>
             </div>
             {cameraError && (
               <div className="absolute p-6 bg-gray-900 text-white rounded-xl text-center">
                 <AlertTriangle className="mx-auto mb-2 text-yellow-500"/>
                 <p>{cameraError}</p>
                 <button onClick={stopCamera} className="mt-4 px-4 py-2 bg-white text-black rounded-lg text-sm">Tutup</button>
               </div>
             )}
          </div>
          <div className="p-8 bg-black flex justify-center">
             <button onClick={capturePhoto} className="w-16 h-16 rounded-full border-4 border-white bg-white/20 active:scale-95 transition"></button>
          </div>
        </div>
      )}

      {/* HEADER */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-20 px-4 py-3 shadow-sm">
        <div className="max-w-5xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-2">
            <ScanLine className="w-6 h-6 text-indigo-600" />
            <h1 className="font-bold text-lg">LJK Scanner Pro <span className="text-xs bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded ml-1">v2.0</span></h1>
          </div>
          <div className="text-xs font-mono text-gray-500">{history.length} Data</div>
        </div>
      </header>

      {/* MAIN CONTENT */}
      <main className="max-w-5xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* SIDEBAR NAVIGATION */}
        <div className="lg:col-span-3 space-y-4">
           <div className="bg-white p-2 rounded-xl shadow-sm border border-gray-200 flex flex-col gap-1">
              <button onClick={() => setMode('key')} className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition ${mode==='key' ? 'bg-indigo-50 text-indigo-700':'hover:bg-gray-50'}`}>
                <Key className="w-4 h-4"/> Kunci Jawaban
              </button>
              <button onClick={() => setMode('scan')} className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition ${mode==='scan' ? 'bg-indigo-50 text-indigo-700':'hover:bg-gray-50'}`}>
                <ScanLine className="w-4 h-4"/> Scan & Periksa
              </button>
              <button onClick={() => setMode('history')} className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition ${mode==='history' ? 'bg-indigo-50 text-indigo-700':'hover:bg-gray-50'}`}>
                <History className="w-4 h-4"/> Riwayat Data
              </button>
           </div>
        </div>

        {/* DYNAMIC CONTENT */}
        <div className="lg:col-span-9">
          
          {/* MODE: KUNCI JAWABAN */}
          {mode === 'key' && (
             <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
               <div className="flex justify-between items-center mb-6 border-b pb-4">
                 <h2 className="font-bold text-gray-800">Input Kunci Jawaban</h2>
                 <button onClick={()=> setAnswerKey({})} className="text-red-500 text-xs hover:underline">Reset Kunci</button>
               </div>
               <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                 {renderAnswerGrid()}
               </div>
             </div>
          )}

          {/* MODE: HISTORY */}
          {mode === 'history' && (
            <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm space-y-4">
               <div className="flex justify-between items-center">
                  <h2 className="font-bold">Riwayat Siswa</h2>
                  <button onClick={downloadCSV} className="flex items-center gap-1 text-xs bg-green-600 text-white px-3 py-1.5 rounded hover:bg-green-700"><Download className="w-3 h-3"/> CSV</button>
               </div>
               {history.length === 0 ? (
                 <div className="text-center py-10 text-gray-400">Belum ada data tersimpan.</div>
               ) : (
                 <div className="space-y-2">
                   {history.map(h => (
                     <div key={h.id} className="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50">
                        <div>
                          <div className="font-bold text-gray-800">{h.name}</div>
                          <div className="text-xs text-gray-500">{h.className} • {h.timestamp}</div>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="text-right">
                             <div className="text-lg font-bold text-indigo-600">{h.stats.score}</div>
                             <div className="text-[10px] text-gray-400">Nilai Akhir</div>
                          </div>
                          <button onClick={() => setHistory(prev => prev.filter(x => x.id !== h.id))} className="text-red-400 hover:bg-red-50 p-2 rounded"><Trash2 className="w-4 h-4"/></button>
                        </div>
                     </div>
                   ))}
                 </div>
               )}
            </div>
          )}

          {/* MODE: SCANNER (LANDING) */}
          {mode === 'scan' && scanStage === 'capture' && (
            <div className="bg-white p-8 rounded-xl border border-gray-200 shadow-sm text-center space-y-6">
               <div className="w-20 h-20 bg-indigo-100 rounded-full flex items-center justify-center mx-auto">
                 <ScanLine className="w-10 h-10 text-indigo-600"/>
               </div>
               <div>
                 <h2 className="text-2xl font-bold text-gray-800">Mulai Pemindaian</h2>
                 <p className="text-gray-500 mt-2 text-sm max-w-md mx-auto">
                   Pastikan LJK diletakkan di tempat terang. Gunakan filter "Binary/Threshold" di editor nanti agar hasil akurat.
                 </p>
               </div>
               <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md mx-auto">
                  <button onClick={startCamera} className="flex flex-col items-center justify-center gap-2 p-6 border-2 border-indigo-100 rounded-xl hover:border-indigo-600 hover:bg-indigo-50 transition group">
                     <Camera className="w-8 h-8 text-indigo-600 group-hover:scale-110 transition"/>
                     <span className="font-bold text-indigo-900">Kamera Langsung</span>
                  </button>
                  <button onClick={() => uploadInputRef.current.click()} className="flex flex-col items-center justify-center gap-2 p-6 border-2 border-gray-100 rounded-xl hover:border-gray-400 hover:bg-gray-50 transition group">
                     <Upload className="w-8 h-8 text-gray-600 group-hover:scale-110 transition"/>
                     <span className="font-bold text-gray-700">Upload Foto</span>
                  </button>
                  <input type="file" ref={uploadInputRef} className="hidden" accept="image/*" onChange={handleFileUpload} />
               </div>
            </div>
          )}

          {/* MODE: RESULT (AFTER SCAN) */}
          {mode === 'scan' && scanStage === 'result' && renderResult()}

        </div>
      </main>
    </div>
  );
}