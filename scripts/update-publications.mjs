import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_OUTFILE = "data/publications.json";
const DEFAULT_DOI_FILE = "data/publications.dois.txt";
const DEFAULT_RECORDS_FILE = "data/publications.records.json";

function uniqStrings(values) {
  const out = [];
  const seen = new Set();
  for (const v of values) {
    const s = String(v || "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function normalizeDoi(value) {
  if (!value) return null;
  let doi = String(value).trim();
  doi = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  doi = doi.replace(/v\d+$/i, "");
  return doi.toLowerCase();
}

async function readDoiFile(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    return uniqStrings(
      text
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.startsWith("#"))
        .map((line) => {
          const match = line.match(/10\.\d{4,9}\/[^\s]+/i);
          return normalizeDoi(match ? match[0] : line);
        })
        .filter(Boolean),
    );
  } catch {
    return [];
  }
}

async function readRecordsFile(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    const data = JSON.parse(text);
    return Array.isArray(data?.records) ? data.records : [];
  } catch {
    return [];
  }
}

function mergeAuthors(a = [], b = []) {
  return uniqStrings([...(a || []), ...(b || [])]);
}

function normalizeManualRecord(record) {
  const doi = normalizeDoi(record?.doi);
  const url = record?.url || (doi ? `https://doi.org/${doi}` : null);
  const pmid = record?.pmid ? String(record.pmid).trim() : null;
  const id = doi ? `DOI:${doi}` : pmid ? `PMID:${pmid}` : url ? `URL:${url}` : null;

  let venue = record?.venue || null;
  if (!venue && doi && doi.startsWith("10.1101/")) {
    venue = "bioRxiv";
  }

  return {
    id,
    source: record?.source || null,
    type: record?.type || null,
    title: record?.title || (doi ? `DOI: ${doi}` : null),
    authors: Array.isArray(record?.authors) ? record.authors.filter(Boolean) : [],
    venue,
    year: record?.year ? Number(record.year) : null,
    date: record?.date || null,
    doi,
    pmid,
    url,
  };
}

function mergeItem(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  return {
    id: existing.id || incoming.id,
    source: existing.source || incoming.source,
    type: existing.type || incoming.type,
    title: existing.title || incoming.title,
    authors: mergeAuthors(existing.authors, incoming.authors),
    venue: existing.venue || incoming.venue,
    year: existing.year || incoming.year,
    date: existing.date || incoming.date,
    doi: existing.doi || incoming.doi,
    pmid: existing.pmid || incoming.pmid,
    url: existing.url || incoming.url,
  };
}

function addOrMerge(map, item) {
  if (!item) return;
  const key = item.doi ? `DOI:${item.doi}` : item.pmid ? `PMID:${item.pmid}` : item.url ? `URL:${item.url}` : item.id;
  if (!key) return;
  const existing = map.get(key);
  map.set(key, mergeItem(existing, item));
}

async function main() {
  const outFile = process.env.OUTFILE || DEFAULT_OUTFILE;
  const doiFile = process.env.DOI_FILE || DEFAULT_DOI_FILE;
  const recordsFile = process.env.RECORDS_FILE || DEFAULT_RECORDS_FILE;

  const requiredDois = await readDoiFile(doiFile);
  const manualRecords = await readRecordsFile(recordsFile);

  const map = new Map();

  for (const record of manualRecords) {
    addOrMerge(map, normalizeManualRecord(record));
  }

  for (const doi of requiredDois) {
    const key = `DOI:${doi}`;
    if (map.has(key)) continue;
    addOrMerge(map, normalizeManualRecord({ doi }));
  }

  const items = Array.from(map.values()).filter((x) => x.title && (x.url || x.doi || x.pmid));

  items.sort((a, b) => {
    const ad = a.date || (a.year ? `${a.year}-01-01` : "");
    const bd = b.date || (b.year ? `${b.year}-01-01` : "");
    return bd.localeCompare(ad);
  });

  const out = {
    generatedAt: new Date().toISOString(),
    count: items.length,
    items,
  };

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.error(`Wrote ${out.count} items to ${outFile}`);
}

await main();
