import Link from "next/link";
import type { ReactNode } from "react";

/** Small presentational building blocks shared by every page. */

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-border bg-surface p-5 ${className}`}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="num mt-1 text-2xl font-semibold">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

const TONES = {
  neutral: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  good: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  info: "bg-blue-50 text-blue-800 ring-blue-200",
  warning: "bg-amber-50 text-amber-800 ring-amber-200",
  critical: "bg-red-50 text-red-800 ring-red-200",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>{children}</span>;
}

const STATUS_TONE: Record<string, Tone> = {
  active: "good",
  approved: "good",
  paid: "good",
  matched: "good",
  loaded: "good",
  ok: "good",
  cleared: "good",
  released: "good",
  proposed: "info",
  pending: "warning",
  open: "info",
  locked: "warning",
  unmatched: "warning",
  held: "warning",
  uploaded: "warning",
  draft: "neutral",
  superseded: "neutral",
  retired: "neutral",
  written_off: "neutral",
  rejected: "critical",
  confirmed: "critical",
  forfeited: "critical",
  failed: "critical",
  declared_vs_received: "critical",
  received_vs_loaded: "critical",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{status.replaceAll("_", " ")}</Badge>;
}

export const th = "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted";
export const thNum = "px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted";
export const td = "px-3 py-2 align-top";
export const tdNum = "num px-3 py-2 text-right align-top";

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm [&_tbody_tr]:border-t [&_tbody_tr]:border-border">{children}</table>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted">{children}</p>;
}

export function Pagination({ page, total, pageSize, href }: { page: number; total: number; pageSize: number; href: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="mt-4 flex items-center justify-between text-sm text-muted">
      <span className="num">
        {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total.toLocaleString("en-IN")}
      </span>
      <div className="flex gap-2">
        {page > 1 && <Link className="rounded-md border border-border bg-surface px-3 py-1 hover:bg-zinc-50" href={href(page - 1)}>Previous</Link>}
        {page < pages && <Link className="rounded-md border border-border bg-surface px-3 py-1 hover:bg-zinc-50" href={href(page + 1)}>Next</Link>}
      </div>
    </div>
  );
}

export const inputClass =
  "rounded-md border border-border bg-white px-3 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20";
export const buttonClass =
  "inline-flex items-center justify-center rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-[#256abf] disabled:opacity-50";
export const secondaryButtonClass =
  "inline-flex items-center justify-center rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50";
export const dangerButtonClass =
  "inline-flex items-center justify-center rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100 disabled:opacity-50";

/** Builds a URL from the current filters, overriding some. */
export function withParams(path: string, current: Record<string, string | undefined>, changes: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...current, ...changes })) if (v !== undefined && v !== "") params.set(k, String(v));
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
