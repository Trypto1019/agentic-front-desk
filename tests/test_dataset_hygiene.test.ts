import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Repository hygiene: every text file in the repo (code, docs, eval data)
 * may contain only fictional contact data and none of the private terms
 * this project was extracted from.
 *
 *  - phone numbers must be in the reserved fictional 555-01xx range
 *  - email addresses must be @example.com
 *  - no private scrub term (the list lives outside the repo so this public
 *    file never lists what it hides; set PORTFOLIO_SCRUB_TERMS to its path)
 *  - no IPv4 address other than loopback / unspecified
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".pytest_cache", ".venv", ".cache"]);
const TEXT_EXT = /\.(?:ts|js|mjs|json|jsonl|md|py|txt|yml|yaml|toml|example|cfg|ini|sh)$|^(?:LICENSE|Makefile|\.gitignore|\.env\.example)$/;

/**
 * Line format: plain = forbidden substring, "owner:" = name allowed only in
 * LICENSE, "re:" = case-insensitive regex, "#" = comment.
 */
function loadPrivateTerms(): { substrings: string[]; owner: string[]; patterns: RegExp[] } {
  const path = process.env.PORTFOLIO_SCRUB_TERMS;
  const out = { substrings: [] as string[], owner: [] as string[], patterns: [] as RegExp[] };
  if (!path || !existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("owner:")) out.owner.push(line.slice("owner:".length).toLowerCase());
    else if (line.startsWith("re:")) out.patterns.push(new RegExp(line.slice("re:".length), "i"));
    else out.substrings.push(line.toLowerCase());
  }
  return out;
}

const PRIVATE = loadPrivateTerms();

/** The owner's name is allowed only in the LICENSE copyright line. */
const OWNER_EXCEPTION_FILES = new Set(["LICENSE"]);

const PHONE = /(?<![\w.])(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?![\w.])/g;
const FICTIONAL = /^(?:\d{3}55501\d{2}|555010\d{4})$/;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (TEXT_EXT.test(name) && name !== "package-lock.json") out.push(path);
  }
  return out;
}

const files = walk(ROOT).map((path) => ({ rel: relative(ROOT, path), text: readFileSync(path, "utf8") }));

describe("dataset and repo hygiene", () => {
  it("scans a non-trivial number of files", () => {
    assert.ok(files.length > 30, `only ${files.length} files found`);
  });

  it("contains only fictional 555-01xx phone numbers", () => {
    const hits: string[] = [];
    for (const { rel, text } of files) {
      for (const m of text.matchAll(PHONE)) {
        const digits = m.slice(1, 4).join("");
        // Only formatted or E.164-looking numbers count; skip ISO dates and hex runs.
        if (!/[+()\s.-]/.test(m[0]) && !m[0].startsWith("1")) continue;
        if (!FICTIONAL.test(digits)) hits.push(`${rel}: ${m[0]}`);
      }
    }
    assert.deepEqual(hits, []);
  });

  it("uses only example.com email addresses", () => {
    const hits = files.flatMap(({ rel, text }) => [...text.matchAll(EMAIL)].filter((m) => !/(^|\.)example\.com$/i.test(m[1])).map((m) => `${rel}: ${m[0]}`));
    assert.deepEqual(hits, []);
  });

  it("contains no scrub-list term", () => {
    const hits: string[] = [];
    for (const { rel, text } of files) {
      const lower = text.toLowerCase();
      PRIVATE.substrings.forEach((term, i) => {
        if (lower.includes(term)) hits.push(`${rel}: private term #${i}`);
      });
      PRIVATE.owner.forEach((name, i) => {
        if (lower.includes(name) && !OWNER_EXCEPTION_FILES.has(rel)) hits.push(`${rel}: owner name #${i}`);
      });
      PRIVATE.patterns.forEach((re, i) => {
        if (re.test(text)) hits.push(`${rel}: private pattern #${i}`);
      });
    }
    assert.deepEqual(hits, []);
  });

  it("contains no routable IPv4 address", () => {
    const hits = files.flatMap(({ rel, text }) =>
      [...text.matchAll(IPV4)].filter((m) => !["127.0.0.1", "0.0.0.0"].includes(m[0]) && m.slice(1).every((o) => Number(o) <= 255)).map((m) => `${rel}: ${m[0]}`),
    );
    assert.deepEqual(hits, []);
  });
});
