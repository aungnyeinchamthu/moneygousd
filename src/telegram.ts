import { ScanSnapshot, SiteData } from "./types";
import { compareSites, formatComparison } from "./compare";
import { isoBangkokShort } from "./utils";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatNum(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n)).replace(/,/g, " ");
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export function buildReport(
  emon: SiteData,
  bestchange: SiteData,
  direct: SiteData,
  prev: ScanSnapshot | null,
  thresholds: { lowReserve: number; rateDropPercent: number; rateDiffPercent: number }
): string {
  const now = isoBangkokShort();
  const parts: string[] = [];

  parts.push(formatHeader(emon, bestchange, direct, now));

  if (emon.offers.length === 0 && bestchange.offers.length === 0 && direct.offers.length === 0) {
    parts.push(`ALL SOURCES FAILED: e-mon=${emon.fetchError || "?"} | bestchange=${bestchange.fetchError || "?"} | direct=${direct.fetchError || "?"}`);
    return parts.join("\n");
  }

  if (emon.offers.length > 0) {
    parts.push(formatTable("e-mon.cc", emon));
  } else if (emon.fetchError) {
    parts.push(`e-mon.cc: ERROR - ${emon.fetchError}`);
  }

  if (bestchange.offers.length > 0) {
    const staleTag = bestchange.stale ? " [STALE CACHE]" : "";
    parts.push(formatTable(`bestchange.ru${staleTag}`, bestchange));
  } else if (bestchange.fetchError) {
    parts.push(`bestchange.ru: ERROR - ${bestchange.fetchError}`);
  }

  if (direct.offers.length > 0) {
    parts.push(formatDirectTable(direct));
  } else if (direct.fetchError) {
    parts.push(`direct-exchanges: ERROR - ${direct.fetchError}`);
  }

  const comparison = buildComparison(emon, bestchange, thresholds);
  if (comparison) parts.push(comparison);

  const cross = compareSites(emon, bestchange);
  if (cross.matched.length > 0) {
    parts.push(formatComparison(cross));
  }

  const trend = buildTrend(emon, bestchange, direct, prev);
  if (trend) parts.push(trend);

  return parts.join("\n");
}

function formatDirectTable(direct: SiteData): string {
  let table = `\n--- direct exchanges (live rate) ---\n`;
  for (const o of direct.offers) {
    table += `${escapeHtml(o.name).padEnd(15)} ${o.rate.toFixed(6)} MNGUSD per 1 USDT\n`;
  }
  return table;
}

function bestRateOf(emon: SiteData, bestchange: SiteData, direct: SiteData): number {
  return Math.max(
    emon.offers[0]?.rate || 0,
    bestchange.offers[0]?.rate || 0,
    direct.offers[0]?.rate || 0
  );
}

function formatHeader(emon: SiteData, bestchange: SiteData, direct: SiteData, now: string): string {
  let header = `MNGUSD/USDT Monitor @ ${now} ICT (Bangkok)\n`;
  const bestRate = bestRateOf(emon, bestchange, direct);
  if (bestRate > 0) {
    header += `Best rate: ${bestRate.toFixed(6)} MNGUSD per 1 USDT`;
  }
  return header;
}

function formatTable(source: string, data: SiteData): string {
  let table = `\n--- ${source} ---\n`;
  table += `${data.exchangerCount} exchangers | Total reserve: ${formatNum(data.totalReserve)} MNGUSD | W.Avg rate: ${data.weightedAverageRate.toFixed(6)}\n\n`;

  const top5 = data.offers.slice(0, 5);
  for (const o of top5) {
    const rateStr = o.rate.toFixed(6);
    const reserveStr = formatNum(o.reserve);
    table += `${escapeHtml(o.name).padEnd(20)} ${rateStr}  |  reserve: ${reserveStr}\n`;
  }

  if (data.offers.length > 5) {
    table += `... and ${data.offers.length - 5} more\n`;
  }

  return table;
}

function buildComparison(emon: SiteData, bestchange: SiteData, thresholds: { rateDiffPercent: number }): string | null {
  if (emon.offers.length === 0 || bestchange.offers.length === 0) return null;

  const emonBest = emon.offers[0]?.rate || 0;
  const bcBest = bestchange.offers[0]?.rate || 0;

  const avgRate = (emon.weightedAverageRate + bestchange.weightedAverageRate) / 2;
  const diff = Math.abs(emonBest - bcBest);
  const diffPct = avgRate > 0 ? (diff / avgRate) * 100 : 0;

  if (diffPct > thresholds.rateDiffPercent) {
    return `\nRATE GAP: e-mon best ${emonBest.toFixed(6)} vs bestchange best ${bcBest.toFixed(6)} = ${diffPct.toFixed(2)}% diff`;
  }
  return null;
}

