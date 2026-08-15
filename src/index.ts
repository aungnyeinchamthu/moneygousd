import { scrapeEmon } from "./scrapers/emon";
import { scrapeBestChange } from "./scrapers/bestchange";
import { scrapeDirectExchanges } from "./scrapers/direct";
import {
  buildReport,
  buildAlertMessage,
  sendTelegram,
  TelegramConfig,
} from "./telegram";
import { SiteData } from "./types";
import { compareSites, formatComparison } from "./compare";
import { isoBangkok } from "./utils";

export interface Env {
  STATE: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  JINA_API_KEY?: string;
  LOW_RESERVE_THRESHOLD?: string;
  RATE_DROP_PERCENT?: string;
  RATE_DIFF_PERCENT?: string;
}

const THRESHOLDS = {
  lowReserve: 5000,
  rateDropPercent: 5,
  rateDiffPercent: 3,
};

function getThresholds(env: Env) {
  return {
    lowReserve: env.LOW_RESERVE_THRESHOLD
      ? parseInt(env.LOW_RESERVE_THRESHOLD)
      : THRESHOLDS.lowReserve,
    rateDropPercent: env.RATE_DROP_PERCENT
      ? parseFloat(env.RATE_DROP_PERCENT)
      : THRESHOLDS.rateDropPercent,
    rateDiffPercent: env.RATE_DIFF_PERCENT
      ? parseFloat(env.RATE_DIFF_PERCENT)
      : THRESHOLDS.rateDiffPercent,
  };
}

function getTelegramConfig(env: Env): TelegramConfig {
  return {
    botToken: env.TELEGRAM_BOT_TOKEN || "",
    chatId: env.TELEGRAM_CHAT_ID || "",
  };
}

async function loadPrev(env: Env): Promise<{
  emon: SiteData | null;
  bestchange: SiteData | null;
  lastAlertTime: number;
}> {
  try {
    const raw = await env.STATE.get("previous_state");
    if (raw) return JSON.parse(raw);
  } catch {}
  return { emon: null, bestchange: null, lastAlertTime: 0 };
}

async function savePrev(env: Env, emon: SiteData, bestchange: SiteData, lastAlertTime: number) {
  try {
    await env.STATE.put(
      "previous_state",
      JSON.stringify({ emon, bestchange, lastAlertTime }),
      { expirationTtl: 86400 }
    );
  } catch (e: any) {
    console.error(`KV write error: ${e.message}`);
  }
}

