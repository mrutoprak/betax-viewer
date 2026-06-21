import { useState, useEffect, useCallback, useRef } from "react";
import { collection, getDocs, doc, getDoc, deleteDoc } from "firebase/firestore";
import { db } from "./firebase";
import { 
  Play, Loader2, BookOpen, ArrowLeft, RefreshCw, Volume2, 
  Sparkles, Languages, Search, ChevronRight, X, Clock, Check
} from "lucide-react";
import { generateAudio, detectTargetLang } from "./tts";
import "./App.css";

declare var YT: any;

interface Word {
  id: string;
  word: string;
  turkishMeaning?: string;
  keyword?: string;
  story?: string;
  imageUrl?: string;
  sentenceText?: string;
  sentenceTranslation?: string;
  sentenceForm?: string;
  order?: number;
  videoId?: string;
}

interface TranscriptSegment {
  text: string;
  start: number;
  duration?: number;
  translation: string;
}

interface Video {
  id: string;
  name: string;
  title?: string;
  videoUrl?: string;
  createdAt?: any;
}

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

function formatTime(seconds?: number): string {
  if (seconds === undefined) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function cleanTextOnTheFly(text: string): string {
  if (!text) return '';
  let decoded = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  
  return decoded.replace(/^[>\-\s]+/g, '').trim();
}

function getSegmentDuration(idx: number, segments: any[]): number {
  if (idx < segments.length - 1) {
    const dur = segments[idx + 1].start - segments[idx].start;
    return Math.max(1, Math.min(dur, 8));
  }
  return 4;
}

function getWordPlaybackTimes(
  sentence: string, 
  wordForm: string, 
  segmentStart: number, 
  segmentDuration: number
): { start: number; stopAt: number } {
  const defaultStop = segmentStart + segmentDuration - 0.15;
  if (!wordForm || !sentence) return { start: segmentStart, stopAt: defaultStop };

  const sentenceClean = sentence.replace(/^[>\-\s+]+/g, '');
  const cleanStr = (s: string) => s.toLowerCase().replace(/[.,!?;:'"()\-_—…\[\]{}«»]/g, '').trim();
  const cleanedSentence = cleanStr(sentenceClean);
  const cleanedWord = cleanStr(wordForm);

  if (!cleanedWord) return { start: segmentStart, stopAt: defaultStop };

  const words = cleanedSentence.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return { start: segmentStart, stopAt: defaultStop };

  let wordIdx = -1;

  // 1. Birebir eşleşme
  wordIdx = words.findIndex(w => w === cleanedWord);
  // 2. Altküme (kitap -> kitabı)
  if (wordIdx === -1) {
    wordIdx = words.findIndex(w => w.startsWith(cleanedWord) || cleanedWord.startsWith(w));
  }
  // 3. include (en gevşek)
  if (wordIdx === -1) {
    wordIdx = words.findIndex(w => w.includes(cleanedWord) || cleanedWord.includes(w));
  }

  if (wordIdx === -1) {
    return { start: segmentStart, stopAt: defaultStop };
  }

  // Karakter ağırlığına göre oran hesapla (uzun kelimeler daha çok süre kaplar)
  const totalChars = words.reduce((sum, w) => sum + w.length, 0);
  let charOffset = 0;
  for (let i = 0; i < wordIdx; i++) charOffset += words[i].length;
  const charWeightStart = charOffset / totalChars;
  const charWeightEnd = (charOffset + words[wordIdx].length) / totalChars;

  const start = segmentStart + (charWeightStart * segmentDuration);
  const stopAt = segmentStart + (charWeightEnd * segmentDuration);

  const finalStop = Math.max(start + 0.5, stopAt);
  const maxAllowed = segmentStart + segmentDuration - 0.05;

  return {
    start: Math.max(segmentStart, start),
    stopAt: Math.min(finalStop, maxAllowed)
  };
}

type SideTab = "subtitles" | "levels";

export default function App() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<Video | null>(null);
  const [words, setWords] = useState<Word[]>([]);
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const [screen, setScreen] = useState<"splash" | "player">("splash");
  const [loading, setLoading] = useState(true);
  const [loadingWords, setLoadingWords] = useState(false);
  const [sideTab, setSideTab] = useState<SideTab>("subtitles");

  // Selection states
  const [currentSegmentIdx, setCurrentSegmentIdx] = useState(-1);
  const [viewingCard, setViewingCard] = useState<Word | null>(null);

  // Subtitle Toggle States
  const [showOriginalSub, setShowOriginalSub] = useState(() => {
    const val = localStorage.getItem('betax-show-original-sub');
    return val !== 'false';
  });
  const [showTranslationSub, setShowTranslationSub] = useState(() => {
    const val = localStorage.getItem('betax-show-translation-sub');
    return val !== 'false';
  });



  const playerRef = useRef<any>(null);
  const pollRef = useRef<number>(0);
  const stopTimeRef = useRef<number | null>(null);
  const isWordPlayingRef = useRef<boolean>(false);
  const wordPlayingSegmentIdxRef = useRef<number>(-1);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Load videos from Firebase
  useEffect(() => {
    const load = async () => {
      try {
        const snap = await getDocs(collection(db, "videos"));
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Video));
        setVideos(list);
      } catch (e) {
        console.error("Failed to load videos:", e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Handle video deletion from Firebase (Admin/Creator feature or just a clean-up utility)
  const handleDeleteVideo = useCallback(async (videoId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Bu videoyu silmek istediğine emin misin?')) return;
    try {
      await deleteDoc(doc(db, 'videos', videoId));
      setVideos(prev => prev.filter(v => v.id !== videoId));
    } catch (err) {
      console.error('Failed to delete video:', err);
      window.alert('Video silinemedi.');
    }
  }, []);

  // Handle video selection
  const handleSelectVideo = useCallback(async (video: Video) => {
    setSelectedVideo(video);
    setLoadingWords(true);
    setSideTab("subtitles");
    setTranscriptSegments([]);
    setCurrentSegmentIdx(-1);

    try {
      const youtubeId = extractVideoId(video.videoUrl || "");
      
      // Load words from Firebase
      const q = collection(db, "words");
      const snap = await getDocs(q);
      const allWords = snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as Word))
        .filter((w) => {
          const wid = w.id.startsWith(youtubeId || "NONEXISTENT") || w.videoId === video.id || w.id.startsWith(video.id);
          return wid;
        })
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      
      setWords(allWords);

      // Load Transcript from Firebase (transcripts collection or old video path)
      let fetchedSegments: TranscriptSegment[] = [];
      try {
        if (youtubeId) {
          const ts = await getDoc(doc(db, "transcripts", youtubeId));
          if (ts.exists() && ts.data().segments?.length > 0) {
            const raw = ts.data().segments as any[];
            fetchedSegments = raw.map(s => ({
              text: s.text || "",
              start: s.start || 0,
              duration: s.duration,
              translation: s.translation || ""
            }));
          } else {
            const old = await getDoc(doc(db, "videos", video.id, "transcript", "data"));
            if (old.exists() && old.data().segments?.length > 0) {
              const raw = old.data().segments as any[];
              fetchedSegments = raw.map(s => ({
                text: s.text || "",
                start: s.start || 0,
                duration: s.duration,
                translation: s.translation || ""
              }));
            }
          }
        }
      } catch {
        fetchedSegments = [];
      }

      setTranscriptSegments(fetchedSegments);
      setScreen("player");

    } catch (e) {
      console.error("Failed to load words:", e);
    } finally {
      setLoadingWords(false);
    }
  }, []);

  // YouTube player setup
  useEffect(() => {
    const youtubeId = selectedVideo?.videoUrl
      ? extractVideoId(selectedVideo.videoUrl)
      : null;
    if (screen !== "player" || !youtubeId) return;

    if (typeof YT === "undefined") {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(tag);
    }

    const init = () => {
      if (typeof YT === "undefined" || !YT.Player) {
        setTimeout(init, 500);
        return;
      }
      const container = document.getElementById("youtube-player");
      if (!container) return;
      container.innerHTML = "";
      if (playerRef.current?.destroy) playerRef.current.destroy();
      playerRef.current = new YT.Player("youtube-player", {
        videoId: youtubeId,
        width: "100%",
        height: "100%",
        playerVars: {
          rel: 0,
          autoplay: 1,
          playsinline: 1,
          controls: 1,
        },
      });
    };
    init();

    return () => {
      if (playerRef.current?.destroy) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
      setCurrentSegmentIdx(-1);
    };
  }, [screen, selectedVideo]);

  // Poll current time via requestAnimationFrame
  useEffect(() => {
    if (screen !== "player" || transcriptSegments.length === 0) return;

    const poll = () => {
      if (playerRef.current?.getCurrentTime) {
        try {
          const t = playerRef.current.getCurrentTime();

          // Word segment playback limit checking
          if (isWordPlayingRef.current && stopTimeRef.current !== null && t >= stopTimeRef.current) {
            playerRef.current.pauseVideo();
            isWordPlayingRef.current = false;
            stopTimeRef.current = null;
            
            // Re-sync with correct index after pausing
            const resyncIdx = wordPlayingSegmentIdxRef.current;
            if (resyncIdx !== -1) {
              setCurrentSegmentIdx(resyncIdx);
              wordPlayingSegmentIdxRef.current = -1;
            }
          }

          // Find active segment index
          const idx = transcriptSegments.findIndex((s, i) => {
            const segStart = s.start;
            if (segStart === undefined || segStart === null) return false;
            const end = i < transcriptSegments.length - 1
              ? (transcriptSegments[i + 1].start ?? segStart + 5)
              : segStart + 5;
            return t >= segStart && t < end;
          });

          if (idx !== -1 && idx !== currentSegmentIdx && !isWordPlayingRef.current) {
            setCurrentSegmentIdx(idx);
            const el = transcriptRef.current?.querySelector(`[data-seg-idx="${idx}"]`);
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          }
        } catch {}
      }
      pollRef.current = requestAnimationFrame(poll);
    };
    pollRef.current = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(pollRef.current);
  }, [screen, transcriptSegments, currentSegmentIdx]);

  const handleSegmentClick = useCallback((start?: number) => {
    if (start !== undefined && playerRef.current?.seekTo) {
      playerRef.current.seekTo(start, true);
      playerRef.current.playVideo();
      isWordPlayingRef.current = false;
      stopTimeRef.current = null;
    }
  }, []);

  const handleWordSegmentClick = useCallback((start: number, stopAt: number, parentSegIdx: number) => {
    if (playerRef.current?.seekTo) {
      isWordPlayingRef.current = true;
      stopTimeRef.current = stopAt;
      wordPlayingSegmentIdxRef.current = parentSegIdx;
      
      playerRef.current.seekTo(start, true);
      playerRef.current.playVideo();
    }
  }, []);

  const playTTS = useCallback(async (wordText: string) => {
    // Temizlik: parantez içi okunuşları ve noktalama işaretlerini kaldır
    const cleanWord = wordText.replace(/\s*\(.*?\)\s*/g, "").replace(/[.,!?;:'"()\-_—…\[\]{}«»]/g, '').trim();
    
    // Google Cloud TTS API ile yüksek kaliteli ses (dil otomatik algılanır)
    const targetLangName = detectTargetLang(cleanWord);
    const audioDataUrl = await generateAudio(cleanWord, targetLangName);
    if (audioDataUrl) {
      const audio = new Audio(audioDataUrl);
      await audio.play();
    }
  }, []);

  if (loading) {
    return (
      <div className="w-full h-screen flex flex-col items-center justify-center gap-4 bg-[#F2F2F7]">
        <Loader2 size={32} className="animate-spin text-blue-500" />
        <p className="text-gray-400 text-sm">Yükleniyor...</p>
      </div>
    );
  }

  return (
    <div className="w-full h-screen flex flex-col bg-[#F2F2F7] select-none">
      
      {/* 1. SPLASH SCREEN — Match Studio Style exactly */}
      {screen === "splash" && (
        <div className="flex-1 flex flex-col bg-[#F2F2F7]">
          <div className="text-center py-12 px-6 pt-[calc(3rem+env(safe-area-inset-top))]">
            <div className="flex items-center justify-center gap-2.5 text-[#007AFF] mb-1.5">
              <div className="w-11 h-11 bg-[#007AFF] rounded-xl flex items-center justify-center text-white text-2xl font-extrabold shadow-md">
                ع
              </div>
              <h1 className="text-2xl font-bold text-black">Betax Viewer</h1>
            </div>
            <p className="text-gray-400 text-sm">Bir video seçerek kelime öğrenmeye başla</p>
          </div>
          <div className="flex-1 overflow-y-auto px-4 pb-8 space-y-2">
            {videos.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
                <Play size={48} className="text-gray-300" />
                <p className="text-sm font-medium">Henüz yayınlanmış video yok</p>
                <p className="text-xs text-gray-400">Studio'dan video ekleyip yayınlayın</p>
              </div>
            ) : (
              videos.map((v) => (
                <div key={v.id} className="relative flex items-center group">
                  <button
                    className="flex-1 flex items-center gap-3 bg-white border border-gray-200 hover:border-gray-300 rounded-xl p-3.5 text-left transition-all shadow-sm active:scale-[0.99]"
                    onClick={() => handleSelectVideo(v)}
                  >
                    <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center text-blue-500 shrink-0">
                      <Play size={18} fill="currentColor" />
                    </div>
                    <div className="flex-1 min-w-0 pr-6">
                      <span className="text-[15px] font-semibold text-gray-900 block truncate">
                        {v.name || v.title || v.id}
                      </span>
                    </div>
                  </button>
                  <button
                    className="absolute right-3 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-red-50 text-red-500 hover:bg-red-100 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                    onClick={(e) => handleDeleteVideo(v.id, e)}
                    title="Sil"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 2. PLAYER SCREEN — Re-designed from Scratch to match Studio exactly */}
      {screen === "player" && selectedVideo && (
        <div className="flex-1 flex flex-col h-full overflow-hidden">
          
          {/* Header */}
          <div className="flex-none flex items-center gap-2 px-4 py-2 bg-white border-b border-gray-200 h-[50px] pt-[calc(0.5rem+env(safe-area-inset-top))]">
            <button
              onClick={() => {
                setScreen("splash");
                if (playerRef.current?.destroy) playerRef.current.destroy();
              }}
              className="p-1.5 rounded-full hover:bg-gray-100 text-[#007AFF] transition-colors"
            >
              <ArrowLeft size={20} />
            </button>
            <h2 className="flex-1 text-[14px] font-bold text-gray-800 truncate text-left">
              {selectedVideo.name || selectedVideo.title}
            </h2>

          </div>

          {/* Main Workspace split */}
          <div className="flex-grow flex flex-col md:flex-row overflow-hidden bg-gray-100">
            
            {/* Left: YouTube Video Area */}
            <div className="w-full md:w-[55%] h-full flex flex-col items-center justify-center p-2 transition-all duration-300 bg-gray-100">
              <div className="w-full h-full max-w-full flex items-center justify-center">
                <div className="relative w-full overflow-hidden bg-black rounded-2xl shadow-lg border border-gray-200" style={{ aspectRatio: '16/9' }}>
                  <div id="youtube-player" className="absolute inset-0 w-full h-full"></div>

                  {/* Subtitle Toggles */}
                  <div className="absolute top-3 right-3 z-20 flex items-center gap-1.5 bg-black/50 hover:bg-black/75 px-2 py-1 rounded-lg transition-all duration-200 backdrop-blur-sm border border-white/10 select-none">
                    <button
                      onClick={() => setShowOriginalSub(prev => !prev)}
                      className={`text-[10px] md:text-[11px] font-bold px-2.5 py-0.5 rounded transition-all active:scale-95 ${
                        showOriginalSub 
                          ? 'bg-[#007AFF] text-white shadow-sm' 
                          : 'bg-white/10 text-white/60 hover:text-white hover:bg-white/20'
                      }`}
                    >
                      Orijinal
                    </button>
                    <button
                      onClick={() => setShowTranslationSub(prev => !prev)}
                      className={`text-[10px] md:text-[11px] font-bold px-2.5 py-0.5 rounded transition-all active:scale-95 ${
                        showTranslationSub 
                          ? 'bg-[#007AFF] text-white shadow-sm' 
                          : 'bg-white/10 text-white/60 hover:text-white hover:bg-white/20'
                      }`}
                    >
                      Türkçe
                    </button>
                  </div>

                  {/* Dual Subtitles Overlay */}
                  {currentSegmentIdx !== -1 && transcriptSegments[currentSegmentIdx] && (showOriginalSub || showTranslationSub) && (
                    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[90%] max-w-[800px] flex flex-col items-center justify-center pointer-events-none z-10 gap-1.5 font-sans">
                      {showOriginalSub && (
                        <div className="bg-black/75 px-3 py-1.5 rounded-md text-white font-semibold text-center text-[13px] sm:text-[15px] md:text-[18px] leading-normal shadow-md backdrop-blur-[2px] select-none">
                          {cleanTextOnTheFly(transcriptSegments[currentSegmentIdx].text)}
                        </div>
                      )}
                      
                      {showTranslationSub && transcriptSegments[currentSegmentIdx].translation && (
                        <div className="bg-black/75 px-3 py-1.5 rounded-md text-gray-200 font-medium text-center text-[11px] sm:text-[13px] md:text-[15px] leading-normal shadow-md backdrop-blur-[2px] select-none">
                          {cleanTextOnTheFly(transcriptSegments[currentSegmentIdx].translation)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Right: Sidebar */}
            <div className="w-full md:w-[45%] min-w-[320px] h-full bg-white border-l border-gray-200 flex flex-col overflow-hidden shrink-0">
              
              {/* Tabs list */}
              <div className="flex-none flex border-b border-gray-200 bg-gray-50">
                {[
                  { key: 'subtitles' as SideTab, label: 'Altyazılar', icon: <Languages size={14} /> },
                  { key: 'levels' as SideTab, label: 'Seviyeler', icon: <Search size={14} /> },
                ].map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setSideTab(tab.key)}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-[12px] font-semibold transition-all relative ${
                      sideTab === tab.key 
                        ? 'text-[#007AFF]' 
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {tab.icon}
                    {tab.label}
                    {tab.key === 'levels' && transcriptSegments.length > 0 && (
                      <span className="bg-[#007AFF] text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full ml-1 min-w-[20px] text-center">
                        {transcriptSegments.length}
                      </span>
                    )}
                    {sideTab === tab.key && (
                      <div className="absolute bottom-0 left-4 right-4 h-0.5 bg-[#007AFF] rounded-full" />
                    )}
                  </button>
                ))}
              </div>

              {/* Sidebar Content Area */}
              <div className="flex-grow overflow-hidden">
                
                {/* === TAB 1: ALTYAZILAR === */}
                {sideTab === 'subtitles' && (
                  <div className="h-full flex flex-col">
                    <div 
                      ref={transcriptRef}
                      className="flex-grow overflow-y-auto scroll-smooth px-3 py-2 space-y-1 bg-white"
                    >
                      {loadingWords ? (
                        <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                          <Loader2 size={16} className="animate-spin mr-2 text-blue-500" />
                          Altyazılar yükleniyor...
                        </div>
                      ) : transcriptSegments.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                          Henüz altyazı eklenmemiş.
                        </div>
                      ) : (
                        transcriptSegments.map((seg, idx) => {
                          const isActive = idx === currentSegmentIdx;
                          const segWords = words.filter(w => (w.sentenceText?.trim().toLowerCase() || w.word.trim().toLowerCase()) === seg.text.trim().toLowerCase());
                          const hasWords = segWords.length > 0;
                          const parts = seg.text.replace(/^>>\s*/, "").split(/(\s+)/);

                          return (
                            <div
                              key={idx}
                              data-seg-idx={idx}
                              onClick={() => handleSegmentClick(seg.start)}
                              className={`w-full p-2.5 rounded-lg transition-all duration-200 cursor-pointer border ${
                                isActive 
                                  ? 'bg-blue-50/70 border-blue-200 scale-[1.01]' 
                                  : 'border-transparent hover:bg-gray-50'
                              }`}
                            >
                              <div className="flex items-start gap-2.5">
                                <span className={`text-[11px] font-mono mt-0.5 shrink-0 ${
                                  isActive ? 'text-[#007AFF] font-bold' : 'text-gray-400'
                                }`}>
                                  {formatTime(seg.start)}
                                </span>
                                <div className="flex-1 min-w-0 text-left">
                                  <div className={`text-[13px] leading-relaxed ${
                                    isActive ? 'text-gray-900 font-semibold' : 'text-gray-700 font-medium'
                                  }`}>
                                    {hasWords ? (
                                      parts.map((part, pi) => {
                                        if (/^\s+$/.test(part)) return <span key={pi}>{part}</span>;
                                        const clean = part.replace(/[.,!?;:'"()\-_—…\[\]{}«»]/g, '').trim().toLowerCase();
                                        if (!clean) return <span key={pi} className="text-gray-400">{part}</span>;
                                        
                                        const matchedWord = segWords.find(w => {
                                          const tc = w.word.replace(/\s*\(.*?\)\s*/g, '').toLowerCase();
                                          const fc = w.sentenceForm?.toLowerCase();
                                          return tc.includes(clean) || clean.includes(tc) || (fc && (fc.includes(clean) || clean.includes(fc)));
                                        });

                                        if (!matchedWord) return <span key={pi} className="text-gray-400">{part}</span>;
                                        return (
                                          <button
                                            key={pi}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setViewingCard(matchedWord);
                                            }}
                                            className="text-[#007AFF] font-bold underline underline-offset-2 hover:text-[#0056cc] transition-colors"
                                          >
                                            {part}
                                          </button>
                                        );
                                      })
                                    ) : (
                                      cleanTextOnTheFly(seg.text)
                                    )}
                                  </div>
                                  {seg.translation && (
                                    <p className="text-[12px] text-gray-400 mt-0.5 leading-relaxed">
                                      {cleanTextOnTheFly(seg.translation)}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}

                {/* === TAB 2: SEVİYELER === */}
                {sideTab === 'levels' && (
                  <div className="h-full flex flex-col bg-gray-50">
                    <div className="flex-none px-3 py-2 border-b border-gray-200 bg-gray-100/50 flex justify-between items-center text-left">
                      <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">SEVİYE ANALİZLERİ</span>
                    </div>
                    <div 
                      className="flex-grow overflow-y-auto scroll-smooth px-3 py-3 space-y-3"
                    >
                      {transcriptSegments.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                          Yükleniyor...
                        </div>
                      ) : (
                        transcriptSegments.map((seg, idx) => {
                          const isActive = idx === currentSegmentIdx;
                          const segWords = words.filter(w => (w.sentenceText?.trim().toLowerCase() || w.word.trim().toLowerCase()) === seg.text.trim().toLowerCase());
                          // Cümle içindeki kelime sırasına göre sırala
                          const segWordList = seg.text.split(/\s+/).map(w => w.replace(/[.,!?;:'"()\-_—…\[\]{}«»]/g, '').toLowerCase().trim()).filter(w => w.length > 0);
                          const segWordsSorted = [...segWords].sort((a, b) => {
                            const wordA = (a.sentenceForm || a.word).replace(/\s*\([^)]+\)/g, '').replace(/\s*\[[^\]]+\]/g, '').replace(/[.,!?;:'"()\-_—…\[\]{}«»]/g, '').toLowerCase().trim();
                            const wordB = (b.sentenceForm || b.word).replace(/\s*\([^)]+\)/g, '').replace(/\s*\[[^\]]+\]/g, '').replace(/[.,!?;:'"()\-_—…\[\]{}«»]/g, '').toLowerCase().trim();
                            const idxA = segWordList.findIndex(w => w === wordA || w.includes(wordA) || wordA.includes(w));
                            const idxB = segWordList.findIndex(w => w === wordB || w.includes(wordB) || wordB.includes(w));
                            return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
                          });
                          const wordCount = segWords.length;

                          return (
                            <div
                              key={idx}
                              onClick={() => handleSegmentClick(seg.start)}
                              className={`w-full p-4 rounded-xl bg-white border shadow-sm transition-all duration-200 cursor-pointer text-left ${
                                isActive 
                                  ? 'border-blue-300 ring-2 ring-blue-100 scale-[1.01]' 
                                  : 'border-gray-200/60 hover:border-gray-300'
                              }`}
                            >
                              <div className="flex items-start gap-3">
                                {/* Yellow Level Number badge */}
                                <div className="text-[28px] font-extrabold text-amber-500 leading-none shrink-0 w-8 text-center pt-0.5">
                                  {idx + 1}
                                </div>
                                
                                <div className="flex-1 min-w-0">
                                  {/* Level Metadata */}
                                  <div className="flex justify-between items-center mb-1.5">
                                    <div className="flex items-center gap-2">
                                      <span className="text-[11px] font-mono text-gray-400">
                                        {formatTime(seg.start)}
                                      </span>
                                      {wordCount === 0 ? (
                                        <span className="text-[10px] text-red-600 font-bold bg-red-50 border border-red-100 px-1.5 py-0.5 rounded">
                                          Kart Yok
                                        </span>
                                      ) : (
                                        <span className="text-[10px] text-emerald-600 font-bold bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded">
                                          {wordCount} kart
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  
                                  {/* Text & Translation */}
                                  {seg.translation ? (
                                    <>
                                      <p className="text-[14px] font-medium leading-relaxed text-gray-900">
                                        {cleanTextOnTheFly(seg.translation)}
                                      </p>
                                      <p className="text-[12px] text-gray-500 mt-1 leading-relaxed border-t border-gray-100 pt-1">
                                        {cleanTextOnTheFly(seg.text)}
                                      </p>
                                    </>
                                  ) : (
                                    <p className="text-[14px] font-medium leading-relaxed text-gray-900">
                                      {cleanTextOnTheFly(seg.text)}
                                    </p>
                                  )}

                                  {/* List of generated cards inside when ACTIVE/EXPANDED */}
                                  {isActive && wordCount > 0 && (
                                    <div className="mt-4 space-y-2.5 border-t border-gray-100 pt-3">
                                      <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2 text-left">
                                        Oluşturulan Kartlar ({wordCount})
                                      </div>
                                      <div className="space-y-2">
                                        {segWordsSorted.map((card) => {
                                          const segmentDuration = getSegmentDuration(idx, transcriptSegments);
                                          const wordForm = card.sentenceForm || card.word.replace(/\s*\(.*?\)/g, '');
                                          const { start: wordTimestamp, stopAt } = getWordPlaybackTimes(seg.text, wordForm, seg.start, segmentDuration);
                                          return (
                                            <div
                                              key={card.id}
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setViewingCard(card);
                                              }}
                                              className="w-full bg-white border border-gray-200 hover:border-gray-300 shadow-sm px-4 py-3 rounded-xl flex items-center justify-between transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer"
                                            >
                                              <div className="flex flex-col min-w-0 text-left">
                                                <div className="flex items-center gap-2">
                                                  <span className="text-[14px] font-bold text-[#007AFF]">
                                                    {card.word.replace(/\s*\(.*?\)/g, '')}
                                                  </span>
                                                  {(() => {
                                                    const pron = card.word.match(/\(([^)]+)\)/)?.[1];
                                                    return pron ? <span className="text-[11px] text-gray-400 font-medium">{pron}</span> : null;
                                                  })()}
                                                </div>
                                                <span className="text-[12px] text-gray-500 mt-0.5">
                                                  {card.turkishMeaning}
                                                </span>
                                                <span 
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleWordSegmentClick(wordTimestamp, stopAt, idx);
                                                  }}
                                                  className="text-[10px] text-gray-400 font-mono mt-0.5 hover:text-[#007AFF] hover:underline cursor-pointer inline-flex items-center gap-1"
                                                  title={`Kelimenin geçtiği süreye git: ${formatTime(wordTimestamp)}`}
                                                >
                                                  <Clock size={11} className="inline mr-1" /> {formatTime(wordTimestamp)} ({Math.round((wordTimestamp - seg.start) * 10) / 10}s)
                                                </span>
                                              </div>
                                              <div className="flex items-center gap-1.5 shrink-0">
                                                <button
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleWordSegmentClick(wordTimestamp, stopAt, idx);
                                                  }}
                                                  className="w-7 h-7 bg-blue-50 hover:bg-blue-100 text-[#007AFF] rounded-full flex items-center justify-center transition-all hover:scale-105 active:scale-95 border border-blue-100/50"
                                                  title={`Kelimenin geçtiği süreye git: ${formatTime(wordTimestamp)}`}
                                                >
                                                  <Play size={10} fill="currentColor" className="ml-0.5" />
                                                </button>
                                                <ChevronRight size={16} className="text-gray-300" />
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                          })
                        )}
                    </div>
                  </div>
                )}
              </div>

            </div>

          </div>

        </div>
      )}

      {/* 3. PREMIUM 3D FLIPPING FLASHCARD MODAL — Studio matched exact UX */}
      {viewingCard && (
        <ViewingCardModal 
          card={viewingCard} 
          onClose={() => setViewingCard(null)} 
          onPlayPronunciation={playTTS} 
        />
      )}

    </div>
  );
}

/* === Sub-Component for 3D Flipping Flashcard === */
interface ViewingCardModalProps {
  card: Word;
  onClose: () => void;
  onPlayPronunciation: (word: string) => void;
}

function ViewingCardModal({ card, onClose, onPlayPronunciation }: ViewingCardModalProps) {
  const [isFlipped, setIsFlipped] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const handlePlayAudio = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsPlaying(true);
    onPlayPronunciation(card.word);
    setTimeout(() => setIsPlaying(false), 1500);
  };

  const handleFlip = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    setIsFlipped(prev => !prev);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ perspective: '1000px' }}>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/80 transition-opacity duration-300 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Main Card Container */}
      <div className="relative w-full max-w-[340px] aspect-[3/4] max-h-[85vh]">
        
        {/* Close Button absolute top-right */}
        <div className="absolute -top-14 right-0 z-50">
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-all active:scale-95"
          >
            <X size={20} />
          </button>
        </div>

        {/* 3D Flip Wrapper */}
        <div
          className="relative w-full h-full cursor-pointer"
          style={{
            transformStyle: 'preserve-3d',
            transition: 'transform 0.55s ease-in-out',
            transform: isFlipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
            willChange: 'transform',
          }}
          onClick={handleFlip}
        >

          {/* FRONT FACE */}
          <div
            className="absolute inset-0 bg-white rounded-[32px] overflow-hidden shadow-2xl flex flex-col"
            style={{ backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' }}
          >
            {/* Image area (80%) */}
            <div className="relative h-[80%] w-full bg-gray-100 flex-shrink-0">
              {card.imageUrl ? (
                <img
                  src={card.imageUrl}
                  alt="Mnemonic"
                  className="w-full h-full object-cover"
                  loading="eager"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center opacity-40 p-4">
                  <Sparkles className="mb-3 text-gray-400" size={36} strokeWidth={1} />
                  <p className="text-xs font-light text-gray-400 px-6 text-center italic leading-relaxed">
                    No image available
                  </p>
                </div>
              )}

              {/* Play Audio Button absolute on Image */}
              <button
                onClick={handlePlayAudio}
                className={`absolute top-3 right-3 w-10 h-10 rounded-full flex items-center justify-center shadow-lg transition-all duration-200 active:scale-90 z-10 ${
                  isPlaying ? 'bg-blue-500 text-white' : 'bg-white/80 backdrop-blur-sm text-gray-700 hover:bg-white'
                }`}
              >
                <Volume2 size={18} className={isPlaying ? 'animate-pulse' : ''} />
              </button>
            </div>

            {/* Turkish Meaning (20%) */}
            <div className="h-[20%] flex items-center justify-center px-4 border-t border-gray-50 bg-white">
              <h2 className="text-xl font-semibold text-gray-900 text-center leading-snug break-words">
                {card.turkishMeaning}
              </h2>
            </div>
          </div>

          {/* BACK FACE */}
          <div
            className="absolute inset-0 bg-white rounded-[32px] overflow-hidden shadow-2xl flex flex-col items-center justify-center px-6 py-8"
            style={{
              backfaceVisibility: 'hidden',
              WebkitBackfaceVisibility: 'hidden',
              transform: 'rotateY(180deg)',
            }}
          >
            {/* Pronunciation */}
            {(() => {
              const pron = card.word.match(/\(([^)]+)\)/)?.[1];
              return pron ? (
                <div className="mb-4 px-4 py-2 bg-blue-50 text-blue-700 text-sm font-bold rounded-xl border border-blue-100">
                  {pron}
                </div>
              ) : null;
            })()}

            {/* Keyword Badge */}
            <div className="inline-block px-4 py-1.5 bg-orange-50 text-orange-600 text-xs font-bold uppercase tracking-widest rounded-full mb-5 shadow-sm border border-orange-100">
              {card.keyword}
            </div>

            {/* Mnemonic Story */}
            <p className="text-[16px] text-gray-700 font-medium leading-relaxed text-center whitespace-pre-line break-words max-h-[180px] overflow-y-auto px-1">
              {card.story}
            </p>
          </div>

        </div>
      </div>
    </div>
  );
}
