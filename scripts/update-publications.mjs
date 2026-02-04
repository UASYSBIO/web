import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_AFFILIATION = "Ukrainian Institute for Systems Biology and Medicine";
const DEFAULT_OUTFILE = "data/publications.json";

function toIsoDate(dateLike) {
  if (!dateLike) return null;
  // Europe PMC typically returns YYYY-MM-DD; keep only date portion.
  const match = String(dateLike).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function normalizeItem(raw) {
  const source = raw.source === "MED" ? "PubMed" : raw.source === "PPR" ? "Preprint" : raw.source || "Unknown";
  const authors =
    raw?.authorList?.author?.map((a) => a?.fullName).filter(Boolean) ??
    (raw.authorString ? raw.authorString.split(",").map((s) => s.trim()).filter(Boolean) : []);

  const doi = raw.doi || null;
  const pmid = raw.pmid || null;
  const date = toIsoDate(raw.firstPublicationDate || raw.pubDate);
  const year = raw.pubYear ? Number(raw.pubYear) : date ? Number(date.slice(0, 4)) : null;

  const venue = raw.journalTitle || (source === "Preprint" ? "Preprint" : null);
  const url =
    doi ? `https://doi.org/${doi}` : pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : raw?.fullTextUrlList?.fullTextUrl?.[0]?.url || null;

  const id = pmid ? `PMID:${pmid}` : doi ? `DOI:${doi}` : raw.id ? `EPMC:${raw.id}` : null;

  return {
    id,
    source,
    type: raw.pubType || null,
    title: raw.title || null,
    authors,
    venue,
    year,
    date,
    doi,
    pmid,
    url,
  };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "UASYS Publications Bot (GitHub Actions)",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return res.json();
}

function buildQuery(affiliation) {
  const q = affiliation.replaceAll('"', '\\"');

  // Prefer affiliation field, but keep a fallback phrase search in case of incomplete indexing.
  // Europe PMC supports a Lucene-like syntax. Wildcards generally work on terms (not quoted phrases),
  // so we also build a token query that wildcards the last significant term.
  const stop = new Set(["and", "or", "for", "of", "the", "a", "an", "in", "to", "with"]);
  const tokens = affiliation
    .split(/[^A-Za-z0-9]+/g)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t.length >= 3)
    .filter((t) => !stop.has(t.toLowerCase()));

  let tokenQuery = null;
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    const head = tokens.slice(0, -1);
    tokenQuery = `AFF:(${head.join(" AND ")} AND ${last}*)`;
  } else if (tokens.length === 1) {
    tokenQuery = `AFF:${tokens[0]}*`;
  }

  const parts = [`AFF:"${q}"`, `"${q}"`];
  if (tokenQuery) parts.splice(1, 0, tokenQuery);
  return parts.join(" OR ");
}

function isWantedSource(item) {
  if (item.source === "MED") return true; // PubMed
  if (item.source === "PPR") {
    const title = (item.journalTitle || "").toLowerCase();
    return title.includes("biorxiv");
  }
  return false;
}

async function searchEuropePmc({ affiliation, pageSize = 1000, maxPages = 10 }) {
  const query = buildQuery(affiliation);
  const base = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";

  let cursorMark = "*";
  let page = 0;
  const all = [];

  while (page < maxPages) {
    const url = new URL(base);
    url.searchParams.set("query", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("resultType", "core");
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("cursorMark", cursorMark);
    url.searchParams.set("sort", "FIRST_PDATE_D desc");

    const data = await fetchJson(url.toString());
    const resultList = data?.resultList?.result ?? [];
    all.push(...resultList);

    const nextCursorMark = data?.nextCursorMark;
    if (!nextCursorMark || nextCursorMark === cursorMark) break;
    cursorMark = nextCursorMark;
    page += 1;

    // Stop early if the API returns fewer than pageSize results.
    if (resultList.length < pageSize) break;
  }

  return { query, results: all };
}

async function readPrevious(outFile) {
  try {
    const text = await readFile(outFile, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  const affiliation = process.env.AFFILIATION || DEFAULT_AFFILIATION;
  const outFile = process.env.OUTFILE || DEFAULT_OUTFILE;

  const previous = await readPrevious(outFile);

  let query;
  let results;
  try {
    ({ query, results } = await searchEuropePmc({ affiliation }));
  } catch (err) {
    if (previous) {
      console.error(`Failed to fetch Europe PMC; keeping existing ${outFile}.`);
      console.error(String(err?.stack || err));
      process.exit(0);
    }
    throw err;
  }

  const filtered = results.filter(isWantedSource);
  const items = filtered
    .map(normalizeItem)
    .filter((x) => x.title && x.url)
    .map((x) => ({
      ...x,
      authors: x.authors ?? [],
    }));

  // Deduplicate by id/url.
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    const key = item.id || item.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  // Sort newest first.
  deduped.sort((a, b) => {
    const ad = a.date || (a.year ? `${a.year}-01-01` : "");
    const bd = b.date || (b.year ? `${b.year}-01-01` : "");
    return bd.localeCompare(ad);
  });

  const out = {
    generatedAt: new Date().toISOString(),
    affiliation,
    query,
    count: deduped.length,
    items: deduped,
  };

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.error(`Wrote ${out.count} items to ${outFile}`);
}

await main();
