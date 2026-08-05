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
}

export interface AlertThresholds {
  /** Minimum total reserve before alerting */
  lowReserveThreshold: number;
  /** Rate drop percentage to alert (e.g. 2 means 2% drop) */
  rateDropPercent: number;
  /** Rate difference between sites to alert (percentage) */
  rateDiffPercent: number;
}
