import { useState, useEffect, useCallback, useRef } from "react";
import { collection, getDocs, doc, getDoc, deleteDoc } from "firebase/firestore";
import { db } from "./firebase";
import { Play, Loader2, BookOpen, ArrowLeft, RefreshCw, Clock, Volume2 } from "lucide-react";
import "./App.css";

declare var YT: any;

// Auto-detect language for speech synthesis based on text content
function detectSpeechLang(text: string): string {
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(text)) return 'ar';     // Arabic
  if (/[\uAC00-\uD7AF]/.test(text)) return 'ko';                                      // Korean
  if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(text)) return 'ja';       // Japanese
  if (/[\u0400-\u04FF]/.test(text)) return 'ru';                                      // Russian
  if (/[\u4E00-\u9FFF]/.test(text)) return 'zh';                                      // Chinese
  if (/[\u0E00-\u0E7F]/.test(text)) return 'th';                                      // Thai
  if (/[\u0600-\u06FF]/.test(text) && /[\u0590-\u05FF]/.test(text)) return 'he';    // Hebrew
  if (/[\u1E00-\u1EFF]/.test(text)) return 'vi';                                      // Vietnamese
  if (/^[\w\s]+$/.test(text)) return 'en';                                             // English (Latin only)
  return 'en'; // fallback
}

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

type SideTab = "subtitles";

