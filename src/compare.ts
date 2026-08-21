import { SiteData } from "./types";

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

function normalizeName(name: string): string {
  const lower = name.toLowerCase().trim();
  const map: Record<string, string> = {
    "шахта": "mineexchange",
    "mine": "mineexchange",
    "moonlight": "moonlight",
    "moon light": "moonlight",
    "hotexchange": "hotexchange",
    "hot exchange": "hotexchange",
    "1million": "1million",
    "1 million": "1million",
    "hd-change": "hdchange",
    "hd change": "hdchange",
    "laslobit": "laslobit",
    "laslo bit": "laslobit",
    "sunduk": "sunduk",
    "keystop": "keystop",
    "keys top": "keystop",
    "bitkit": "bitkit",
    "bit kit": "bitkit",
    "getmoney": "getmoney",
    "get money": "getmoney",
    "payget": "payget",
    "pay get": "payget",
    "flashobmen": "flashobmen",
    "flash obmen": "flashobmen",
    "bitcash": "bitcash",
    "bit cash": "bitcash",
    "atpayz": "atpayz",
    "kriptomenyalka": "kriptomenyalka",
  };
  return map[lower] || lower.replace(/\s+/g, "").replace(/[\-\.]/g, "");
}

export interface ComparisonRow {
  name: string;
  nameEmon: string | null;
  nameBC: string | null;
  rateEmon: number | null;
  rateBC: number | null;
  reserveEmon: number | null;
  reserveBC: number | null;
  /** which site has the better rate */
  winner: "emon" | "bestchange" | "tie" | "none";
  /** rate difference percentage */
  diffPct: number;
}

export interface ComparisonResult {
  matched: ComparisonRow[];
  onlyEmon: ComparisonRow[];
  onlyBestChange: ComparisonRow[];
  summary: string;
}

export function compareSites(emon: SiteData, bestchange: SiteData): ComparisonResult {
  const emonMap = new Map<string, number>();
  emon.offers.forEach((o, i) => emonMap.set(normalizeName(o.name), i));

  const bcMap = new Map<string, number>();
  bestchange.offers.forEach((o, i) => bcMap.set(normalizeName(o.name), i));

  const matchedNames = new Set([...emonMap.keys()].filter(k => bcMap.has(k)));

  const matched: ComparisonRow[] = [];
  for (const key of matchedNames) {
    const eOffer = emon.offers[emonMap.get(key)!];
    const bOffer = bestchange.offers[bcMap.get(key)!];

    const avgRate = (eOffer.rate + bOffer.rate) / 2;
    const diffPct = avgRate > 0 ? Math.abs(eOffer.rate - bOffer.rate) / avgRate * 100 : 0;

    let winner: ComparisonRow["winner"] = "tie";
    if (Math.abs(eOffer.rate - bOffer.rate) > 0.000001) {
      winner = eOffer.rate > bOffer.rate ? "emon" : "bestchange";
    }

    matched.push({
      name: key,
      nameEmon: eOffer.name,
      nameBC: bOffer.name,
      rateEmon: eOffer.rate,
      rateBC: bOffer.rate,
      reserveEmon: eOffer.reserve,
      reserveBC: bOffer.reserve,
      winner,
      diffPct,
    });
  }

  const onlyEmon: ComparisonRow[] = [];
  for (const [key, idx] of emonMap) {
    if (!matchedNames.has(key)) {
      const o = emon.offers[idx];
      onlyEmon.push({
        name: key,
        nameEmon: o.name,
        nameBC: null,
        rateEmon: o.rate,
        rateBC: null,
        reserveEmon: o.reserve,
        reserveBC: null,
        winner: "none",
        diffPct: 0,
      });
    }
  }

  const onlyBestChange: ComparisonRow[] = [];
  for (const [key, idx] of bcMap) {
    if (!matchedNames.has(key)) {
      const o = bestchange.offers[idx];
      onlyBestChange.push({
        name: key,
        nameEmon: null,
        nameBC: o.name,
        rateEmon: null,
        rateBC: o.rate,
        reserveEmon: null,
        reserveBC: o.reserve,
        winner: "none",
        diffPct: 0,
      });
    }
  }

  matched.sort((a, b) => b.rateBC! - a.rateBC!);
  onlyEmon.sort((a, b) => (b.rateEmon || 0) - (a.rateEmon || 0));
  onlyBestChange.sort((a, b) => (b.rateBC || 0) - (a.rateBC || 0));

  const rateGaps = matched.filter(r => r.diffPct > 0.5);
  let summary = `${matched.length} exchangers found on both sites. `;
  if (rateGaps.length > 0) {
    const names = rateGaps.map(r => `${r.nameEmon || r.nameBC} (${r.winner})`).join(", ");
    summary += `Rate gaps >0.5%: ${names}.`;
  }

  return { matched, onlyEmon, onlyBestChange, summary };
}

export function formatComparison(result: ComparisonResult): string {
  const lines: string[] = [];

  lines.push("--- CROSS-SITE COMPARISON ---\n");

  if (result.matched.length > 0) {
    lines.push(`Matched on both sites (${result.matched.length}):`);
    lines.push("Exchanger          e-mon.cc    bestchange   Diff    Winner");
    lines.push("-".repeat(70));
    for (const r of result.matched) {
      const displayName = escapeHtml((r.nameEmon || r.nameBC || r.name).slice(0, 18)).padEnd(18);
      const eRate = r.rateEmon != null ? r.rateEmon.toFixed(6).padStart(10) : "      N/A".padStart(10);
      const bRate = r.rateBC != null ? r.rateBC.toFixed(6).padStart(10) : "      N/A".padStart(10);
      const diff = r.diffPct > 0.01 ? (r.diffPct.toFixed(2) + "%").padStart(8) : "   ~0%".padStart(8);
      const winner = r.winner === "emon" ? "emon > bc" : r.winner === "bestchange" ? "bc > emon".padStart(9) : "tie".padStart(9);
      lines.push(`${displayName} ${eRate}  ${bRate}  ${diff}  ${winner}`);
    }
    lines.push("");
  }

  if (result.onlyEmon.length > 0) {
    lines.push(`Only on e-mon.cc (${result.onlyEmon.length}):`);
    for (const r of result.onlyEmon) {
      const name = (r.nameEmon || r.name).slice(0, 25).padEnd(25);
      lines.push(`  ${name} rate: ${r.rateEmon?.toFixed(6)}  reserve: ${formatNum(r.reserveEmon || 0)}`);
    }
    lines.push("");
  }

  if (result.onlyBestChange.length > 0) {
    lines.push(`Only on bestchange.ru (${result.onlyBestChange.length}):`);
    for (const r of result.onlyBestChange) {
      const name = (r.nameBC || r.name).slice(0, 25).padEnd(25);
      lines.push(`  ${name} rate: ${r.rateBC?.toFixed(6)}  reserve: ${formatNum(r.reserveBC || 0)}`);
    }
    lines.push("");
  }

  lines.push(result.summary);

  return lines.join("\n");
}