function buildTrend(
  emon: SiteData,
  bestchange: SiteData,
  direct: SiteData,
  prev: ScanSnapshot | null
): string | null {
  if (!prev) return null;
  const lines: string[] = [];

  if (prev.emonWavg > 0 && emon.weightedAverageRate > 0) {
    const change = emon.weightedAverageRate - prev.emonWavg;
    const pct = (change / prev.emonWavg) * 100;
    lines.push(`e-mon W.Avg: ${emon.weightedAverageRate.toFixed(6)} (${change >= 0 ? "↑" : "↓"}${Math.abs(pct).toFixed(2)}%)`);
  }

  if (prev.bcWavg > 0 && bestchange.weightedAverageRate > 0) {
    const change = bestchange.weightedAverageRate - prev.bcWavg;
    const pct = (change / prev.bcWavg) * 100;
    lines.push(`bestchange W.Avg: ${bestchange.weightedAverageRate.toFixed(6)} (${change >= 0 ? "↑" : "↓"}${Math.abs(pct).toFixed(2)}%)`);
  }

  if (prev.directTop > 0 && direct.offers[0]?.rate) {
    const change = direct.offers[0].rate - prev.directTop;
    const pct = (change / prev.directTop) * 100;
    lines.push(`${direct.offers[0].name}: ${direct.offers[0].rate.toFixed(6)} (${change >= 0 ? "↑" : "↓"}${Math.abs(pct).toFixed(2)}%)`);
  }

  return lines.length > 0 ? "\nChanges:\n" + lines.join("\n") : null;
}

export async function sendTelegram(
  message: string,
  config: TelegramConfig
): Promise<boolean> {
  if (!config.botToken || !config.chatId) {
    console.log("Telegram not configured, skipping send");
    return false;
  }

  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        disable_web_page_preview: true,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`Telegram send failed: ${resp.status} ${err}`);
      return false;
    }

    return true;
  } catch (e: any) {
    console.error(`Telegram error: ${e.message}`);
    return false;
  }
}

export function buildAlertMessage(
  emon: SiteData,
  bestchange: SiteData,
  direct: SiteData,
  prev: ScanSnapshot | null,
  thresholds: { lowReserve: number; rateDropPercent: number; rateDiffPercent: number }
): string | null {
  const alerts: string[] = [];

  if (!emon.fetchError && emon.offers.length > 0 && emon.totalReserve < thresholds.lowReserve) {
    alerts.push(`LOW RESERVE on e-mon.cc: ${formatNum(emon.totalReserve)} MNGUSD (threshold: ${formatNum(thresholds.lowReserve)})`);
  }

  if (!bestchange.fetchError && !bestchange.stale && bestchange.offers.length > 0 && bestchange.totalReserve < thresholds.lowReserve) {
    alerts.push(`LOW RESERVE on bestchange.ru: ${formatNum(bestchange.totalReserve)} MNGUSD (threshold: ${formatNum(thresholds.lowReserve)})`);
  }

  // Rate gap between aggregators
  if (emon.offers.length > 0 && bestchange.offers.length > 0) {
    const emonBest = emon.offers[0]?.rate || 0;
    const bcBest = bestchange.offers[0]?.rate || 0;
    const avgRate = (emon.weightedAverageRate + bestchange.weightedAverageRate) / 2;
    const diffPct = avgRate > 0 ? (Math.abs(emonBest - bcBest) / avgRate) * 100 : 0;

    if (diffPct > thresholds.rateDiffPercent) {
      const higher = emonBest >= bcBest ? "e-mon.cc" : "bestchange.ru";
      alerts.push(`RATE GAP: ${higher} has better rate by ${diffPct.toFixed(2)}% (${Math.max(emonBest, bcBest).toFixed(6)} vs ${Math.min(emonBest, bcBest).toFixed(6)})`);
    }
  }

  // Best-rate drop vs previous scan (uses the previously-unused rateDropPercent threshold)
  if (prev && prev.ts > 0) {
    const currentBest = bestRateOf(emon, bestchange, direct);
    const sources: number[] = [prev.emonTop, prev.bcTop, prev.directTop];
    const prevBest = Math.max(...sources.filter(r => r > 0));
    if (currentBest > 0 && prevBest > 0) {
      const dropPct = ((prevBest - currentBest) / prevBest) * 100;
      if (dropPct > thresholds.rateDropPercent) {
        alerts.push(`RATE DROP: best rate fell ${dropPct.toFixed(2)}% since last scan (${prevBest.toFixed(6)} -> ${currentBest.toFixed(6)})`);
      }
    }
  }

  return alerts.length > 0 ? alerts.join("\n") : null;
}
