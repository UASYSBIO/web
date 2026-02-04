import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_AFFILIATION = "Ukrainian Institute for Systems Biology and Medicine";
const DEFAULT_OUTFILE = "data/publications.json";
const DEFAULT_MANUAL_FILE = "data/publications.manual.json";
const DEFAULT_STRICT_AFFILIATION = true;

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
  return doi.toLowerCase();
}

function parseAffiliationAliases(value) {
  if (!value) return [];
  return uniqStrings(String(value).split(/[|\n]/g).map((s) => s.trim()));
}

function normalizeTextForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll(/[\u2010-\u2015]/g, "-")
    .replaceAll(/[^a-z0-9]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function collectAffiliations(raw) {
  const values = [];

  // Observed/common Europe PMC JSON shapes vary; keep this intentionally defensive.
  if (typeof raw.affiliation === "string") values.push(raw.affiliation);
  if (typeof raw.authorAffiliation === "string") values.push(raw.authorAffiliation);

  const details = raw?.authorAffiliationDetailsList?.authorAffiliation;
  if (Array.isArray(details)) {
    for (const d of details) {
      if (typeof d?.affiliation === "string") values.push(d.affiliation);
      if (Array.isArray(d?.affiliation)) values.push(...d.affiliation.filter((x) => typeof x === "string"));
    }
  }

  const authors = raw?.authorList?.author;
  if (Array.isArray(authors)) {
    for (const a of authors) {
      if (typeof a?.affiliation === "string") values.push(a.affiliation);
      const aDetails = a?.authorAffiliationDetailsList?.authorAffiliation;
      if (Array.isArray(aDetails)) {
        for (const d of aDetails) {
          if (typeof d?.affiliation === "string") values.push(d.affiliation);
        }
      }
    }
  }

  return uniqStrings(values);
}

function matchesAffiliationValues(values, phrasesNormalized) {
  if (!values || values.length === 0) return { hasAffiliations: false, matched: false };
  const affNorm = values.map(normalizeTextForMatch);
  const matched = affNorm.some((a) => phrasesNormalized.some((p) => a.includes(p)));
  return { hasAffiliations: true, matched };
}

function matchesAffiliationPhrases(raw, phrasesNormalized) {
  return matchesAffiliationValues(collectAffiliations(raw), phrasesNormalized);
}

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

function dateFromParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const [y, m, d] = parts;
  if (!y) return null;
  const mm = m ? String(m).padStart(2, "0") : "01";
  const dd = d ? String(d).padStart(2, "0") : "01";
  return `${y}-${mm}-${dd}`;
}

function normalizeCrossrefItem(item, sourceLabel = "Crossref") {
  const doi = normalizeDoi(item?.DOI);
  const title = Array.isArray(item?.title) ? item.title[0] : item?.title || null;
  const authors = Array.isArray(item?.author)
    ? item.author
        .map((a) => `${a.given || ""} ${a.family || ""}`.trim())
        .filter(Boolean)
    : [];
  const venue = Array.isArray(item?.["container-title"]) ? item["container-title"][0] : item?.["container-title"] || null;

  let year = null;
  let date = null;
  if (item?.["published-print"]?.["date-parts"]?.[0]) {
    date = dateFromParts(item["published-print"]["date-parts"][0]);
  } else if (item?.["published-online"]?.["date-parts"]?.[0]) {
    date = dateFromParts(item["published-online"]["date-parts"][0]);
  } else if (item?.issued?.["date-parts"]?.[0]) {
    date = dateFromParts(item.issued["date-parts"][0]);
  }
  if (date) year = Number(date.slice(0, 4));

  const url = doi ? `https://doi.org/${doi}` : item?.URL || null;
  const id = doi ? `DOI:${doi}` : item?.URL ? `URL:${item.URL}` : null;

  return {
    id,
    source: sourceLabel,
    type: item?.type || null,
    title,
    authors,
    venue,
    year,
    date,
    doi,
    pmid: null,
    url,
  };
}

function normalizeOpenAlexWork(work) {
  const doi = normalizeDoi(work?.doi);
  const title = work?.title || work?.display_name || null;
  const authors = Array.isArray(work?.authorships)
    ? work.authorships.map((a) => a?.author?.display_name).filter(Boolean)
    : [];
  const venue =
    work?.primary_location?.source?.display_name ||
    work?.host_venue?.display_name ||
    work?.primary_location?.source?.publisher ||
    null;
  const date = work?.publication_date || null;
  const year = work?.publication_year || (date ? Number(date.slice(0, 4)) : null);
  const url = doi ? `https://doi.org/${doi}` : work?.id || null;
  const id = doi ? `DOI:${doi}` : work?.id ? `OA:${work.id}` : null;

  return {
    id,
    source: "OpenAlex",
    type: work?.type || null,
    title,
    authors,
    venue,
    year,
    date,
    doi,
    pmid: null,
    url,
  };
}

