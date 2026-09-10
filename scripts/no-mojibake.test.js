import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

// Root of the repository (the parent of scripts/).
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// Mojibake markers are built from code points rather than written literally so that
// this file never trips its own scanner.
const MARKERS = {
  middleDot: String.fromCodePoint(0xc2, 0xb7),           // 'Â·' -> '·'
  cp1252: String.fromCodePoint(0xe2, 0x20ac),            // 'â€' -> '—'/'“'/'”'/'…'
  doubleRound: String.fromCodePoint(0xc3, 0xa2, 0xc2),   // 'Ã¢Â' (double-encoded)
  deepRound: String.fromCodePoint(0xc3, 0xc2),           // 'ÃÂ' (deep-encoded)
};

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".md", ".json", ".jsonc",
  ".yml", ".yaml", ".css", ".html", ".svg", ".py", ".sh",
]);

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".wrangler", ".turbo", "coverage"]);
const SKIP_FILES = new Set(["pnpm-lock.yaml"]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function isTextFile(fullPath) {
  const rel = relative(repoRoot, fullPath);
  if (SKIP_FILES.has(rel)) return false;
  if (fullPath.endsWith(".d.ts")) return false;
  if (fullPath.endsWith("worker-configuration.d.ts")) return false;
  return TEXT_EXTENSIONS.has(extname(fullPath));
}

function findMojibake(text) {
  const problems = [];
  // C1 controls (U+0080..U+009F) never legitimately appear in source text; they are
  // a tell-tale of UTF-8 bytes decoded as Latin-1.
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x80 && cp <= 0x9f) {
      problems.push("C1 U+" + cp.toString(16).padStart(4, "0"));
    }
  }
  if (text.includes(MARKERS.middleDot)) problems.push("'Â·' (mojibake of '·')");
  if (text.includes(MARKERS.cp1252)) problems.push("'â€' (mojibake of '—'/'“'/'”'/'…')");
  if (text.includes(MARKERS.doubleRound)) problems.push("'Ã¢Â' (double-encoded mojibake)");
  if (text.includes(MARKERS.deepRound)) problems.push("'ÃÂ' (deep-encoded mojibake)");
  return [...new Set(problems)];
}

describe("no mojibake in repository source files", () => {
  it("contains no C1 controls or mojibake byte sequences", () => {
    const offenders = [];
    for (const fullPath of walk(repoRoot)) {
      if (!isTextFile(fullPath)) continue;
      const text = readFileSync(fullPath, "utf8");
      const problems = findMojibake(text);
      if (problems.length > 0) {
        offenders.push(relative(repoRoot, fullPath) + ": " + problems.join(", "));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "Found mojibake in the following files:
" + offenders.map((o) => "  - " + o).join("
"),
    );
  });
});

describe("UTF-8 base64 round-trip", () => {
  it("preserves Devanagari, emoji, accents, and punctuation", () => {
    const sample = [
      "योजना हिंदी धन्यवाद",
      "🙏 🎉 👋",
      "— · → … “ ” ’",
      "─".repeat(6),
      "café naïve résumé",
    ].join(" | ");
    const encoded = Buffer.from(sample, "utf8").toString("base64");
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    assert.equal(decoded, sample);
  });
});
