const LANG_CODE_MAP: Record<string, string> = {
  Arabic: 'ar-XA',
  Korean: 'ko-KR',
  English: 'en-US',
  Turkish: 'tr-TR',
  Spanish: 'es-ES',
  German: 'de-DE',
  French: 'fr-FR',
  Russian: 'ru-RU',
};

// Studio'dakiyle aynı API key
const TTS_API_KEY = 'AIzaSyA9UMnrqaEoh5FegxlE6L6t79bjpWbGnCQ';

/**
 * Google Cloud Text-to-Speech ile ses sentezi.
 * Base64 audio data URL döndürür, başarısız olursa null.
 */
export async function generateAudio(
  text: string,
  languageName: string
): Promise<string | null> {
  const languageCode = LANG_CODE_MAP[languageName] || 'ar-XA';

  // Köşeli parantez içindeki formu temizle
  let cleanText = text;
  const bracketMatch = text.match(/\[(.*?)\]/);
  if (bracketMatch && bracketMatch[1]) {
    cleanText = bracketMatch[1].trim();
  } else {
    cleanText = text.replace(/\s*\(.*?\)\s*/g, '').trim();
  }

  if (!cleanText) return null;

  try {
    const res = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${TTS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text: cleanText },
          voice: { languageCode, name: `${languageCode}-Standard-A` },
          audioConfig: { audioEncoding: 'MP3' },
        }),
      }
    );
    if (!res.ok) {
      console.warn('TTS API error:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    if (data.audioContent) {
      return `data:audio/mp3;base64,${data.audioContent}`;
    }
    return null;
  } catch (err) {
    console.warn('TTS fetch failed:', err);
    return null;
  }
}

/** Kelime metninden targetLang'i çıkar (viewer'da "Arabic" default) */
export function detectTargetLang(text: string): string {
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(text)) return 'Arabic';
  if (/[\uAC00-\uD7AF]/.test(text)) return 'Korean';
  if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(text)) return 'Japanese';
  if (/[\u0400-\u04FF]/.test(text)) return 'Russian';
  if (/[\u2600-\u26FF\u4E00-\u9FFF]/.test(text)) return 'Chinese';
  return 'Arabic'; // viewer default Arabic
}