export default function App() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<Video | null>(null);
  const [words, setWords] = useState<Word[]>([]);
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const [screen, setScreen] = useState<"splash" | "player">("splash");
  const [wordPopup, setWordPopup] = useState<Word | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingWords, setLoadingWords] = useState(false);
  const currentTimeRef = useRef(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const playerRef = useRef<any>(null);
  const pollRef = useRef<number>(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [sideTab, setSideTab] = useState<SideTab>("subtitles");

  // --- Yeni Öğrenme Akışı States ---
  const [showWelcome, setShowWelcome] = useState<boolean>(false);
  const [showSentence, setShowSentence] = useState<boolean>(false);
  const [showFlashcards, setShowFlashcards] = useState<boolean>(false);
  const [activeSentence, setActiveSentence] = useState<string>("");
  const [activeSentenceTrans, setActiveSentenceTrans] = useState<string>("");
  const [sentenceWords, setSentenceWords] = useState<Word[]>([]);
  const [sentenceWordIndex, setSentenceWordIndex] = useState<number>(0);
  const [flippedCardIndex, setFlippedCardIndex] = useState<number>(-1);
  const [audioPlayingIndex, setAudioPlayingIndex] = useState<number>(-1);
  const [wordPopupPlaying, setWordPopupPlaying] = useState<boolean>(false);
  const srsTimerRef = useRef<number>(0);

  // --- Active SRS Panel ---
  const [showActivePanel, setShowActivePanel] = useState<boolean>(false);
  const [srsActiveWords, setSrsActiveWords] = useState<{word: Word; intervalIndex: number; dueAt: number; startedAt: number}[]>([]);

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

  // Handle video deletion from Firebase
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
    setWordPopup(null);
    setSideTab("subtitles");
    setTranscriptSegments([]);

    // Reset öğrenme akışı states
    setShowWelcome(false);
    setShowSentence(false);
    setShowFlashcards(false);
    setActiveSentence("");
    setActiveSentenceTrans("");
    setSentenceWords([]);
    setSentenceWordIndex(0);

    try {
      const youtubeId = extractVideoId(video.videoUrl || "");
      
      // Load words from Firebase
      const q = collection(db, "words");
      const snap = await getDocs(q);
      const allWords = snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as Word))
        .filter((w) => {
          const wid = w.id.startsWith(youtubeId) || w.videoId === youtubeId || w.id.startsWith(video.id) || (w as any).folderId === video.id;
          return wid;
        })
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      setWords(allWords);

      // Transcript: sadece Firebase'deki publish edilmiş veriyi kullan
      let fetchedSegments: TranscriptSegment[] = [];
      try {
        if (youtubeId) {
          const ts = await getDoc(doc(db, "transcripts", youtubeId));
          if (ts.exists() && ts.data().segments?.length > 0) {
            const raw = ts.data().segments as any[];
            if (raw.some(s => typeof s.start === 'number' && s.start >= 0)) {
              fetchedSegments = raw as TranscriptSegment[];
            }
          } else {
            // Fallback: eski yapıdaki transcript
            const old = await getDoc(doc(db, "videos", video.id, "transcript", "data"));
            if (old.exists() && old.data().segments?.length > 0) {
              const raw = old.data().segments as any[];
              if (raw.some(s => typeof s.start === 'number' && s.start >= 0)) {
                fetchedSegments = raw as TranscriptSegment[];
              }
            }
          }
        }
      } catch {
        fetchedSegments = [];
      }

      setTranscriptSegments(fetchedSegments);
      setScreen("player");

      // Video seçilince hoşgeldin ekranını aç
      setShowWelcome(true);
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
          autoplay: (showWelcome || showSentence || showFlashcards) ? 0 : 1, // Herhangi bir öğrenme overlay'i varsa autoplay yapma
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
      currentTimeRef.current = 0;
      setActiveIndex(-1);
    };
  }, [screen, selectedVideo, showWelcome, showSentence, showFlashcards]);

  // Poll current time via requestAnimationFrame
  useEffect(() => {
    if (screen !== "player" || transcriptSegments.length === 0) return;

    const poll = () => {
      if (playerRef.current?.getCurrentTime) {
        try {
          const t = playerRef.current.getCurrentTime();
          currentTimeRef.current = t;

          // Aktif segment index'ini bul
          const idx = transcriptSegments.findIndex((s, i) => {
            const segStart = s.start;
            if (segStart === undefined || segStart === null) return false;
            const end = i < transcriptSegments.length - 1
              ? (transcriptSegments[i + 1].start ?? segStart + 5)
              : segStart + 5;
            return t >= segStart && t < end;
          });

          if (idx !== -1 && idx !== activeIndex) {
            setActiveIndex(idx);
          }
        } catch {}
      }
      pollRef.current = requestAnimationFrame(poll);
    };
    pollRef.current = requestAnimationFrame(poll);

    return () => {
      if (pollRef.current) cancelAnimationFrame(pollRef.current);
    };
  }, [screen, transcriptSegments, activeIndex]);

  // Active segment sıfırlama — yeni video seçilince
  useEffect(() => {
    setActiveIndex(-1);
  }, [selectedVideo]);

  // Auto-scroll transcript
  useEffect(() => {
    if (activeIndex === -1 || !transcriptRef.current) return;
    const el = transcriptRef.current.querySelector(
      `[data-seg-idx="${activeIndex}"]`
    );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [activeIndex]);

  // SRS word tracker — video oynarken aktif segment kelimelerini ekler
  useEffect(() => {
    if (screen !== "player" || !playerRef.current) return;
    const tick = () => {
      if (!playerRef.current?.getCurrentTime) { srsTimerRef.current = requestAnimationFrame(tick); return; }
      try {
        const segIdx = transcriptSegments.findIndex((s, i) => {
          const segStart = s.start;
          if (segStart === undefined) return false;
          const end = i < transcriptSegments.length - 1
            ? (transcriptSegments[i + 1].start ?? segStart + 5)
            : segStart + 5;
          return playerRef.current.getCurrentTime() >= segStart && playerRef.current.getCurrentTime() < end;
        });
        if (segIdx !== -1) {
          const segWords = getWordsForSentence(transcriptSegments[segIdx]?.text || '');
          if (segWords.length > 0) {
            setSrsActiveWords(prev => {
              const existingIds = new Set(prev.map(x => x.word.id));
              const newWords = segWords.filter(w => !existingIds.has(w.id)).map(w => ({
                word: w,
                intervalIndex: 0,
                dueAt: Date.now() + 5000,
                startedAt: Date.now()
              }));
              if (newWords.length === 0) return prev;
              return [...prev, ...newWords];
            });
          }
        }
      } catch {}
      srsTimerRef.current = requestAnimationFrame(tick);
    };
    tick();
    return () => { if (srsTimerRef.current) cancelAnimationFrame(srsTimerRef.current); };
  }, [screen, transcriptSegments, getWordsForSentence]);

  // Get words for a sentence
  const getWordsForSentence = useCallback(
    (sentenceText: string): Word[] => {
      return words.filter(
        (w) =>
          (w.sentenceText?.trim().toLowerCase() || w.word.trim().toLowerCase()) ===
          sentenceText.trim().toLowerCase()
      );
    },
    [words]
  );

  // Click segment → seek video
  const handleSegmentClick = (start?: number) => {
    if (start !== undefined && playerRef.current?.seekTo) {
      playerRef.current.seekTo(start, true);
    }
  };

  const handleSelectWord = (word: Word) => {
    setWordPopup(word);
    setWordPopupPlaying(false);
  };

  // Back to splash
  const handleBackToSplash = useCallback(() => {
    setSelectedVideo(null);
    setWords([]);
    setTranscriptSegments([]);
    setWordPopup(null);
    setScreen("splash");
    if (playerRef.current?.destroy) {
      playerRef.current.destroy();
      playerRef.current = null;
    }
  }, []);

  // Firebase'den taze veri çek (Studio'dan publish sonrası)
  const handleRefresh = useCallback(async () => {
    if (!selectedVideo) return;
    const youtubeId = extractVideoId(selectedVideo.videoUrl || "");
    setLoadingWords(true);
    try {
      // Kelimeleri yeniden çek
      const q = collection(db, "words");
      const snap = await getDocs(q);
      const allWords = snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as Word))
        .filter((w) => {
          const wid = w.id.startsWith(youtubeId) || w.videoId === youtubeId || w.id.startsWith(selectedVideo.id) || (w as any).folderId === selectedVideo.id;
          return wid;
        })
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      setWords(allWords);

      // Transcript'i yeniden çek
      let fetchedSegments: TranscriptSegment[] = [];
      let transcriptLoaded = false;
      if (youtubeId) {
        const ts = await getDoc(doc(db, "transcripts", youtubeId));
        if (ts.exists() && ts.data().segments?.length > 0) {
          const raw = ts.data().segments as any[];
          if (raw.some(s => typeof s.start === 'number' && s.start >= 0)) {
            fetchedSegments = raw as TranscriptSegment[];
            transcriptLoaded = true;
          }
        }
      }
      if (!transcriptLoaded) {
        const old = await getDoc(doc(db, "videos", selectedVideo.id, "transcript", "data"));
        if (old.exists() && old.data().segments?.length > 0) {
          const raw = old.data().segments as any[];
          if (raw.some(s => typeof s.start === 'number' && s.start >= 0)) {
            fetchedSegments = raw as TranscriptSegment[];
            transcriptLoaded = true;
          }
        }
      }

      setTranscriptSegments(fetchedSegments);
      setActiveIndex(-1);

      // Reset öğrenme akışı states
      setShowWelcome(false);
      setShowSentence(false);
      setShowFlashcards(false);
      setActiveSentence("");
      setActiveSentenceTrans("");
      setSentenceWords([]);
      setSentenceWordIndex(0);

      setShowWelcome(true);
    } catch (e) {
      console.error('Refresh error:', e);
    } finally {
      setLoadingWords(false);
    }
  }, [selectedVideo]);

  if (loading) {
    return (
      <div className="viewer-container loading-screen">
        <Loader2 size={32} className="spin" />
        <p>Yükleniyor...</p>
      </div>
    );
  }

  // Aktif cümle sayısını hesapla
  const activeSentenceCount = transcriptSegments.length;

  return (
    <div className="viewer-container">
      {/* SPLASH SCREEN — Studio iOS Style */}
      {screen === "splash" && (
        <div className="splash">
          <div className="splash-header">
            <div className="splash-logo">
              <div className="logo-icon">ع</div>
              <h1>Betax</h1>
            </div>
            <p className="splash-subtitle">Bir video seçerek kelime öğrenmeye başla</p>
          </div>
          <div className="video-list">
            {videos.length === 0 ? (
              <div className="empty-state">
                <Play size={48} className="empty-icon" />
                <p>Henüz video yok</p>
                <p className="empty-hint">Studio'dan video ekleyip yayınlayın</p>
              </div>
            ) : (
              videos.map((v) => (
                <div key={v.id} className="video-card-wrapper">
                  <button
                    className="video-card"
                    onClick={() => handleSelectVideo(v)}
                  >
                    <div className="video-card-thumb">
                      <Play size={18} />
                    </div>
                    <div className="video-card-info">
                      <span className="video-card-title">
                        {v.name || v.title || v.id}
                      </span>
                    </div>
                  </button>
                  <button
                    className="video-delete-btn"
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

      {/* PLAYER SCREEN */}
      {screen === "player" && selectedVideo && (
        <div className="player-screen">
          {/* Top bar */}
          <div className="player-topbar">
            <button onClick={handleBackToSplash} className="topbar-back">
              <ArrowLeft size={20} />
            </button>
            <div className="topbar-url">
              {selectedVideo.videoUrl || selectedVideo.name || ""}
            </div>
            <button onClick={handleRefresh} className="topbar-refresh" title="Yenile">
              <RefreshCw size={18} />
            </button>
            <button onClick={() => setShowActivePanel(v => !v)} className={`topbar-refresh ${showActivePanel ? 'active' : ''}`} title="Active Kartlar">
              <Clock size={18} />
            </button>
          </div>

          {/* Main content */}
          <div className="player-content">
            {/* LEFT: YouTube Player */}
            <div className="player-video">
              <div className="video-wrapper">
                <div className="video-aspect">
                  <div id="youtube-player" className="video-iframe"></div>
                </div>
              </div>
            </div>

            {/* RIGHT: Side Panel */}
            <div className="player-sidebar">
              {/* Active Panel — SRS sırası */}
              {showActivePanel && (
                <div className="active-panel">
                  <div className="active-panel-header">
                    <Clock size={15} />
                    <span>Active Kartlar ({srsActiveWords.length})</span>
                  </div>
                  <div className="active-panel-list">
                    {srsActiveWords.length === 0 ? (
                      <div className="empty-state small">
                        <p>Henüz aktif kart yok. Video oynadıkça kelimeler burada görünecek.</p>
                      </div>
                    ) : (
                      srsActiveWords.map((item, idx) => {
                        const w = item.word;
                        const remaining = Math.max(0, item.dueAt - Date.now());
                        const remainingStr = remaining < 1000 ? 'şimdi' :
                          remaining < 60000 ? `${Math.ceil(remaining / 1000)}sn` :
                          remaining < 3600000 ? `${Math.ceil(remaining / 60000)}dk` :
                          `${Math.ceil(remaining / 3600000)}s`;
                        return (
                          <button key={idx} className="active-card-item" onClick={() => {
                            setWordPopup(w);
                            setWordPopupPlaying(false);
                            setFlippedCardIndex(-1);
                          }}>
                            <div className="active-card-info">
                              <span className="active-card-word">{w.word.replace(/\s*\(.*?\)\s*/g, '')}</span>
                              <span className="active-card-meaning">{w.turkishMeaning}</span>
                            </div>
                            <span className={`active-card-time ${remaining < 1000 ? 'due' : ''}`}>{remainingStr}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
              {/* Transcript */}
              <div className="subtitles-content" ref={transcriptRef} style={showActivePanel ? {height:'50%'} : {}}>
                  {loadingWords ? (
                    <div className="loading-state">
                      <Loader2 size={24} className="spin" />
                    </div>
                  ) : transcriptSegments.length === 0 && words.length === 0 ? (
                    <div className="empty-state small">
                      <p>Henüz altyazı eklenmemiş.</p>
                    </div>
                  ) : (
                    <div>
                      {/* Render transcript segments */}
                      {(transcriptSegments.length > 0
                        ? transcriptSegments
                        : (() => {
                            const seen = new Set<string>();
                            const segs: {
                              text: string;
                              translation: string;
                              words: Word[];
                            }[] = [];
                            words.forEach((w) => {
                              const key =
                                w.sentenceText?.trim() || w.word.trim();
                              if (!seen.has(key)) {
                                seen.add(key);
                                segs.push({
                                  text: w.sentenceText || w.word,
                                  translation:
                                    w.sentenceTranslation || "",
                                  words: words.filter(
                                    (x) =>
                                      (x.sentenceText?.trim() ||
                                        x.word.trim()) === key
                                  ),
                                });
                              }
                            });
                            return segs;
                          })()
                      ).map((seg: any, idx: number) => {
                        const text = seg.text || "";
                        const translation = seg.translation || "";
                        const matchedWords =
                          seg.words || getWordsForSentence(text);
                        const hasWords = matchedWords.length > 0;
                        const isActive = activeIndex === idx;
                        const parts = text
                          .replace(/^>>\s*/, "")
                          .split(/(\s+)/);
                        const start = seg.start;

                        return (
                          <div
                            key={idx}
                            data-seg-idx={idx}
                            className={`subtitle-line ${
                              isActive ? "active" : ""
                            } ${!hasWords ? "no-words" : ""}`}
                            onClick={() => handleSegmentClick(start)}
                          >
                            {start !== undefined && (
                              <span className="subtitle-time">
                                {formatTime(start)}
                              </span>
                            )}
                            <div className="subtitle-texts">
                              <div className="subtitle-original">
                                {hasWords
                                  ? parts.map(
                                      (part: string, pi: number) => {
                                        if (/^\s+$/.test(part))
                                          return (
                                            <span key={pi}>
                                              {part}
                                            </span>
                                          );
                                        const clean = part
                                          .replace(
                                            /[.,!?;:'"()\-_—…\[\]{}«»]/g,
                                            ""
                                          )
                                          .trim()
                                          .toLowerCase();
                                        if (!clean)
                                          return (
                                            <span
                                              key={pi}
                                              className="text-muted"
                                            >
                                              {part}
                                            </span>
                                          );
                                        const mw = matchedWords.find(
                                          (w: Word) => {
                                            const tc = w.word
                                              .replace(
                                                /\s*\(.*?\)\s*/g,
                                                ""
                                              )
                                              .toLowerCase();
                                            const fc =
                                              w.sentenceForm?.toLowerCase();
                                            return (
                                              tc.includes(clean) ||
                                              clean.includes(tc) ||
                                              (fc &&
                                                (fc.includes(clean) ||
                                                  clean.includes(fc)))
                                            );
                                          }
                                        );
                                        if (!mw)
                                          return (
                                            <span
                                              key={pi}
                                              className="text-muted"
                                            >
                                              {part}
                                            </span>
                                          );
                                        return (
                                          <button
                                            key={pi}
                                            className="word-link"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              handleSelectWord(mw);
                                            }}
                                          >
                                            {part}
                                          </button>
                                        );
                                      }
                                    )
                                  : text}
                              </div>
                              {translation && (
                                <div className="subtitle-translation">
                                  {translation}
                                </div>
                              )}
                              {!hasWords && (
                                <span className="badge-not-created">
                                  Oluşturulmadı
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              {wordPopup && (() => {
                const pw = wordPopup;
                let pwTarget = (pw.sentenceForm && pw.sentenceForm.trim()) ? pw.sentenceForm.trim() : pw.word.replace(/\s*[\(\[].*?[\)\]]\s*/g, '').replace(/[,\/].*$/, '').trim();
                const pwPlaying = wordPopupPlaying;
                return (
                <>
                  <div className="popup-overlay" onClick={() => setWordPopup(null)} />
                  <div className="word-popup">
                    <button className="popup-close" onClick={() => setWordPopup(null)}>✕</button>
                    <div className="popup-content">
                      <div style={{display:'flex', alignItems:'center', gap:'8px', marginBottom:'12px'}}>
                        <h2 className="popup-word" style={{marginBottom:0}}>
                          {pw.word.replace(/\s*\(.*?\)\s*/g, "")}
                        </h2>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (pwPlaying) { window.speechSynthesis.cancel(); setWordPopupPlaying(false); return; }
                            setWordPopupPlaying(true);
                            const u = new SpeechSynthesisUtterance(pwTarget);
                            u.rate = 0.85; u.lang = detectSpeechLang(pwTarget);
                            u.onend = () => setWordPopupPlaying(false);
                            u.onerror = () => setWordPopupPlaying(false);
                            window.speechSynthesis.speak(u);
                          }}
                          className={`w-9 h-9 rounded-full flex items-center justify-center transition-all active:scale-90 ${pwPlaying ? 'bg-blue-500 text-white' : 'bg-blue-50 text-blue-500 hover:bg-blue-100'}`}
                          title="Telaffuzu dinle"
                        >
                          <Volume2 size={16} className={pwPlaying ? 'animate-pulse' : ''} />
                        </button>
                      </div>
                      {pw.imageUrl && (
                        <img src={pw.imageUrl} alt={pw.word} className="popup-image" />
                      )}
                      {wordPopup.turkishMeaning && (
                        <div className="popup-section">
                          <span className="popup-label">Anlamı</span>
                          <p className="popup-value">{wordPopup.turkishMeaning}</p>
                        </div>
                      )}
                      {wordPopup.keyword && (
                        <div className="popup-section">
                          <span className="popup-label">Anahtar Kelime</span>
                          <p className="popup-value keyword">{wordPopup.keyword}</p>
                        </div>
                      )}
                      {wordPopup.story && (
                        <div className="popup-section">
                          <span className="popup-label">Hikaye</span>
                          <p className="popup-value story">{wordPopup.story}</p>
                        </div>
                      )}
                      {wordPopup.sentenceText && (
                        <div className="popup-section">
                          <span className="popup-label">Cümle</span>
                          <p className="popup-value sentence">{wordPopup.sentenceText}</p>
                          {wordPopup.sentenceTranslation && (
                            <p className="popup-value sentence-trans">{wordPopup.sentenceTranslation}</p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* 1. HOŞGELDİN OVERLAY — iOS Light Style */}
      {showWelcome && (
        <>
          <div className="popup-overlay" />
          <div className="word-popup">
            <div className="welcome-content">
              <h2>Merhaba! 👋</h2>
              <p>
                Şu anda aktif <strong>{activeSentenceCount}</strong> adet cümlen var.
              </p>
              <p>İlk cümleden başlamak ister misin?</p>
              <div className="welcome-actions">
                <button
                  className="welcome-btn"
                  onClick={() => {
                    if (transcriptSegments.length > 0) {
                      setActiveSentence(transcriptSegments[0].text || "");
                      setActiveSentenceTrans(transcriptSegments[0].translation || "");
                      setShowSentence(true);
                    } else {
                      if (playerRef.current?.playVideo) {
                        playerRef.current.playVideo();
                      }
                    }
                    setShowWelcome(false);
                  }}
                >
                  Evet
                </button>
                <button
                  className="welcome-btn secondary"
                  onClick={() => {
                    setShowWelcome(false);
                    if (playerRef.current?.playVideo) {
                      playerRef.current.playVideo();
                    }
                  }}
                >
                  Hayır
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* 2. CÜMLE OVERLAY */}
      {showSentence && (
        <>
          <div className="popup-overlay" />
          <div className="word-popup">
            <div className="sentence-content">
              <h2>{activeSentence}</h2>
              <p className="translation">{activeSentenceTrans}</p>
              <button
                className="welcome-btn"
                onClick={() => {
                  const filteredWords = words.filter(
                    (w) =>
                      (w.sentenceText?.trim().toLowerCase() || w.word.trim().toLowerCase()) ===
                      activeSentence.trim().toLowerCase()
                  );
                  setSentenceWords(filteredWords);
                  setSentenceWordIndex(0);
                  setShowFlashcards(true);
                  setShowSentence(false);
                }}
              >
                Bu cümleyi öğren
              </button>
            </div>
          </div>
        </>
      )}

      {/* 3. FLASHCARD OVERLAY — Studio ReviewModal gibi flip kart + ses */}
      {showFlashcards && sentenceWords.length > 0 && (() => {
        const w = sentenceWords[sentenceWordIndex];
        const isFlipped = flippedCardIndex === sentenceWordIndex;
        const isPlaying = audioPlayingIndex === sentenceWordIndex;
        return (
          <>
            <div className="popup-overlay" />
            <div className="flip-card-wrapper">
              <div className="flip-card-counter">Kart — {sentenceWordIndex + 1} / {sentenceWords.length}</div>
              {/* 3D Flip Container */}
              <div
                className={`flip-card-inner ${isFlipped ? 'flipped' : ''}`}
                onClick={() => setFlippedCardIndex(isFlipped ? -1 : sentenceWordIndex)}
              >
                {/* FRONT FACE */}
                <div className="flip-card-face front">
                  <div className="flip-card-image-area">
                    {w.imageUrl ? (
                      <img src={w.imageUrl} alt={w.word} className="flip-card-image" />
                    ) : (
                      <div className="flip-card-no-image">
                        <p className="flip-card-prompt">{w.story?.substring(0, 80) || 'Kartı çevir'}</p>
                      </div>
                    )}
                    {/* Ses butonu — Studio ReviewModal gibi sağ üst köşede */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isPlaying) { window.speechSynthesis.cancel(); setAudioPlayingIndex(-1); return; }
                        setAudioPlayingIndex(sentenceWordIndex);
                        // Cümledeki asıl formu kullan, parantez içi okunuşu at
                        let target = (w.sentenceForm && w.sentenceForm.trim()) ? w.sentenceForm.trim() : w.word.replace(/\s*[\(\[].*?[\)\]]\s*/g, '').replace(/[,\/].*$/, '').trim();
                        const utterance = new SpeechSynthesisUtterance(target);
                        utterance.rate = 0.85;
                        utterance.lang = detectSpeechLang(target);
                        utterance.onend = () => setAudioPlayingIndex(-1);
                        utterance.onerror = () => setAudioPlayingIndex(-1);
                        window.speechSynthesis.speak(utterance);
                      }}
                      className={`absolute top-3 right-3 w-10 h-10 rounded-full flex items-center justify-center shadow-lg transition-all duration-200 active:scale-90 z-10 ${isPlaying
                        ? 'bg-blue-500 text-white'
                        : 'bg-white/80 backdrop-blur-sm text-gray-700 hover:bg-white'
                      }`}
                      title="Telaffuzu dinle"
                    >
                      <Volume2 size={18} className={isPlaying ? 'animate-pulse' : ''} />
                    </button>
                    <div className="flip-card-tap">DOKUN ÇEVİR</div>
                  </div>
                  <div className="flip-card-meaning-area">
                    <h2 className="flip-card-meaning">{w.turkishMeaning || w.word.replace(/\s*\(.*?\)\s*/g, '')}</h2>
                  </div>
                </div>
                {/* BACK FACE */}
                <div className="flip-card-face back">
                  <div className="flip-card-back-content">
                    <div className="flip-card-keyword-badge">{w.keyword || '—'}</div>
                    <p className="flip-card-story">{w.story || ''}</p>
                  </div>
                </div>
              </div>
              {/* NEXT BUTTON */}
              <button
                className="flip-card-next-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setFlippedCardIndex(-1);
                  if (sentenceWordIndex + 1 < sentenceWords.length) {
                    setSentenceWordIndex(sentenceWordIndex + 1);
                  } else {
                    setShowFlashcards(false);
                    if (playerRef.current?.playVideo) {
                      playerRef.current.playVideo();
                    }
                  }
                }}
              >
                {sentenceWordIndex + 1 === sentenceWords.length ? 'Tamam' : 'Next'}
              </button>
            </div>
          </>
        );
      })()}
    </div>
  );
}
