// Document text extraction for binary content types. Extracted text is stored alongside the
// binary body so that PDFs, images, and Office documents become searchable in the Context
// Library's keyword search and readable by agents as text instead of opaque data URIs.
//
// Extraction is best-effort: if an extractor fails (corrupt file, missing dependency, etc.),
// the document is still stored — it just won't have searchable text.

import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import { unzipSync, strFromU8 } from "fflate";
import { isTextContentType, isImageContentType, VENDOR_ID } from "./context-types.js";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.context", vendorId: VENDOR_ID,
});

// Cap stored extracted text to keep storage and search manageable.
const MAX_EXTRACTED_TEXT_CHARS = 100_000;
// Cap the auto-generated description derived from extracted text.
const EXTRACTED_DESCRIPTION_CHARS = 200;
// Soft CPU-time cap for a single async extraction (PDF, image OCR).
const EXTRACTION_TIMEOUT_MS = 15_000;

// Race an async extraction against a timeout. Returns null on timeout or error.
async function withExtractionTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  let binary = atob(base64);
  let bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function truncate(text: string): string {
  return text.length > MAX_EXTRACTED_TEXT_CHARS
    ? text.slice(0, MAX_EXTRACTED_TEXT_CHARS)
    : text;
}

// --- PDF ---

async function extractPdfTextContent(base64Body: string): Promise<string | null> {
  let bytes = base64ToUint8Array(base64Body);
  let pdf = await getDocumentProxy(bytes);
  let { text } = await extractPdfText(pdf, { mergePages: true });
  if (Array.isArray(text)) text = text.join("\n");
  return text?.trim() || null;
}

// --- Images (OCR via Workers AI) ---

async function extractImageTextContent(
  base64Body: string,
  ai: Ai,
): Promise<string | null> {
  let imageBytes = base64ToUint8Array(base64Body);
  let response = await ai.run("@cf/meta/llama-3.2-11b-vision-instruct", {
    image: imageBytes,
    prompt:
      "Extract all visible text from this image. Return only the extracted text, " +
      "preserving reading order and line breaks. If the image contains no text, " +
      "respond with an empty string.",
    max_tokens: 1000,
  }) as { response?: string };
  return response.response?.trim() || null;
}

// --- Office Open XML & OpenDocument (ZIP + XML) ---

// Decode common XML entities.
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&amp;/g, "&");
}

// Strip XML tags, decode entities, collapse whitespace into readable text.
function xmlToText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<[^>]+>/g, " ")
      .replace(/<!--[\s\S]*?-->/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

// Extract text from ZIP entries whose paths start with any of the given prefixes.
function extractFromZipArchive(
  base64Body: string,
  pathPrefixes: string[],
): string | null {
  let bytes = base64ToUint8Array(base64Body);
  let files = unzipSync(bytes);
  let parts: string[] = [];
  let names = Object.keys(files).filter(n => n.endsWith(".xml")).sort();
  for (let name of names) {
    if (pathPrefixes.some(p => name.startsWith(p))) {
      parts.push(xmlToText(strFromU8(files[name])));
    }
  }
  return parts.length > 0 ? parts.join("\n").trim() || null : null;
}

function extractDocxText(base64Body: string): string | null {
  return extractFromZipArchive(base64Body, [
    "word/document.xml",
    "word/header",
    "word/footer",
  ]);
}

function extractXlsxText(base64Body: string): string | null {
  return extractFromZipArchive(base64Body, [
    "xl/sharedStrings.xml",
    "xl/worksheets/sheet",
  ]);
}

function extractPptxText(base64Body: string): string | null {
  return extractFromZipArchive(base64Body, [
    "ppt/slides/slide",
    "ppt/notesSlides/notesSlide",
  ]);
}

function extractOdfText(base64Body: string): string | null {
  return extractFromZipArchive(base64Body, ["content.xml"]);
}

// --- Main entry point ---

export type ExtractionEnv = Pick<Cloudflare.Env, "AI">;

export async function extractDocumentText(
  contentType: string,
  body: string,
  env?: ExtractionEnv,
): Promise<string | null> {
  // Text content types are already text — no extraction needed.
  if (isTextContentType(contentType)) return null;

  let text: string | null = null;
  try {
    if (contentType === "application/pdf") {
      text = await withExtractionTimeout(
        extractPdfTextContent(body), EXTRACTION_TIMEOUT_MS);
    } else if (isImageContentType(contentType) && env?.AI) {
      text = await withExtractionTimeout(
        extractImageTextContent(body, env.AI), EXTRACTION_TIMEOUT_MS);
    } else if (
      contentType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      text = extractDocxText(body);
    } else if (
      contentType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      text = extractXlsxText(body);
    } else if (
      contentType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    ) {
      text = extractPptxText(body);
    } else if (
      contentType === "application/vnd.oasis.opendocument.text" ||
      contentType === "application/vnd.oasis.opendocument.spreadsheet" ||
      contentType === "application/vnd.oasis.opendocument.presentation"
    ) {
      text = extractOdfText(body);
    }
  } catch (err) {
    logger.warn("document text extraction failed", {
      event: "context.extraction.failed",
      contentType,
      error: err,
    });
    text = null;
  }

  return text ? truncate(text) : null;
}

// Derive a short description from extracted text for documents with no explicit description.
export function descriptionFromExtractedText(
  extractedText: string | null,
): string | null {
  if (!extractedText) return null;
  let desc = extractedText
    .slice(0, EXTRACTED_DESCRIPTION_CHARS)
    .replace(/\n+/g, " ")
    .trim();
  return desc || null;
}
