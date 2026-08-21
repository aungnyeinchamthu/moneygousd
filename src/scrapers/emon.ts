import { ExchangerOffer, SiteData } from "../types";
import { isoBangkok } from "../utils";

const EMON_URL = "https://e-mon.cc/exchange/USDTTRC20/MNGUSD";

export async function scrapeEmon(): Promise<SiteData> {
  const offers: ExchangerOffer[] = [];
  let totalReserve = 0;
  let weightedAverageRate = 0;

  try {
    const resp = await fetch(EMON_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ExchangeMonitor/1.0)",
        "Accept": "text/html",
      },
    });

    if (!resp.ok) return createError("e-mon.cc", `HTTP ${resp.status}`);

    const html = await resp.text();
    const updatedAt = extractUpdatedAt(html);

    const tbodyStart = html.indexOf("<tbody>");
    if (tbodyStart === -1) return createError("e-mon.cc", "no tbody found");
    const tbodyEnd = html.indexOf("</tbody>", tbodyStart);
    const tbody = tbodyEnd !== -1
      ? html.slice(tbodyStart, tbodyEnd)
      : html.slice(tbodyStart);

    const rows = tbody.split(/<tr[^>]*>/i).slice(1);

    let lastName = "";

    for (const row of rows) {
      const stripped = row
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&mdash;/g, "-")
        .replace(/\s+/g, " ")
        .trim();

      if (!stripped.includes("USDT") || !stripped.includes("MoneyGo")) {
        const nameM = stripped.match(/^(\S[\s\S]{2,80}?)\s+Резервы/);
        if (nameM) {
          lastName = nameM[1].trim();
        }
        continue;
      }

      const offer = parseRateRow(stripped, lastName);
      if (offer) {
        offers.push(offer);
      }
    }

    offers.sort((a, b) => b.rate - a.rate);

    const summary = parseSummary(html);
    if (summary) {
      totalReserve = summary.totalReserve;
      weightedAverageRate = summary.weightedAvg;
    } else if (offers.length > 0) {
      totalReserve = offers.reduce((s, o) => s + o.reserve, 0);
      const totalWeighted = offers.reduce((s, o) => s + o.rate * o.reserve, 0);
      weightedAverageRate = totalReserve > 0 ? totalWeighted / totalReserve : 0;
    }

    return {
      source: "e-mon.cc",
      offers,
      totalReserve,
      weightedAverageRate,
      exchangerCount: offers.length,
      updatedAt,
    };
  } catch (e: any) {
    return createError("e-mon.cc", e.message);
  }
}

function parseRateRow(text: string, fallbackName: string): ExchangerOffer | null {
  const giveM = text.match(/([\d]+(?:[.,]\d+)?)\s*USDT\s*TRC20/i);
  if (!giveM) return null;
  const giveAmount = parseNum(giveM[1]);

  const getM = text.match(/([\d]+(?:[.,]\d+)?)\s*USD\s*MoneyGo/i);
  if (!getM) return null;
  const getAmount = parseNum(getM[1]);

  const rangeM = text.match(/от\s+([\d\s.,]+)\s+до\s+([\d\s.,]+)/);
  let minAmount = 0;
  let maxAmount = 0;
  if (rangeM) {
    minAmount = Math.min(parseNum(rangeM[1]), parseNum(rangeM[2]));
    maxAmount = Math.max(parseNum(rangeM[1]), parseNum(rangeM[2]));
  }

  const afterGet = text.slice(text.indexOf("USD MoneyGo") + "USD MoneyGo".length);
  const reserveM = afterGet.match(/([\d\s]+)/);
  if (!reserveM) return null;
  const reserve = parseNum(reserveM[1]);

  const rate = giveAmount > 0 ? getAmount / giveAmount : 0;
  if (isNaN(rate) || isNaN(reserve)) return null;

  let name = fallbackName;
  const nameM = text.match(/^(\S[\s\S]{2,80}?)\s+Резервы/);
  if (nameM) name = nameM[1].trim();

  return { name, giveAmount, getAmount, rate, reserve, minAmount, maxAmount };
}

function parseSummary(html: string): { totalReserve: number; weightedAvg: number } | null {
  const idx = html.indexOf("Суммарный резерв");
  if (idx === -1) return null;
  const window = html
    .slice(idx, idx + 500)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
  const m = window.match(/Суммарный\s+резерв\s+обменников:\s*([\d\s.,]+)\s*MoneyGo\s*USD\.?\s*Средневзвешенный\s+курс\s+обмена:\s*([\d\s.,]+)/);
  if (!m) return null;
  return { totalReserve: parseNum(m[1]), weightedAvg: parseNum(m[2]) };
}

function extractUpdatedAt(html: string): string {
  const m = html.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+время\s+обновления/);
  return m ? m[1] : isoBangkok();
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
    updatedAt: isoBangkok(),
    fetchError: msg,
  };
}