function normalizeManualRecord(record) {
  const doi = normalizeDoi(record?.doi);
  const pmid = record?.pmid ? String(record.pmid).trim() : null;
  const url = record?.url || (doi ? `https://doi.org/${doi}` : null);
  const id = pmid ? `PMID:${pmid}` : doi ? `DOI:${doi}` : url ? `URL:${url}` : null;

  return {
    id,
    source: record?.source || "Manual",
    type: record?.type || null,
    title: record?.title || (doi ? `DOI: ${doi}` : null),
    authors: Array.isArray(record?.authors) ? record.authors.filter(Boolean) : [],
    venue: record?.venue || null,
    year: record?.year ? Number(record.year) : null,
    date: record?.date || null,
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

async function fetchPubMedSummary(pmid) {
  const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("id", String(pmid));
  url.searchParams.set("retmode", "json");
  const data = await fetchJson(url.toString());
  const result = data?.result?.[String(pmid)];
  if (!result) return null;

  const authors = Array.isArray(result?.authors)
    ? result.authors.map((a) => a?.name).filter(Boolean)
    : [];
  const date = result?.pubdate ? toIsoDate(result.pubdate) : null;
  const year = date ? Number(date.slice(0, 4)) : result?.pubyear ? Number(result.pubyear) : null;
  const title = result?.title || null;
  const venue = result?.fulljournalname || result?.source || null;
  const doi =
    Array.isArray(result?.articleids) &&
    result.articleids.find((a) => a?.idtype === "doi")?.value
      ? normalizeDoi(result.articleids.find((a) => a?.idtype === "doi")?.value)
      : null;

  return {
    id: `PMID:${pmid}`,
    source: "PubMed",
    type: null,
    title,
    authors,
    venue,
    year,
    date,
    doi,
    pmid: String(pmid),
    url: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
  };
}

async function fetchCrossrefWork(doi, mailto) {
  const clean = normalizeDoi(doi);
  if (!clean) return null;
  const url = new URL(`https://api.crossref.org/works/${encodeURIComponent(clean)}`);
  if (mailto) url.searchParams.set("mailto", mailto);
  const data = await fetchJson(url.toString());
  const item = data?.message;
  if (!item) return null;
  return normalizeCrossrefItem(item, "Crossref");
}

function collectCrossrefAffiliations(item) {
  const values = [];
  const authors = item?.author;
  if (Array.isArray(authors)) {
    for (const author of authors) {
      const affs = author?.affiliation;
      if (Array.isArray(affs)) {
        for (const a of affs) {
          if (typeof a?.name === "string") values.push(a.name);
          if (typeof a === "string") values.push(a);
        }
      }
    }
  }
  return uniqStrings(values);
}

async function searchCrossrefByAffiliation({ affiliation, mailto, rows = 200, maxPages = 5 }) {
  const base = "https://api.crossref.org/works";
  let cursor = "*";
  let page = 0;
  const all = [];

  while (page < maxPages) {
    const url = new URL(base);
    url.searchParams.set("query.affiliation", affiliation);
    url.searchParams.set("rows", String(rows));
    url.searchParams.set("cursor", cursor);
    url.searchParams.set("cursor-max", String(rows));
    url.searchParams.set("mailto", mailto || "uasysbio@genomics.org.ua");

    const data = await fetchJson(url.toString());
    const items = data?.message?.items ?? [];
    all.push(...items);

    const nextCursor = data?.message?.["next-cursor"];
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
    page += 1;

    if (items.length < rows) break;
  }

  return all;
}

async function resolveOpenAlexInstitutionIds({ affiliation, aliases, mailto }) {
  const override = process.env.OPENALEX_INSTITUTION_ID;
  if (override) {
    return uniqStrings(override.split(/[,\s]+/g).filter(Boolean));
  }

  const phrases = uniqStrings([affiliation, ...aliases]);
  const normalizedTargets = phrases.map(normalizeTextForMatch);
  const found = new Set();

  for (const phrase of phrases) {
    const url = new URL("https://api.openalex.org/institutions");
    url.searchParams.set("search", phrase);
    url.searchParams.set("per-page", "5");
    if (mailto) url.searchParams.set("mailto", mailto);

    const data = await fetchJson(url.toString());
    const results = data?.results || [];
    for (const inst of results) {
      const name = inst?.display_name || "";
      const norm = normalizeTextForMatch(name);
      if (normalizedTargets.includes(norm) && inst?.id) {
        found.add(inst.id.replace("https://openalex.org/", "").trim());
      }
    }
  }

  return Array.from(found);
}

async function searchOpenAlexWorks({ institutionIds, mailto, perPage = 200, maxPages = 10 }) {
  if (!institutionIds || institutionIds.length === 0) return [];
  const base = "https://api.openalex.org/works";
  const idsFilter = institutionIds.map((id) => `institutions.id:${id}`).join("|");

  let cursor = "*";
  let page = 0;
  const all = [];

  while (page < maxPages) {
    const url = new URL(base);
    url.searchParams.set("filter", idsFilter);
    url.searchParams.set("per-page", String(perPage));
    url.searchParams.set("cursor", cursor);
    if (mailto) url.searchParams.set("mailto", mailto);

    const data = await fetchJson(url.toString());
    const results = data?.results ?? [];
    all.push(...results);

    const nextCursor = data?.meta?.["next_cursor"];
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
    page += 1;

    if (results.length < perPage) break;
  }

  return all;
}

function buildAffiliationQuery(affiliation) {
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

  // Even looser fallback: wildcard every significant token.
  const allTokensWildcard = tokens.length ? `AFF:(${tokens.map((t) => `${t}*`).join(" AND ")})` : null;

  // Keep the query strictly within AFF to avoid pulling in unrelated records that match generic tokens elsewhere.
  const parts = [`AFF:"${q}"`];
  if (tokenQuery) parts.splice(1, 0, tokenQuery);
  if (allTokensWildcard) parts.splice(1, 0, allTokensWildcard);
  return parts.join(" OR ");
}

function isWantedSource(item) {
  if (item.source === "MED") return true; // PubMed
  if (item.source === "PPR") {
    const journalTitle = (item.journalTitle || "").toLowerCase();
    const doi = String(item.doi || "").toLowerCase();

    // Europe PMC preprints commonly use 10.1101 DOIs (bioRxiv/medRxiv). If journalTitle is missing,
    // use the DOI prefix as a pragmatic fallback so bioRxiv items don't get dropped.
    if (doi.startsWith("10.1101/")) return true;
    return journalTitle.includes("biorxiv");
  }
  return false;
}

async function searchEuropePmc({ query, pageSize = 1000, maxPages = 10 }) {
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

async function readManual(manualFile) {
  try {
    const text = await readFile(manualFile, "utf8");
    const data = JSON.parse(text);
    return {
      dois: Array.isArray(data?.dois) ? data.dois : [],
      pmids: Array.isArray(data?.pmids) ? data.pmids : [],
      records: Array.isArray(data?.records) ? data.records : [],
    };
  } catch {
    return { dois: [], pmids: [], records: [] };
  }
}

function mergeAuthors(a = [], b = []) {
  return uniqStrings([...(a || []), ...(b || [])]);
}

function mergeItem(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  return {
    id: existing.id || incoming.id,
    source: existing.source || incoming.source,
    sources: uniqStrings([...(existing.sources || [existing.source]).filter(Boolean), ...(incoming.sources || [incoming.source]).filter(Boolean)]),
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
  const affiliation = process.env.AFFILIATION || DEFAULT_AFFILIATION;
  const affiliationAliases = parseAffiliationAliases(process.env.AFFILIATION_ALIASES);
  const outFile = process.env.OUTFILE || DEFAULT_OUTFILE;
  const manualFile = process.env.MANUAL_FILE || DEFAULT_MANUAL_FILE;
  const mailto = process.env.CROSSREF_MAILTO || process.env.MAILTO || "uasysbio@genomics.org.ua";
  const strictAffiliation =
    process.env.STRICT_AFFILIATION != null
      ? String(process.env.STRICT_AFFILIATION).toLowerCase() === "true"
      : DEFAULT_STRICT_AFFILIATION;

  const previous = await readPrevious(outFile);
  const manual = await readManual(manualFile);

  const phrasesNormalized = uniqStrings([affiliation, ...affiliationAliases]).map(normalizeTextForMatch);

  let query = null;
  let europeResults = [];
  try {
    query =
      (process.env.QUERY && String(process.env.QUERY).trim()) ||
      uniqStrings([affiliation, ...affiliationAliases])
        .map((a) => `(${buildAffiliationQuery(a)})`)
        .join(" OR ");

    ({ results: europeResults } = await searchEuropePmc({ query }));
  } catch (err) {
    if (previous) {
      console.error(`Failed to fetch Europe PMC; keeping existing ${outFile}.`);
      console.error(String(err?.stack || err));
      process.exit(0);
    }
    throw err;
  }

  const europeItems = europeResults
    .filter((r) => {
      if (!isWantedSource(r)) return false;
      const { hasAffiliations, matched } = matchesAffiliationPhrases(r, phrasesNormalized);
      if (strictAffiliation) return hasAffiliations && matched;
      return matched || hasAffiliations === false;
    })
    .map(normalizeItem)
    .filter((x) => x.title && (x.url || x.doi || x.pmid))
    .map((x) => ({ ...x, authors: x.authors ?? [] }));

  const crossrefRaw = [];
  for (const phrase of uniqStrings([affiliation, ...affiliationAliases])) {
    try {
      const items = await searchCrossrefByAffiliation({ affiliation: phrase, mailto });
      crossrefRaw.push(...items);
    } catch (err) {
      console.error(`Crossref query failed for "${phrase}": ${String(err?.message || err)}`);
    }
  }

  const crossrefItems = crossrefRaw
    .filter((item) => {
      const { hasAffiliations, matched } = matchesAffiliationValues(collectCrossrefAffiliations(item), phrasesNormalized);
      if (strictAffiliation) return hasAffiliations && matched;
      return matched || hasAffiliations === false;
    })
    .map((item) => normalizeCrossrefItem(item, "Crossref"))
    .filter((x) => x.title && (x.url || x.doi));

  const openAlexIds = await resolveOpenAlexInstitutionIds({
    affiliation,
    aliases: affiliationAliases,
    mailto,
  });
  const openAlexRaw = await searchOpenAlexWorks({ institutionIds: openAlexIds, mailto });
  const openAlexItems = openAlexRaw
    .map(normalizeOpenAlexWork)
    .filter((x) => x.title && (x.url || x.doi));

  const manualItems = [];
  for (const doi of uniqStrings(manual.dois)) {
    try {
      const item = await fetchCrossrefWork(doi, mailto);
      if (item) {
        item.source = "Manual";
        manualItems.push(item);
      } else {
        manualItems.push(normalizeManualRecord({ doi, source: "Manual" }));
      }
    } catch (err) {
      console.error(`Manual DOI fetch failed for ${doi}: ${String(err?.message || err)}`);
      manualItems.push(normalizeManualRecord({ doi, source: "Manual" }));
    }
  }

  for (const pmid of uniqStrings(manual.pmids)) {
    try {
      const item = await fetchPubMedSummary(pmid);
      if (item) {
        item.source = "Manual";
        manualItems.push(item);
      } else {
        manualItems.push(normalizeManualRecord({ pmid, source: "Manual" }));
      }
    } catch (err) {
      console.error(`Manual PMID fetch failed for ${pmid}: ${String(err?.message || err)}`);
      manualItems.push(normalizeManualRecord({ pmid, source: "Manual" }));
    }
  }

  for (const record of manual.records) {
    manualItems.push(normalizeManualRecord(record));
  }

  const map = new Map();
  for (const item of manualItems) addOrMerge(map, { ...item, sources: ["Manual"] });
  for (const item of europeItems) addOrMerge(map, { ...item, sources: ["EuropePMC"] });
  for (const item of crossrefItems) addOrMerge(map, { ...item, sources: ["Crossref"] });
  for (const item of openAlexItems) addOrMerge(map, { ...item, sources: ["OpenAlex"] });

  const merged = Array.from(map.values()).filter((x) => x.title && (x.url || x.doi || x.pmid));

  merged.sort((a, b) => {
    const ad = a.date || (a.year ? `${a.year}-01-01` : "");
    const bd = b.date || (b.year ? `${b.year}-01-01` : "");
    return bd.localeCompare(ad);
  });

  const out = {
    generatedAt: new Date().toISOString(),
    affiliation,
    query,
    count: merged.length,
    sources: {
      europePmc: europeItems.length,
      crossref: crossrefItems.length,
      openAlex: openAlexItems.length,
      manual: manualItems.length,
      openAlexIds,
    },
    items: merged,
  };

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.error(`Wrote ${out.count} items to ${outFile}`);
}

await main();
