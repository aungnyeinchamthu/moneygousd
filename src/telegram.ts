import { ExchangerOffer, SiteData } from "./types";
import { compareSites, formatComparison, ComparisonResult } from "./compare";

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

export interface AlertMessages {
  combined: string;
  criticalAlerts: string[];
}

export function buildReport(
  emon: SiteData,
  bestchange: SiteData,
  prevEmon: SiteData | null,
  prevBestchange: SiteData | null,
  thresholds: { lowReserve: number; rateDropPercent: number; rateDiffPercent: number }
): string {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const parts: string[] = [];

  parts.push(formatHeader(emon, bestchange, now));

  if (emon.fetchError && bestchange.fetchError) {
    parts.push(`BOTH SITES FAILED: e-mon=${emon.fetchError} | bestchange=${bestchange.fetchError}`);
    return parts.join("\n");
  }

  if (emon.offers.length > 0) {
    parts.push(formatTable("e-mon.cc", emon));
  } else if (emon.fetchError) {
    parts.push(`e-mon.cc: ERROR - ${emon.fetchError}`);
  }

  if (bestchange.offers.length > 0) {
    parts.push(formatTable("bestchange.ru", bestchange));
  } else if (bestchange.fetchError) {
    parts.push(`bestchange.ru: ERROR - ${bestchange.fetchError}`);
  }

  const comparison = buildComparison(emon, bestchange, thresholds);
  if (comparison) parts.push(comparison);

  const cross = compareSites(emon, bestchange);
  if (cross.matched.length > 0) {
    parts.push(formatComparison(cross));
  }

  const trend = buildTrend(emon, prevEmon, bestchange, prevBestchange);
  if (trend) parts.push(trend);

  return parts.join("\n");
}

function formatHeader(emon: SiteData, bestchange: SiteData, now: string): string {
  let header = `MNGUSD/USDT Monitor @ ${now} UTC\n`;
  if (emon.offers.length > 0 && bestchange.offers.length > 0) {
    const bestRate = Math.max(
      emon.offers[0]?.rate || 0,
      bestchange.offers[0]?.rate || 0
    );
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

function buildComparison(emon: SiteData, bestchange: SiteData, thresholds: { lowReserve: number; rateDiffPercent: number }): string | null {
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
  prevEmon: SiteData | null,
  bestchange: SiteData,
  prevBestchange: SiteData | null
): string | null {
  const lines: string[] = [];

  if (prevEmon && emon.weightedAverageRate > 0 && prevEmon.weightedAverageRate > 0) {
    const change = emon.weightedAverageRate - prevEmon.weightedAverageRate;
    const pct = (change / prevEmon.weightedAverageRate) * 100;
    const dir = change >= 0 ? "↑" : "↓";
    lines.push(`e-mon W.Avg: ${emon.weightedAverageRate.toFixed(6)} (${dir}${Math.abs(pct).toFixed(2)}%)`);
  }

  if (prevBestchange && bestchange.weightedAverageRate > 0 && prevBestchange.weightedAverageRate > 0) {
    const change = bestchange.weightedAverageRate - prevBestchange.weightedAverageRate;
    const pct = (change / prevBestchange.weightedAverageRate) * 100;
    const dir = change >= 0 ? "↑" : "↓";
    lines.push(`bestchange W.Avg: ${bestchange.weightedAverageRate.toFixed(6)} (${dir}${Math.abs(pct).toFixed(2)}%)`);
  }

  return lines.length > 0 ? "\nChanges:\n" + lines.join("\n") : null;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
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
        parse_mode: "HTML",
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
  thresholds: { lowReserve: number; rateDropPercent: number; rateDiffPercent: number }
): string | null {
  const alerts: string[] = [];

  if (!emon.fetchError && emon.offers.length > 0) {
    if (emon.totalReserve < thresholds.lowReserve) {
      alerts.push(`LOW RESERVE on e-mon.cc: ${formatNum(emon.totalReserve)} MNGUSD (threshold: ${formatNum(thresholds.lowReserve)})`);
    }
  }

  if (!bestchange.fetchError && bestchange.offers.length > 0) {
    if (bestchange.totalReserve < thresholds.lowReserve) {
      alerts.push(`LOW RESERVE on bestchange.ru: ${formatNum(bestchange.totalReserve)} MNGUSD (threshold: ${formatNum(thresholds.lowReserve)})`);
    }
  }

  if (emon.offers.length > 0 && bestchange.offers.length > 0) {
    const emonBest = emon.offers[0]?.rate || 0;
    const bcBest = bestchange.offers[0]?.rate || 0;
    const avgRate = (emon.weightedAverageRate + bestchange.weightedAverageRate) / 2;
    const diff = Math.abs(emonBest - bcBest);
    const diffPct = avgRate > 0 ? (diff / avgRate) * 100 : 0;

    if (diffPct > thresholds.rateDiffPercent) {
      const higher = emonBest >= bcBest ? "e-mon.cc" : "bestchange.ru";
      alerts.push(`RATE GAP: ${higher} has better rate by ${diffPct.toFixed(2)}% (${Math.max(emonBest, bcBest).toFixed(6)} vs ${Math.min(emonBest, bcBest).toFixed(6)})`);
    }
  }

  return alerts.length > 0 ? alerts.join("\n") : null;
}
