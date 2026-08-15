import { ExchangerOffer, SiteData } from "../types";

const BESTCHANGE_URL = "https://www.bestchange.ru/tether-trc20-to-moneygo.html";

interface FetchResult {
  html: string | null;
  error: string;
  viaProxy: boolean;
}

export async function scrapeBestChange(jinaApiKey: string): Promise<SiteData> {
  const offers: ExchangerOffer[] = [];
  let totalReserve = 0;
  let weightedAverageRate = 0;

  const { html, error, viaProxy } = await fetchBestChange(jinaApiKey);

  if (!html) {
    return {
      source: "bestchange.ru",
      offers: [],
      totalReserve: 0,
      weightedAverageRate: 0,
      exchangerCount: 0,
      updatedAt: new Date().toISOString(),
      fetchError: error,
    };
  }

  const rowRegex = /<tr[^>]*onclick[^>]*>(.*?)<\/tr>/gs;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    const cellsRaw: string[] = [];
    const cells: string[] = [];
    const cellRegex = /<td[^>]*>(.*?)<\/td>/gs;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cellsRaw.push(cellMatch[1]);
      cells.push(stripTags(cellMatch[1]));
    }

    if (cells.length < 5) continue;

    const name = extractName(cellsRaw[1], cells[1]);

    const infoCell = cells[2] || "";
    if (!infoCell.includes("USDT") || !infoCell.includes("TRC20")) continue;

    const rangeM = infoCell.match(/от\s+([\d\s.,]+)\s+до\s+([\d\s.,]+)/);
    let minAmount = 0;
    let maxAmount = 0;
    if (rangeM) {
      minAmount = parseNum(rangeM[1]);
      maxAmount = parseNum(rangeM[2]);
      if (minAmount > maxAmount) {
        [minAmount, maxAmount] = [maxAmount, minAmount];
      }
    }

    const rateCell = cells[3] || "";
    const rateM = rateCell.match(/([\d]+(?:[.,]\d+)?)\s*USD\s*MoneyGo/i);
    if (!rateM) continue;
    const rate = parseNum(rateM[1]);

    const reserveCell = cells[4] || "";
    const reserveM = reserveCell.match(/([\d\s]+)/);
    if (!reserveM) continue;
    const reserve = parseNum(reserveM[1]);

    if (isNaN(rate) || isNaN(reserve)) continue;

    offers.push({
      name,
      giveAmount: 1,
      getAmount: rate,
      rate,
      reserve,
      minAmount,
      maxAmount,
    });
  }

  offers.sort((a, b) => b.rate - a.rate);

  const strippedHtml = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

  const summary = parseSummary(strippedHtml);
  if (summary) {
    totalReserve = summary.totalReserve;
    weightedAverageRate = summary.weightedAvg;
  } else if (offers.length > 0) {
    totalReserve = offers.reduce((s, o) => s + o.reserve, 0);
    const totalWeighted = offers.reduce((s, o) => s + o.rate * o.reserve, 0);
    weightedAverageRate = totalReserve > 0 ? totalWeighted / totalReserve : 0;
  }

  const updatedAt = extractUpdatedAt(html);

  return {
    source: "bestchange.ru",
    offers,
    totalReserve,
    weightedAverageRate,
    exchangerCount: offers.length,
    updatedAt,
  };
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchBestChange(jinaApiKey: string): Promise<FetchResult> {
  const direct = await tryFetch(BESTCHANGE_URL, "direct", 8000, {});
  if (direct.html) return direct;

  const jinaHeaders: Record<string, string> = { "X-Return-Format": "html" };
  if (jinaApiKey) jinaHeaders["Authorization"] = `Bearer ${jinaApiKey}`;

  const jina = await tryFetch(
    `https://r.jina.ai/${BESTCHANGE_URL}`,
    "proxy",
    20000,
    jinaHeaders
  );
  if (jina.html) return jina;

  const allorigins = await tryFetch(
    `https://api.allorigins.win/raw?url=${encodeURIComponent(BESTCHANGE_URL)}`,
    "proxy",
    10000,
    {}
  );
  if (allorigins.html) return allorigins;

  return { html: null, error: "bestchange.ru unreachable (blocked)", viaProxy: false };
}

async function tryFetch(url: string, mode: "direct" | "proxy", timeoutMs: number, extraHeaders: Record<string, string>): Promise<FetchResult> {
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

    if (!resp.ok) {
      return { html: null, error: `HTTP ${resp.status}`, viaProxy: mode === "proxy" };
    }

    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);

    let html: string;
    try {
      html = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      html = new TextDecoder("windows-1251", { fatal: false, ignoreBOM: true }).decode(bytes);
    }

    if (!html.includes("MoneyGo")) {
      return { html: null, error: "no data in response", viaProxy: mode === "proxy" };
    }

    return { html, error: "", viaProxy: mode === "proxy" };
  } catch (e: any) {
    return { html: null, error: e.message || "fetch failed", viaProxy: mode === "proxy" };
  }
}

function extractName(rawCell: string, strippedCell: string): string {
  const linkM = rawCell.match(/<a[^>]*class="rwan"[^>]*>([^<]+)<\/a>/i);
  if (linkM) return linkM[1].trim();

  const divM = rawCell.match(/<div[^>]*class="ca"[^>]*>([^<]*)<\/div>/i);
  if (divM) {
    const inner = divM[1].trim();
    if (inner) return inner;
  }

  return strippedCell.split(".")[0].trim() || strippedCell;
}

function stripTags(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSummary(text: string): { totalReserve: number; weightedAvg: number } | null {
  const m = text.match(
    /[СC]уммарный\s+резерв\s+обменников:\s*([\d\s]+)\s*USD\s+MoneyGo[.\s]*[СC]редневзвешенный\s+курс(?:\s+обмена)?:\s*([\d\s.,]+)/i
  );
  if (!m) return null;
  return {
    totalReserve: parseNum(m[1]),
    weightedAvg: parseNum(m[2]),
  };
}

function extractUpdatedAt(html: string): string {
  const m = html.match(/(\d{2}:\d{2}:\d{2})/);
  if (m) {
    const today = new Date().toISOString().slice(0, 10);
    return `${today}T${m[1]}`;
  }
  return new Date().toISOString();
}

function parseNum(s: string): number {
  return parseFloat(s.replace(/\s/g, "").replace(",", "."));
}
