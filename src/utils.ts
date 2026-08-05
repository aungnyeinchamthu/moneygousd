const BANGKOK_OFFSET = 7 * 60 * 60 * 1000;

export function nowBangkok(): Date {
  return new Date(Date.now() + BANGKOK_OFFSET);
}

export function isoBangkok(): string {
  return nowBangkok().toISOString();
}

export function isoBangkokShort(): string {
  return nowBangkok().toISOString().replace("T", " ").slice(0, 19);
}
