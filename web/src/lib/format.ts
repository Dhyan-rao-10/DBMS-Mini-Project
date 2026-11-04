// Indian number formatting (lakh / crore grouping) for money and counts.

const inrFormat = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });
const inrShortFormat = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const numFormat = new Intl.NumberFormat("en-IN");

const toNumber = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v));

export function inr(v: string | number | null | undefined, short = false): string {
  const n = toNumber(v);
  if (n === null || Number.isNaN(n)) return "—";
  return (short ? inrShortFormat : inrFormat).format(n);
}

export function num(v: string | number | null | undefined): string {
  const n = toNumber(v);
  return n === null || Number.isNaN(n) ? "—" : numFormat.format(n);
}

/** "₹1.2 Cr", "₹45.3 L", "₹9,800" */
export function inrCompact(v: string | number | null | undefined): string {
  const n = toNumber(v);
  if (n === null || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`;
  return inrShortFormat.format(n);
}

export function month(d: string | Date): string {
  const date = typeof d === "string" ? new Date(`${d.slice(0, 10)}T00:00:00Z`) : d;
  return date.toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function dateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

export function date(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const s = typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);
  return new Date(`${s}T00:00:00Z`).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "UTC" });
}

export const pct = (v: string | number) => `${Number(v).toFixed(2).replace(/\.00$/, "")}%`;

/** Shows only the last 5 characters of a PAN. */
export const maskPan = (pan: string | null) => (pan ? `•••••${pan.slice(5)}` : "Not on file");
