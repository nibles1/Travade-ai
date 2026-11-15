// Travel news feed: fetches each RSS source, keeps the last 7 days, returns JSON at /news
const SOURCES = [
  { name: "Skift", url: "https://skift.com/feed/" },
  { name: "Simple Flying", url: "https://simpleflying.com/feed/" },
  { name: "The Guardian", url: "https://www.theguardian.com/uk/travel/rss" }
  // Travel Weekly and Breaking Travel News go here once their feed URLs are confirmed
];

const PROMO = /best tip wins|tell us about|share a tip|send us|£200/i;

const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) =>
    ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[e]);

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1].trim()) : "";
};

const stripHtml = s => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

// Pick the first real summary paragraph, skipping promo lines, and drop "Continue reading"
function cleanSummary(rawDesc) {
  const paras = [...rawDesc.matchAll(/<p>([\s\S]*?)<\/p>/gi)].map(m => stripHtml(decode(m[1])));
  const pick = paras.find(p => p && !PROMO.test(p)) || stripHtml(decode(rawDesc));
  return pick.replace(/Continue reading\.{0,3}/i, "").trim().slice(0, 280);
}

function parseItems(xml, source) {
  const out = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    const title = tag(b, "title");
    const url = tag(b, "link");
    const date = new Date(tag(b, "pubDate"));
    if (!title || !url || isNaN(date)) continue;
    const categories = [...b.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)]
      .map(m => decode(m[1].trim())).slice(0, 3);
    out.push({
      title,
      url,
      source: source.name,
      author: tag(b, "dc:creator"),
      published: date.toISOString(),
      summary: cleanSummary(tag(b, "description")),
      categories
    });
  }
  return out;
}

export async function onRequestGet(context) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).origin + "/news-cache-v1");
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const results = await Promise.allSettled(SOURCES.map(async s => {
    const res = await fetch(s.url, {
      headers: { "User-Agent": "travade.ai news reader" },
      cf: { cacheTtl: 3600 }
    });
    if (!res.ok) throw new Error(`${s.name} returned ${res.status}`);
    return parseItems(await res.text(), s);
  }));

  let items = results.filter(r => r.status === "fulfilled").flatMap(r => r.value)
    .sort((a, b) => b.published.localeCompare(a.published));

  // Keep the last 7 days; if that leaves very few stories, keep the latest ones anyway
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recent = items.filter(i => i.published >= cutoff);
  if (recent.length >= 5) items = recent;
  items = items.slice(0, 40);

  const response = new Response(
    JSON.stringify({ updated: new Date().toISOString(), items }),
    { headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600"
    } }
  );
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}