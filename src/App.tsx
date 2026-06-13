import { useState, useEffect, useCallback, useRef } from "react";
import { collection, getDocs, doc, getDoc, deleteDoc } from "firebase/firestore";
import { db } from "./firebase";
import { Play, Loader2, BookOpen, ArrowLeft, RefreshCw } from "lucide-react";
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
      {/* SPLASH SCREEN */}
      {screen === "splash" && (
        <div className="splash">
          <div className="splash-header">
            <div className="splash-logo">
              <BookOpen size={28} />
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
              {/* Transcript — tek sekme, sekme yok */}
              <div className="subtitles-content" ref={transcriptRef}>
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
              {wordPopup && (
                <>
                  <div className="popup-overlay" onClick={() => setWordPopup(null)} />
                  <div className="word-popup">
                    <button className="popup-close" onClick={() => setWordPopup(null)}>✕</button>
                    <div className="popup-content">
                      <h2 className="popup-word">
                        {wordPopup.word.replace(/\s*\(.*?\)\s*/g, "")}
                      </h2>
                      {wordPopup.imageUrl && (
                        <img src={wordPopup.imageUrl} alt={wordPopup.word} className="popup-image" />
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
              )}
            </div>
          </div>
        </div>
      )}

      {/* 1. HOŞGELDİN OVERLAY'İ */}
      {showWelcome && (
        <>
          <div className="popup-overlay srs-overlay-backdrop" />
          <div className="word-popup srs-popup-container">
            <div className="popup-content" style={{ textAlign: "center", padding: "20px 10px" }}>
              <h2 className="popup-word" style={{ fontSize: "24px", marginBottom: "15px" }}>Merhaba!</h2>
              <p style={{ fontSize: "16px", marginBottom: "25px", lineHeight: "1.5" }}>
                Şu anda aktif <strong>{activeSentenceCount}</strong> adet cümlen var.
              </p>
              <p style={{ fontSize: "16px", marginBottom: "30px" }}>
                İlk cümleden başlamak ister misin?
              </p>
            </div>
            <div className="srs-action-area" style={{ display: "flex", gap: "10px", justifyContent: "center" }}>
              <button
                className="srs-next-btn"
                style={{ flex: 1, maxWidth: "150px" }}
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
                className="srs-next-btn"
                style={{ flex: 1, maxWidth: "150px", background: "#666" }}
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
        </>
      )}

      {/* 2. CÜMLE OVERLAY'İ */}
      {showSentence && (
        <>
          <div className="popup-overlay srs-overlay-backdrop" />
          <div className="word-popup srs-popup-container">
            <div className="popup-content" style={{ textAlign: "center", padding: "20px 10px" }}>
              <h2 className="popup-word" style={{ fontSize: "22px", marginBottom: "15px", color: "#3b82f6" }}>
                {activeSentence}
              </h2>
              <p style={{ fontSize: "18px", color: "#9ca3af", marginBottom: "30px", fontStyle: "italic" }}>
                {activeSentenceTrans}
              </p>
            </div>
            <div className="srs-action-area" style={{ display: "flex", justifyContent: "center" }}>
              <button
                className="srs-next-btn"
                style={{ width: "100%", maxWidth: "250px" }}
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

      {/* 3. FLASHCARD OVERLAY'İ */}
      {showFlashcards && sentenceWords.length > 0 && (
        <>
          <div className="popup-overlay srs-overlay-backdrop" />
          <div className="word-popup srs-popup-container">
            <div className="srs-header-counter">
              Kart — {sentenceWordIndex + 1} / {sentenceWords.length}
            </div>
            <div className="popup-content">
              <h2 className="popup-word">
                {sentenceWords[sentenceWordIndex].word.replace(/\s*\(.*?\)\s*/g, "")}
              </h2>
              {sentenceWords[sentenceWordIndex].imageUrl && (
                <img
                  src={sentenceWords[sentenceWordIndex].imageUrl}
                  alt={sentenceWords[sentenceWordIndex].word}
                  className="popup-image"
                />
              )}
              {sentenceWords[sentenceWordIndex].turkishMeaning && (
                <div className="popup-section">
                  <span className="popup-label">Anlamı</span>
                  <p className="popup-value">{sentenceWords[sentenceWordIndex].turkishMeaning}</p>
                </div>
              )}
              {sentenceWords[sentenceWordIndex].keyword && (
                <div className="popup-section">
                  <span className="popup-label">Anahtar Kelime</span>
                  <p className="popup-value keyword">{sentenceWords[sentenceWordIndex].keyword}</p>
                </div>
              )}
              {sentenceWords[sentenceWordIndex].story && (
                <div className="popup-section">
                  <span className="popup-label">Hikaye</span>
                  <p className="popup-value story">{sentenceWords[sentenceWordIndex].story}</p>
                </div>
              )}
            </div>
            <div className="srs-action-area">
              <button
                className="srs-next-btn"
                onClick={() => {
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
                {sentenceWordIndex + 1 === sentenceWords.length ? "Tamam" : "Next"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
