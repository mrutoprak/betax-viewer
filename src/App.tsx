import { useState, useEffect, useCallback, useRef } from "react";
import { collection, getDocs, doc, getDoc, deleteDoc } from "firebase/firestore";
import { db } from "./firebase";
import { Play, ChevronLeft, Loader2, Languages, BookOpen, ArrowLeft, Bookmark } from "lucide-react";
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

type SideTab = "subtitles" | "words" | "saved";

export default function App() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<Video | null>(null);
  const [words, setWords] = useState<Word[]>([]);
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const [screen, setScreen] = useState<"splash" | "player">("splash");
  const [selectedWord, setSelectedWord] = useState<Word | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingWords, setLoadingWords] = useState(false);
  const currentTimeRef = useRef(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const playerRef = useRef<any>(null);
  const pollRef = useRef<number>(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [sideTab, setSideTab] = useState<SideTab>("subtitles");

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
    setSelectedWord(null);
    setSideTab("subtitles");
    setTranscriptSegments([]);

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
      // Studio'dan yayınlanan transcript { text, start, translation } formatında gelir
      try {
        if (youtubeId) {
          const ts = await getDoc(doc(db, "transcripts", youtubeId));
          if (ts.exists() && ts.data().segments?.length > 0) {
            const raw = ts.data().segments as any[];
            if (raw.some(s => typeof s.start === 'number' && s.start >= 0)) {
              setTranscriptSegments(raw as TranscriptSegment[]);
            } else {
              // start değeri yoksa transcript kullanılamaz
              setTranscriptSegments([]);
            }
          } else {
            // Fallback: eski yapıdaki transcript
            const old = await getDoc(doc(db, "videos", video.id, "transcript", "data"));
            if (old.exists() && old.data().segments?.length > 0) {
              const raw = old.data().segments as any[];
              if (raw.some(s => typeof s.start === 'number' && s.start >= 0)) {
                setTranscriptSegments(raw as TranscriptSegment[]);
              } else {
                setTranscriptSegments([]);
              }
            } else {
              setTranscriptSegments([]);
            }
          }
        } else {
          setTranscriptSegments([]);
        }
      } catch {
        setTranscriptSegments([]);
      }

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
      currentTimeRef.current = 0;
      setActiveIndex(-1);
    };
  }, [screen, selectedVideo]);

  // Poll current time via requestAnimationFrame (Studio gibi)
  useEffect(() => {
    if (screen !== "player" || transcriptSegments.length === 0) return;

    const poll = () => {
      if (playerRef.current?.getCurrentTime) {
        try {
          const t = playerRef.current.getCurrentTime();
          currentTimeRef.current = t;

          // Aktif segment index'ini bul — Studio'daki mantığın aynısı
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

  // Click word → show details
  const handleSelectWord = (word: Word) => {
    setSelectedWord(word);
  };

  // Back to splash
  const handleBackToSplash = useCallback(() => {
    setSelectedVideo(null);
    setWords([]);
    setTranscriptSegments([]);
    setSelectedWord(null);
    setScreen("splash");
    if (playerRef.current?.destroy) {
      playerRef.current.destroy();
      playerRef.current = null;
    }
  }, []);

  // Get unique words for the words tab
  const uniqueWords = (() => {
    const seen = new Set<string>();
    return words.filter((w) => {
      const key = w.word.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })();

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
              {/* Tabs */}
              <div className="sidebar-tabs">
                <button
                  className={`sidebar-tab ${sideTab === "subtitles" ? "active" : ""}`}
                  onClick={() => setSideTab("subtitles")}
                >
                  <Languages size={16} />
                  Altyazılar
                </button>
                <button
                  className={`sidebar-tab ${sideTab === "words" ? "active" : ""}`}
                  onClick={() => setSideTab("words")}
                >
                  <BookOpen size={16} />
                  Sözcükler
                  {uniqueWords.length > 0 && (
                    <span className="tab-count purple">{uniqueWords.length}</span>
                  )}
                </button>
                <button
                  className={`sidebar-tab ${sideTab === "saved" ? "active" : ""}`}
                  onClick={() => setSideTab("saved")}
                >
                  <Bookmark size={16} />
                  Kaydedildi
                  <span className="tab-count green">12</span>
                </button>
              </div>

              {/* SUBTITLES TAB */}
              {sideTab === "subtitles" && (
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
              )}

              {/* WORDS TAB */}
              {sideTab === "words" && (
                <div className="words-content">
                  {loadingWords ? (
                    <div className="loading-state">
                      <Loader2 size={24} className="spin" />
                    </div>
                  ) : uniqueWords.length === 0 ? (
                    <div className="empty-state small">
                      <p>Henüz sözcük eklenmemiş.</p>
                    </div>
                  ) : selectedWord ? (
                    <div className="word-detail">
                      <button
                        className="word-detail-back"
                        onClick={() => setSelectedWord(null)}
                      >
                        <ChevronLeft size={20} />
                        <span>Sözcükler</span>
                      </button>
                      <div className="word-detail-content">
                        <h2 className="word-detail-word">
                          {selectedWord.word}
                        </h2>
                        {selectedWord.imageUrl && (
                          <img
                            src={selectedWord.imageUrl}
                            alt={selectedWord.word}
                            className="word-detail-image"
                          />
                        )}
                        {selectedWord.turkishMeaning && (
                          <div className="word-detail-section">
                            <span className="detail-label">Anlamı</span>
                            <p className="detail-value">
                              {selectedWord.turkishMeaning}
                            </p>
                          </div>
                        )}
                        {selectedWord.keyword && (
                          <div className="word-detail-section">
                            <span className="detail-label">Anahtar Kelime</span>
                            <p className="detail-value keyword">
                              {selectedWord.keyword}
                            </p>
                          </div>
                        )}
                        {selectedWord.story && (
                          <div className="word-detail-section">
                            <span className="detail-label">Hikaye</span>
                            <p className="detail-value story">
                              {selectedWord.story}
                            </p>
                          </div>
                        )}
                        {selectedWord.sentenceText && (
                          <div className="word-detail-section">
                            <span className="detail-label">Cümle</span>
                            <p className="detail-value sentence">
                              {selectedWord.sentenceText}
                            </p>
                            {selectedWord.sentenceTranslation && (
                              <p className="detail-value sentence-trans">
                                {selectedWord.sentenceTranslation}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="word-grid">
                      {uniqueWords.map((w) => (
                        <button
                          key={w.id}
                          className="word-card"
                          onClick={() => handleSelectWord(w)}
                        >
                          <span className="word-card-text">
                            {w.word.replace(/\s*\(.*?\)\s*/g, "")}
                          </span>
                          {w.turkishMeaning && (
                            <span className="word-card-meaning">
                              {w.turkishMeaning}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* SAVED TAB */}
              {sideTab === "saved" && (
                <div className="words-content">
                  <div className="empty-state small">
                    <p>Kaydedilen kelimeler</p>
                    <p className="empty-hint">Studio'dan kaydettiğiniz kelimeler burada görünecek</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
