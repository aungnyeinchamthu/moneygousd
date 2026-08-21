export interface ExchangerOffer {
  name: string;
  /** How many USDT you give */
  giveAmount: number;
  /** How many MNGUSD you receive */
  getAmount: number;
  /** Exchange rate: MNGUSD per 1 USDT */
  rate: number;
  /** Reserve in MNGUSD */
  reserve: number;
  /** Minimum exchange amount in USDT */
  minAmount: number;
  /** Maximum exchange amount in USDT */
  maxAmount: number;
}

export interface SiteData {
  source: string;
  offers: ExchangerOffer[];
  totalReserve: number;
  weightedAverageRate: number;
  exchangerCount: number;
  updatedAt: string;
  fetchError?: string;
  /** true when data came from the stale KV fallback */
  stale?: boolean;
}

/** Slim per-scan summary stored in KV (tiny value, cheap reads/writes) */
export interface ScanSnapshot {
  ts: number;
  emonTop: number;
  emonWavg: number;
  emonReserve: number;
  bcTop: number;
  bcWavg: number;
  bcReserve: number;
  directTop: number;
  lastAlertTime: number;
}
