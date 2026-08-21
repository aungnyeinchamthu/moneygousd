import { ExchangerOffer, SiteData } from "../types";
import { isoBangkok } from "../utils";

interface DirectSource {
  name: string;
  url: string;
}

const DIRECT_SOURCES: DirectSource[] = [
  { name: "HD-Change", url: "https://hd-change.com/en/exchange-usdttrc20-to-mngusd/" },
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export async function scrapeDirectExchanges(jinaApiKey: string): Promise<SiteData> {
  const offers: ExchangerOffer[] = [];
  const errors: string[] = [];

  for (const src of DIRECT_SOURCES) {
    try {
      const offer = await scrapeOne(src, jinaApiKey);
      if (offer) {
        offers.push(offer);
      } else {
        errors.push(`${src.name}: no rate found`);
      }
    } catch (e: any) {
      errors.push(`${src.name}: ${e.message}`);
    }
  }

  offers.sort((a, b) => b.rate - a.rate);

  const totalReserve = offers.reduce((s, o) => s + o.reserve, 0);
  const weightedAverageRate = totalReserve > 0
    ? offers.reduce((s, o) => s + o.rate * o.reserve, 0) / totalReserve
    : (offers.length > 0 ? offers.reduce((s, o) => s + o.rate, 0) / offers.length : 0);

  return {
    source: "direct-exchanges",
    offers,
    totalReserve,
    weightedAverageRate,
    exchangerCount: offers.length,
    updatedAt: isoBangkok(),
    fetchError: errors.length > 0 ? errors.join(" | ") : undefined,
  };
}

async function scrapeOne(src: DirectSource, jinaApiKey: string): Promise<ExchangerOffer | null> {
  const direct = await tryFetchHtml(src.url, 15000, {});
  if (direct.html) {
    return parseRate(src, direct.html);
  }

  const jinaHeaders: Record<string, string> = { "X-Return-Format": "html" };
  if (jinaApiKey) jinaHeaders["Authorization"] = `Bearer ${jinaApiKey}`;
  const jina = await tryFetchHtml(`https://r.jina.ai/${src.url}`, 20000, jinaHeaders);
  if (jina.html) {
    return parseRate(src, jina.html);
  }

  return null;
}

async function tryFetchHtml(url: string, timeoutMs: number, extraHeaders: Record<string, string>): Promise<{ html: string | null }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
        ...extraHeaders,
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) return { html: null };

    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);

    let html: string;
    try {
      html = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      html = new TextDecoder("windows-1251", { fatal: false, ignoreBOM: true }).decode(bytes);
    }

    return { html };
  } catch {
    return { html: null };
  }
}

function parseRate(src: DirectSource, html: string): ExchangerOffer | null {
  const rateM = html.match(/js_course_html["'][^>]*>\s*1\s*USDT\s*=\s*([\d]+(?:[.,]\d+)?)\s*USD/i);
  if (!rateM) return null;
  const rate = parseNum(rateM[1]);

  let minAmount = 0;
  let maxAmount = 0;
  const minM = html.match(/data-val="([\d.]+)"[^>]*>\s*min\.:/i);
  const maxM = html.match(/data-val="([\d.]+)"[^>]*>\s*max\.:/i);
  if (minM) minAmount = parseFloat(minM[1]);
  if (maxM) maxAmount = parseFloat(maxM[1]);

  return {
    name: src.name,
    giveAmount: 1,
    getAmount: rate,
    rate,
    reserve: 0,
    minAmount,
    maxAmount,
  };
}

function parseNum(s: string): number {
  return parseFloat(s.replace(/\s/g, "").replace(",", "."));
}
