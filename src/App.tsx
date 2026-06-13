import { useState, useEffect, useCallback, useRef } from "react";
import { collection, getDocs, doc, getDoc } from "firebase/firestore";
import { db } from "./firebase";
import { Play, ChevronLeft, Loader2, Languages } from "lucide-react";
import "./App.css";

declare var YT: any;

interface Word {
  id: string;
  word: string;
  turkishMeaning?: string;
  keyword?: string;
  story?: string;
  textContent?: string;
  imageUrl?: string;
  sentenceText?: string;
  sentenceTranslation?: string;
  sentenceForm?: string;
  order?: number;
}

interface TranscriptSegment {
  text: string;
  start?: number;
  translation: string;
}

interface Video {
  id: string;
  name: string;
  title?: string;
  videoUrl?: string;
  createdAt?: any;
}

type Screen = "splash" | "letters" | "word";

function formatTime(seconds?: number): string {
  if (seconds === undefined) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function App() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<Video | null>(null);
  const [words, setWords] = useState<Word[]>([]);
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const [screen, setScreen] = useState<Screen>("splash");
  const [selectedWord, setSelectedWord] = useState<Word | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingWords, setLoadingWords] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const playerRef = useRef<any>(null);
  const pollRef = useRef<number>(0);

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

  const handleSelectVideo = useCallback(async (video: Video) => {
    setSelectedVideo(video);
    setLoadingWords(true);
    setTranscriptSegments([]);

    try {
      const q = collection(db, "words");
      const snap = await getDocs(q);
      const allWords = snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as Word))
        .filter((w) => w.id.startsWith(video.id) || (w as any).folderId === video.id || (w as any).videoId === video.id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      setWords(allWords);

      // Load transcript
      try {
        let loaded = false;
        const youtubeId = video.videoUrl?.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/)?.[1];
        if (youtubeId) {
          const ts = await getDoc(doc(db, "transcripts", youtubeId));
          if (ts.exists() && ts.data().segments?.length > 0) {
            setTranscriptSegments(ts.data().segments);
            loaded = true;
          }
        }
        if (!loaded) {
          const old = await getDoc(doc(db, "videos", video.id, "transcript", "data"));
          if (old.exists() && old.data().segments?.length > 0) {
            setTranscriptSegments(old.data().segments);
          }
        }
      } catch {}

      setScreen("letters");
    } catch (e) {
      console.error("Failed to load words:", e);
    } finally {
      setLoadingWords(false);
    }
  }, []);

  // YouTube player — studio pattern
  useEffect(() => {
    const youtubeId = selectedVideo?.videoUrl?.match(
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/
    )?.[1];
    if (screen !== "letters" || !youtubeId) return;

    if (typeof YT === "undefined") {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(tag);
    }

    const init = () => {
      if (typeof YT === "undefined" || !YT.Player) { setTimeout(init, 500); return; }
      const container = document.getElementById("youtube-player");
      if (!container) return;
      container.innerHTML = "";
      if (playerRef.current?.destroy) playerRef.current.destroy();
      playerRef.current = new YT.Player("youtube-player", {
        videoId: youtubeId,
        width: "100%",
        height: "100%",
        playerVars: { rel: 0, autoplay: 1, playsinline: 1, controls: 1 },
      });
    };
    init();

    return () => {
      if (playerRef.current?.destroy) { playerRef.current.destroy(); playerRef.current = null; }
      setCurrentTime(0);
    };
  }, [screen, selectedVideo]);

  // Time polling
  useEffect(() => {
    if (screen !== "letters") return;
    const poll = () => {
      if (playerRef.current?.getCurrentTime) {
        try { setCurrentTime(playerRef.current.getCurrentTime()); } catch {}
      }
      pollRef.current = window.setTimeout(poll, 100);
    };
    poll();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [screen]);

  // Active segment
  const activeIndex = (() => {
    if (!transcriptSegments.length || !currentTime) return -1;
    let idx = -1;
    for (let i = 0; i < transcriptSegments.length; i++) {
      if (transcriptSegments[i].start !== undefined && currentTime >= transcriptSegments[i].start!) idx = i;
    }
    return idx;
  })();

  const getWordsForSentence = useCallback((sentenceText: string): Word[] => {
    return words.filter(w => (w.sentenceText?.trim().toLowerCase() || w.word.trim().toLowerCase()) === sentenceText.trim().toLowerCase());
  }, [words]);

  const handleSelectWord = useCallback((word: Word) => {
    setSelectedWord(word);
    setScreen("word");
  }, []);

  const handleBackToLetters = useCallback(() => {
    setSelectedWord(null);
    setScreen("letters");
  }, []);

  const handleBackToSplash = useCallback(() => {
    setSelectedVideo(null);
    setWords([]);
    setTranscriptSegments([]);
    setSelectedWord(null);
    setScreen("splash");
  }, []);

  if (loading) {
    return (
      <div className="viewer-container loading-screen">
        <Loader2 size={32} className="spin" />
        <p>Yükleniyor...</p>
      </div>
    );
  }

  return (
    <div className="viewer-container">
      {screen === "splash" && (
        <div className="splash">
          <div className="splash-header">
            <h1>Betax Viewer</h1>
            <p className="subtitle">Bir video seç</p>
          </div>
          <div className="video-list">
            {videos.length === 0 ? (
              <p className="empty-text">Henüz video yok. Studio'dan ekle.</p>
            ) : (
              videos.map((v) => (
                <button key={v.id} className="video-card" onClick={() => handleSelectVideo(v)}>
                  <Play size={20} />
                  <span>{v.name || v.title || v.id}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {screen === "letters" && selectedVideo && (
        <div className="h-full flex flex-col bg-[#0f0f0f]">
          <div className="flex-none px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-2 bg-[#0f0f0f] z-20">
            <div className="flex items-center gap-2">
              <button onClick={handleBackToSplash} className="text-gray-400 hover:text-white p-1.5 transition-colors">
                <ChevronLeft size={20} />
              </button>
              <div className="flex-1">
                <h2 className="text-white text-[15px] font-semibold">{selectedVideo.name || selectedVideo.title || ""}</h2>
              </div>
            </div>
          </div>

          <div className="flex-grow overflow-hidden">
            <div className="h-full flex gap-0">
              <div className="w-[55%] h-full flex flex-col items-center justify-center p-2 transition-all duration-300">
                <div className="w-full h-full bg-black rounded-xl overflow-hidden shadow-2xl flex items-center justify-center">
                  <div className="relative w-full" style={{ paddingTop: "56.25%" }}>
                    <div id="youtube-player" className="absolute inset-0 w-full h-full"></div>
                  </div>
                </div>
              </div>

              <div className="w-[45%] min-w-[320px] h-full bg-[#0f0f0f] border-l border-white/5 flex flex-col overflow-hidden">
                <div className="flex-none flex border-b border-white/10 bg-[#1a1a1a]">
                  <div className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[12px] font-semibold text-white">
                    <Languages size={14} />
                    Altyazılar
                  </div>
                </div>

                <div className="flex-grow overflow-y-auto">
                  {loadingWords ? (
                    <div className="flex items-center justify-center h-full"><Loader2 size={24} className="spin" /></div>
                  ) : transcriptSegments.length === 0 && words.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-gray-500 text-sm px-4">Henüz kelime eklenmemiş.</div>
                  ) : (
                    <div>
                      {(transcriptSegments.length > 0 ? transcriptSegments : (() => {
                        const seen = new Set<string>();
                        const segs: { text: string; translation: string; words: Word[] }[] = [];
                        words.forEach(w => {
                          const key = w.sentenceText?.trim() || w.word.trim();
                          if (!seen.has(key)) { seen.add(key); segs.push({ text: w.sentenceText || w.word, translation: w.sentenceTranslation || "", words: words.filter(x => (x.sentenceText?.trim() || x.word.trim()) === key) }); }
                        });
                        return segs;
                      })()).map((seg: any, idx: number) => {
                        const text = seg.text || seg.text;
                        const translation = seg.translation || "";
                        const matchedWords = seg.words || getWordsForSentence(text);
                        const hasWords = matchedWords.length > 0;
                        const isActive = activeIndex === idx;
                        const parts = text.replace(/^>>\s*/, "").split(/(\s+)/);
                        const start = seg.start;
                        return (
                          <div key={idx}
                            className={`flex items-start gap-1.5 px-3 py-1.5 border-b border-white/5 cursor-pointer hover:bg-white/5 transition-colors ${isActive ? "bg-purple-900/20 border-l-2 border-purple-500" : ""}`}
                            onClick={() => { if (start !== undefined && playerRef.current?.seekTo) playerRef.current.seekTo(start, true); }}>
                            <span className="text-[11px] text-gray-600 font-mono w-9 flex-none pt-0.5 select-none">{formatTime(start)}</span>
                            <div className="flex-1 min-w-0">
                              <div className="text-[14px] leading-relaxed">
                                {hasWords ? parts.map((part: string, pi: number) => {
                                  if (/^\s+$/.test(part)) return <span key={pi}>{part}</span>;
                                  const clean = part.replace(/[.,!?;:'"()\-_—…\[\]{}«»]/g, "").trim().toLowerCase();
                                  if (!clean) return <span key={pi} className="text-gray-500">{part}</span>;
                                  const mw = matchedWords.find((w: Word) => {
                                    const tc = w.word.replace(/\s*\(.*?\)\s*/g, "").toLowerCase();
                                    const fc = w.sentenceForm?.toLowerCase();
                                    return tc.includes(clean) || clean.includes(tc) || (fc && (fc.includes(clean) || clean.includes(fc)));
                                  });
                                  if (!mw) return <span key={pi} className="text-gray-500">{part}</span>;
                                  return <button key={pi} onClick={(e) => { e.stopPropagation(); handleSelectWord(mw); }} className="text-purple-400 font-semibold underline decoration-purple-500/30 underline-offset-2 hover:text-purple-300">{part}</button>;
                                }) : (
                                  <span className="text-gray-500 italic">{text} <span className="text-[10px] bg-red-900/30 text-red-400 px-1.5 py-0.5 rounded-full uppercase font-semibold">Oluşturulmadı</span></span>
                                )}
                              </div>
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[14px] text-gray-500 leading-relaxed">{hasWords && translation ? translation : ""}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {screen === "word" && selectedWord && (
        <div className="word-screen">
          <div className="word-header">
            <button className="back-btn" onClick={handleBackToLetters}><ChevronLeft size={24} /></button>
            <h2>{selectedWord.word}</h2>
          </div>
          <div className="word-content">
            {selectedWord.imageUrl && <img src={selectedWord.imageUrl} alt={selectedWord.word} className="word-image" />}
            {selectedWord.textContent && <div className="word-text"><p>{selectedWord.textContent}</p></div>}
            {(selectedWord.turkishMeaning || selectedWord.story) && (
              <div className="word-meta">
                {selectedWord.turkishMeaning && <div className="meta-item"><span className="meta-label">Anlamı</span><span className="meta-value">{selectedWord.turkishMeaning}</span></div>}
                {selectedWord.story && <div className="meta-item"><span className="meta-label">Hikaye</span><span className="meta-value">{selectedWord.story}</span></div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
