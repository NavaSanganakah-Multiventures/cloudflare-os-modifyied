// Devanagari -> Roman (Latin/Hinglish) transliteration for Aarya voice transcripts.
//
// The owner speaks a Hindi/English mix ("Hinglish"). Whisper often returns the Hindi
// portions in Devanagari script, which weakens downstream intent understanding and
// repository/email search (which match Latin tokens). This module converts Devanagari
// text into a deterministic Roman (Latin) phonetic form; Latin text, digits, and
// punctuation pass through unchanged. The assistant's own replies stay in Devanagari
// (see the personas in aarya-ai.ts and aarya-fallback.ts).

const DEVANAGARI_VOWELS: Record<string, string> = {
  "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo",
  "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
};

const DEVANAGARI_CONSONANTS: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng",
  "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "ny",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
  "य": "y", "र": "r", "ल": "l", "व": "v",
  "श": "sh", "ष": "sh", "स": "s", "ह": "h",
};

const DEVANAGARI_MATRAS: Record<string, string> = {
  "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo",
  "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
};

const DEVANAGARI_SIGNS: Record<string, string> = {
  "ं": "n", "ँ": "n", "ः": "h",
};

const DEVANAGARI_DIGITS: Record<string, string> = {
  "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",
  "५": "5", "६": "6", "७": "7", "८": "8", "९": "9",
};

// Consonant + nukta (U+093C) produces distinct Hinglish phonemes.
const NUKTA_CONSONANTS: Record<string, string> = {
  "क़": "q", "ख़": "kh", "ग़": "gh", "ज़": "z", "ड़": "r", "ढ़": "rh", "फ़": "f",
};

const DEVANAGARI = /[\u0900-\u097F]/;

/** True when the string contains at least one Devanagari character. */
export function containsDevanagari(text: string): boolean {
  return DEVANAGARI.test(text);
}

/**
 * Transliterate Devanagari text into a Roman (Latin) phonetic form for Hinglish input.
 * Latin letters, digits, and punctuation are preserved. The mapping is deterministic and
 * uses ITRANS-style spellings (inherent short 'a' written out), which the downstream LLM
 * and fuzzy search both tolerate well.
 */
export function transliterateDevanagariToLatin(text: string): string {
  if (!text || !containsDevanagari(text)) return text;
  const chars = Array.from(text);
  let out = "";

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = chars[i + 1];
    const next2 = chars[i + 2];

    // Consonant + nukta (e.g. ज़ -> z).
    if (next === "़") {
      const key = ch + next;
      if (NUKTA_CONSONANTS[key]) {
        out += NUKTA_CONSONANTS[key];
        i += 1;
        const after = chars[i + 1];
        if (after && DEVANAGARI_MATRAS[after]) {
          out += DEVANAGARI_MATRAS[after];
          i += 1;
        } else if (after === "्") {
          i += 1;
        } else if (after && DEVANAGARI_SIGNS[after]) {
          out += DEVANAGARI_SIGNS[after];
          i += 1;
        } else {
          out += "a";
        }
        continue;
      }
    }

    // Irregular conjunct ज्ञ -> gya (generic consonant handling would yield jnya).
    if (ch === "ज" && next === "्" && next2 === "ञ") {
      out += "gya";
      i += 2;
      continue;
    }

    if (DEVANAGARI_CONSONANTS[ch]) {
      out += DEVANAGARI_CONSONANTS[ch];
      if (next && DEVANAGARI_MATRAS[next]) {
        out += DEVANAGARI_MATRAS[next];
        i += 1;
      } else if (next === "्") {
        // Virama suppresses the inherent vowel.
        i += 1;
      } else if (next && DEVANAGARI_SIGNS[next]) {
        out += DEVANAGARI_SIGNS[next];
        i += 1;
      } else {
        // Inherent short vowel 'a' (written out for deterministic, ITRANS-style output).
        out += "a";
      }
      continue;
    }

    if (DEVANAGARI_VOWELS[ch]) { out += DEVANAGARI_VOWELS[ch]; continue; }
    if (DEVANAGARI_MATRAS[ch]) { out += DEVANAGARI_MATRAS[ch]; continue; }
    if (DEVANAGARI_SIGNS[ch]) { out += DEVANAGARI_SIGNS[ch]; continue; }
    if (DEVANAGARI_DIGITS[ch]) { out += DEVANAGARI_DIGITS[ch]; continue; }
    if (ch === "्" || ch === "़" || ch === "\u200C" || ch === "\u200D") continue;

    // Latin letters, spaces, and punctuation pass through.
    out += ch;
  }

  return out.trim();
}
