import { useState, useEffect, useCallback } from "react";
import { collection, getDocs, doc, getDoc } from "firebase/firestore";
import { db } from "./firebase";
import { Play, ChevronLeft, Loader2, ArrowLeft } from "lucide-react";
import "./App.css";

interface Word {
  id: string;
  word: string;
  turkishMeaning?: string;
  keyword?: string;
  story?: string;
  textContent?: string;
  imageUrl?: string;
}

interface LetterGroup {
  letter: string;
  words: Word[];
}

interface Video {
  id: string;
  name: string;
  title?: string;
  videoUrl?: string;
  createdAt?: any;
}

type Screen = "splash" | "letters" | "word";

export default function App() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<Video | null>(null);
  const [letterGroups, setLetterGroups] = useState<LetterGroup[]>([]);
  const [screen, setScreen] = useState<Screen>("splash");
  const [selectedWord, setSelectedWord] = useState<Word | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingWords, setLoadingWords] = useState(false);

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

    try {
      // Load all words for this video
      const q = collection(db, "words");
      const snap = await getDocs(q);
      const allWords = snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as Word))
        .filter((w) => w.id.startsWith(video.id) || (w as any).folderId === video.id || (w as any).videoId === video.id);

      // Group by first letter
      const groups = new Map<string, Word[]>();
      for (const w of allWords) {
        const letter = (w.word?.[0] || "#").toUpperCase();
        if (!groups.has(letter)) groups.set(letter, []);
        groups.get(letter)!.push(w);
      }

      const sorted = Array.from(groups.entries())
        .map(([letter, words]) => ({ letter, words }))
        .sort((a, b) => a.letter.localeCompare(b.letter));

      setLetterGroups(sorted);
      setScreen("letters");
    } catch (e) {
      console.error("Failed to load words:", e);
    } finally {
      setLoadingWords(false);
    }
  }, []);

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
    setLetterGroups([]);
    setSelectedWord(null);
    setScreen("splash");
  }, []);

  // Extract video ID from URL
  const getEmbedUrl = (url?: string) => {
    if (!url) return null;
    const match = url.match(
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/
    );
    return match ? `https://www.youtube.com/embed/${match[1]}?autoplay=1&rel=0` : null;
  };

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
      {/* Splash: Video List */}
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
                <button
                  key={v.id}
                  className="video-card"
                  onClick={() => handleSelectVideo(v)}
                >
                  <Play size={20} />
                  <span>{v.name || v.title || v.id}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* Letters Screen */}
      {screen === "letters" && selectedVideo && (
        <div className="letters-screen">
          <div className="letters-header">
            <button className="back-btn" onClick={handleBackToSplash}>
              <ChevronLeft size={24} />
            </button>
            <div className="video-info">
              <h2>{selectedVideo.name || selectedVideo.title || "Video"}</h2>
            </div>
          </div>

          {/* Video embed */}
          {(() => {
            const embedUrl = getEmbedUrl(selectedVideo.videoUrl);
            if (!embedUrl) return null;
            return (
              <div className="video-wrapper">
                <iframe src={embedUrl} allow="autoplay; encrypted-media" allowFullScreen title="video" />
              </div>
            );
          })()}

          {/* Başla button */}
          <button
            className="start-btn"
            onClick={() => {
              const embed = document.querySelector(".video-wrapper");
              embed?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            <Play size={18} fill="currentColor" /> Başla
          </button>

          {/* Letter groups */}
          {loadingWords ? (
            <div className="loading-words">
              <Loader2 size={24} className="spin" />
            </div>
          ) : letterGroups.length === 0 ? (
            <p className="empty-text" style={{ marginTop: 24 }}>
              Henüz kelime eklenmemiş.
            </p>
          ) : (
            <div className="letter-grid">
              {letterGroups.map((g) => (
                <button
                  key={g.letter}
                  className="letter-card"
                  onClick={() => {
                    const firstWord = g.words[0];
                    if (firstWord) handleSelectWord(firstWord);
                  }}
                >
                  <span className="letter">{g.letter}</span>
                  <span className="count">{g.words.length} kelime</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Word Detail Screen */}
      {screen === "word" && selectedWord && (
        <div className="word-screen">
          <div className="word-header">
            <button className="back-btn" onClick={handleBackToLetters}>
              <ChevronLeft size={24} />
            </button>
            <h2>{selectedWord.word}</h2>
          </div>

          <div className="word-content">
            {selectedWord.imageUrl && (
              <img
                src={selectedWord.imageUrl}
                alt={selectedWord.word}
                className="word-image"
              />
            )}

            {selectedWord.textContent && (
              <div className="word-text">
                <p>{selectedWord.textContent}</p>
              </div>
            )}

            {(selectedWord.turkishMeaning || selectedWord.story) && (
              <div className="word-meta">
                {selectedWord.turkishMeaning && (
                  <div className="meta-item">
                    <span className="meta-label">Anlamı</span>
                    <span className="meta-value">{selectedWord.turkishMeaning}</span>
                  </div>
                )}
                {selectedWord.story && (
                  <div className="meta-item">
                    <span className="meta-label">Hikaye</span>
                    <span className="meta-value">{selectedWord.story}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
