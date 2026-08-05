import { ExchangerOffer, SiteData } from "../types";

const BESTCHANGE_URL = "https://www.bestchange.ru/tether-trc20-to-moneygo.html";

export async function scrapeBestChange(): Promise<SiteData> {
  const offers: ExchangerOffer[] = [];
  let totalReserve = 0;
  let weightedAverageRate = 0;

  try {
    const resp = await fetch(BESTCHANGE_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ExchangeMonitor/1.0)",
        "Accept": "text/html, application/xhtml+xml",
      },
    });

    if (!resp.ok) return createError("bestchange.ru", `HTTP ${resp.status}`);

    const arrayBuffer = await resp.arrayBuffer();
    const decoder = new TextDecoder("windows-1251");
    const html = decoder.decode(arrayBuffer);

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
  } catch (e: any) {
    return createError("bestchange.ru", e.message);
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

function createError(source: string, msg: string): SiteData {
  return {
    source,
    offers: [],
    totalReserve: 0,
    weightedAverageRate: 0,
    exchangerCount: 0,
    updatedAt: new Date().toISOString(),
    fetchError: msg,
  };
}
