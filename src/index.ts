import { scrapeEmon } from "./scrapers/emon";
import { scrapeBestChange } from "./scrapers/bestchange";
import { scrapeDirectExchanges } from "./scrapers/direct";
import {
  buildReport,
  buildAlertMessage,
  sendTelegram,
  TelegramConfig,
} from "./telegram";
import { ScanSnapshot, SiteData } from "./types";
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
  REPORT_INTERVAL_MIN?: string;
}

const DEFAULTS = {
  lowReserve: 5000,
  rateDropPercent: 5,
  rateDiffPercent: 3,
  reportIntervalMin: 50,
  alertCooldownMin: 30,
  scrapeCacheTtlMs: 5 * 60 * 1000,
  rateLimitMax: 10,
  rateLimitWindowMs: 60 * 1000,
};

function getThresholds(env: Env) {
  return {
    lowReserve: env.LOW_RESERVE_THRESHOLD ? parseInt(env.LOW_RESERVE_THRESHOLD) : DEFAULTS.lowReserve,
    rateDropPercent: env.RATE_DROP_PERCENT ? parseFloat(env.RATE_DROP_PERCENT) : DEFAULTS.rateDropPercent,
    rateDiffPercent: env.RATE_DIFF_PERCENT ? parseFloat(env.RATE_DIFF_PERCENT) : DEFAULTS.rateDiffPercent,
    reportIntervalMin: env.REPORT_INTERVAL_MIN ? parseInt(env.REPORT_INTERVAL_MIN) : DEFAULTS.reportIntervalMin,
  };
}

function getTelegramConfig(env: Env): TelegramConfig {
  return { botToken: env.TELEGRAM_BOT_TOKEN || "", chatId: env.TELEGRAM_CHAT_ID || "" };
}

// ---- In-memory scrape cache (per isolate, avoids re-scraping on rapid hits) ----
const scrapeCache = new Map<string, { data: SiteData; ts: number }>();

async function cachedScrape(key: string, ttlMs: number, fetcher: () => Promise<SiteData>): Promise<SiteData> {
  const hit = scrapeCache.get(key);
  const fresh = hit && Date.now() - hit.ts < ttlMs;
  // Serve cache only when it holds usable data; never cache failures
  if (fresh && hit!.data.offers.length > 0 && !hit!.data.fetchError) return hit!.data;
  const data = await fetcher();
  if (data.offers.length > 0 && !data.fetchError) {
    scrapeCache.set(key, { data, ts: Date.now() });
  } else if (hit && fresh) {
    // keep serving previous good data rather than caching the failure
    return hit.data;
  }
  return data;
}

// ---- In-memory rate limiter (no KV writes; per-isolate) ----
const rateBuckets = new Map<string, number[]>();

function checkRateLimit(key: string, maxReqs: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= maxReqs) {
    rateBuckets.set(key, arr);
    return false;
  }
  arr.push(now);
  rateBuckets.set(key, arr);
  return true;
}

// ---- Slim snapshot state (~200 bytes instead of ~10KB of full offers) ----
function makeSnapshot(emon: SiteData, bestchange: SiteData, direct: SiteData, lastAlertTime: number): ScanSnapshot {
  return {
    ts: Date.now(),
    emonTop: emon.offers[0]?.rate || 0,
    emonWavg: emon.weightedAverageRate,
    emonReserve: emon.totalReserve,
    bcTop: bestchange.offers[0]?.rate || 0,
    bcWavg: bestchange.weightedAverageRate,
    bcReserve: bestchange.totalReserve,
    directTop: direct.offers[0]?.rate || 0,
    lastAlertTime,
  };
}

async function loadState(env: Env): Promise<{ snapshot: ScanSnapshot | null; lastGood: Record<string, SiteData> }> {
  try {
    const [snapRaw, bcRaw, directRaw] = await Promise.all([
      env.STATE.get("snapshot"),
      env.STATE.get("bc_last_good"),
      env.STATE.get("direct_last_good"),
    ]);
    const lastGood: Record<string, SiteData> = {};
    if (bcRaw) lastGood.bestchange = JSON.parse(bcRaw);
    if (directRaw) lastGood.direct = JSON.parse(directRaw);
    return { snapshot: snapRaw ? JSON.parse(snapRaw) : null, lastGood };
  } catch {
    return { snapshot: null, lastGood: {} };
  }
}