async function checkRateLimit(env: Env, key: string, maxReqs: number, windowSec: number): Promise<boolean> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - windowSec;
    const entry = await env.STATE.get(`rl:${key}`);
    const timestamps: number[] = entry ? JSON.parse(entry) : [];
    const recent = timestamps.filter(t => t > windowStart);
    if (recent.length >= maxReqs) return false;
    recent.push(now);
    await env.STATE.put(`rl:${key}`, JSON.stringify(recent), { expirationTtl: windowSec * 2 });
    return true;
  } catch {
    return true;
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log("Scheduled scan starting...");
    const [emon, bestchange, direct] = await Promise.all([
      scrapeEmon(),
      scrapeBestChange(env.JINA_API_KEY || ""),
      scrapeDirectExchanges(env.JINA_API_KEY || ""),
    ]);
    await runScan(env, emon, bestchange, direct, true);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (path === "/health") {
      return new Response("OK", { status: 200, headers: corsHeaders });
    }

    const allowed = await checkRateLimit(env, path, 10, 60);
    if (!allowed) {
      return new Response("Rate limit exceeded. Try again later.", {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "text/plain" },
      });
    }

    let emon: SiteData | null = null;
    let bestchange: SiteData | null = null;
    let direct: SiteData | null = null;

    const getData = async () => {
      if (!emon || !bestchange || !direct) {
        [emon, bestchange, direct] = await Promise.all([
          scrapeEmon(),
          scrapeBestChange(env.JINA_API_KEY || ""),
          scrapeDirectExchanges(env.JINA_API_KEY || ""),
        ]);
      }
      return { emon, bestchange, direct };
    };

    if (path === "/scan" || path === "/") {
      const { emon: e, bestchange: b, direct: d } = await getData();
      const result = await runScan(env, e, b, d, false);
      const comparison = compareSites(e, b);
      result.comparison = {
        matched: comparison.matched.map(r => ({
          name: r.nameEmon || r.nameBC,
          rateEmon: r.rateEmon,
          rateBC: r.rateBC,
          reserveEmon: r.reserveEmon,
          reserveBC: r.reserveBC,
          winner: r.winner,
          diffPct: r.diffPct,
        })),
        onlyEmon: comparison.onlyEmon.map(r => ({ name: r.nameEmon, rate: r.rateEmon, reserve: r.reserveEmon })),
        onlyBestChange: comparison.onlyBestChange.map(r => ({ name: r.nameBC, rate: r.rateBC, reserve: r.reserveBC })),
        summary: comparison.summary,
      };
      return new Response(JSON.stringify(result, null, 2), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (path === "/compare") {
      const { emon: e, bestchange: b, direct: d } = await getData();
      const comparison = compareSites(e, b);
      let text = formatComparison(comparison);
      if (d.offers.length > 0) {
        text += "\n\n--- DIRECT EXCHANGES (live rate) ---\n";
        for (const o of d.offers) {
          text += `${o.name.padEnd(15)} ${o.rate.toFixed(6)} MNGUSD per 1 USDT\n`;
        }
      }
      return new Response(text, {
        headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

async function runScan(env: Env, emon: SiteData, bestchange: SiteData, direct: SiteData, sendNotification: boolean): Promise<any> {
  const thresholds = getThresholds(env);
  const tgConfig = getTelegramConfig(env);

  const prev = await loadPrev(env);
  let lastAlertTime = prev.lastAlertTime;

  const report = buildReport(emon, bestchange, direct, prev.emon, prev.bestchange, thresholds);
  console.log(report);

  let alertSent = false;
  let alertMessage = "";

  const alerts = buildAlertMessage(emon, bestchange, thresholds);
  const now = Date.now();
  const alertCooldown = 30 * 60 * 1000;

  if (alerts && (now - lastAlertTime > alertCooldown)) {
    alertMessage = `ALERT:\n${alerts}\n\n${report}`;
    if (sendNotification && tgConfig.botToken && tgConfig.chatId) {
      alertSent = await sendTelegram(alertMessage, tgConfig);
      if (alertSent) lastAlertTime = now;
    }
  }

  if (sendNotification && tgConfig.botToken && tgConfig.chatId) {
    const shouldSendRegular = !alertSent;
    const timeSinceLast = now - prev.lastAlertTime;
    if (shouldSendRegular && timeSinceLast > 50 * 60 * 1000) {
      await sendTelegram(report, tgConfig);
    }
  }

  await savePrev(env, emon, bestchange, lastAlertTime);

  return {
    status: "ok",
    timestamp: isoBangkok(),
    eMon: {
      exchangers: emon.exchangerCount,
      totalReserve: emon.totalReserve,
      weightedAvgRate: emon.weightedAverageRate,
      topRate: emon.offers[0]?.rate || 0,
      error: emon.fetchError || null,
    },
    bestChange: {
      exchangers: bestchange.exchangerCount,
      totalReserve: bestchange.totalReserve,
      weightedAvgRate: bestchange.weightedAverageRate,
      topRate: bestchange.offers[0]?.rate || 0,
      error: bestchange.fetchError || null,
    },
    direct: {
      exchangers: direct.exchangerCount,
      offers: direct.offers.map(o => ({ name: o.name, rate: o.rate, minAmount: o.minAmount, maxAmount: o.maxAmount })),
      error: direct.fetchError || null,
    },
    alertSent,
    alertMessage: alertMessage || null,
  };
}