async function saveState(env: Env, snap: ScanSnapshot, sources: Record<string, SiteData>) {
  try {
    const puts: Promise<void>[] = [env.STATE.put("snapshot", JSON.stringify(snap))];
    // Persist last-good data only for sources whose fetch actually succeeded
    if (!sources.bestchange.fetchError && sources.bestchange.offers.length > 0) {
      puts.push(env.STATE.put("bc_last_good", JSON.stringify(sources.bestchange), { expirationTtl: 7 * 86400 }));
    }
    if (!sources.direct.fetchError && sources.direct.offers.length > 0) {
      puts.push(env.STATE.put("direct_last_good", JSON.stringify(sources.direct), { expirationTtl: 7 * 86400 }));
    }
    await Promise.all(puts);
  } catch (e: any) {
    console.error(`KV write error: ${e.message}`);
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log("Scheduled scan starting...");
    try {
      const [emon, bestchange, direct] = await Promise.all([
        scrapeEmon(),
        scrapeBestChange(env.JINA_API_KEY || ""),
        scrapeDirectExchanges(env.JINA_API_KEY || ""),
      ]);
      await runScan(env, emon, bestchange, direct, true);
    } catch (e: any) {
      console.error(`Scheduled scan failed: ${e.message}`);
      const tg = getTelegramConfig(env);
      if (tg.botToken && tg.chatId) {
        await sendTelegram(`MONITOR FAILURE: scheduled scan crashed: ${e.message}`, tg);
      }
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const corsHeaders: Record<string, string> = {
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

    if (!checkRateLimit(path, DEFAULTS.rateLimitMax, DEFAULTS.rateLimitWindowMs)) {
      return new Response("Rate limit exceeded. Try again later.", {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "text/plain" },
      });
    }

    const getData = () =>
      Promise.all([
        cachedScrape("emon", DEFAULTS.scrapeCacheTtlMs, scrapeEmon),
        cachedScrape("bestchange", DEFAULTS.scrapeCacheTtlMs, () => scrapeBestChange(env.JINA_API_KEY || "")),
        cachedScrape("direct", DEFAULTS.scrapeCacheTtlMs, () => scrapeDirectExchanges(env.JINA_API_KEY || "")),
      ]);

    if (path === "/scan" || path === "/") {
      const [e, b, d] = await getData();
      const { snapshot } = await loadState(env);
      const result = buildScanResult(env, e, b, d, snapshot, false, "");
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
      const [e, b, d] = await getData();
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

/** Substitute last-good cached data when a live fetch fails */
function applyStaleFallback(data: SiteData, lastGood: SiteData | null): SiteData {
  if (!data.fetchError || data.offers.length > 0) return data;
  if (!lastGood || lastGood.offers.length === 0) return data;
  return { ...lastGood, stale: true, fetchError: undefined };
}

function buildScanResult(
  env: Env,
  emon: SiteData,
  bestchange: SiteData,
  direct: SiteData,
  snapshot: ScanSnapshot | null,
  alertSent: boolean,
  alertMessage: string
): Record<string, any> {
  void env;
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
      stale: bestchange.stale || false,
      error: bestchange.fetchError || null,
    },
    direct: {
      exchangers: direct.exchangerCount,
      offers: direct.offers.map(o => ({ name: o.name, rate: o.rate, minAmount: o.minAmount, maxAmount: o.maxAmount })),
      error: direct.fetchError || null,
    },
    alertSent,
    alertMessage: alertMessage || null,
    snapshotTs: snapshot?.ts || null,
  };
}

async function runScan(env: Env, emon: SiteData, bestchangeRaw: SiteData, directRaw: SiteData, sendNotification: boolean): Promise<void> {
  const thresholds = getThresholds(env);
  const tgConfig = getTelegramConfig(env);

  const { snapshot: prev, lastGood } = await loadState(env);
  const bestchange = applyStaleFallback(bestchangeRaw, lastGood.bestchange || null);
  const direct = applyStaleFallback(directRaw, lastGood.direct || null);

  const report = buildReport(emon, bestchange, direct, prev, thresholds);
  console.log(report);

  let lastAlertTime = prev?.lastAlertTime || 0;

  const alerts = buildAlertMessage(emon, bestchange, direct, prev, thresholds);
  const now = Date.now();

  if (alerts && now - lastAlertTime > DEFAULTS.alertCooldownMin * 60 * 1000) {
    const alertMessage = `ALERT:\n${alerts}\n\n${report}`;
    if (sendNotification && tgConfig.botToken && tgConfig.chatId) {
      const sent = await sendTelegram(alertMessage, tgConfig);
      if (sent) lastAlertTime = now;
    }
  }

  if (sendNotification && tgConfig.botToken && tgConfig.chatId) {
    const timeSinceLast = now - lastAlertTime;
    if (timeSinceLast > thresholds.reportIntervalMin * 60 * 1000) {
      await sendTelegram(report, tgConfig);
    }
  }

  // Persist state ONLY on scheduled runs: manual /scan hits cost zero KV writes
  if (sendNotification) {
    await saveState(env, makeSnapshot(emon, bestchange, direct, lastAlertTime), {
      bestchange,
      direct,
    });
  }
}
