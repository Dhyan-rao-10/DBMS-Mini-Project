"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { num } from "@/lib/format";
import { ErrorText, callApi } from "./client";
import { buttonClass, dangerButtonClass, inputClass, secondaryButtonClass } from "./ui";

// ---------- platform report upload ----------

export function UploadForm({ platforms, months }: { platforms: { code: string; name: string; format: string }[]; months: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await callApi<{ lines: number; matchedTracks: number; unmatchedLines: number }>("/api/reports", "POST", new FormData(form));
      setDone(`${num(r.lines)} lines stored in MongoDB; ${num(r.matchedTracks)} tracks loaded into PostgreSQL, ${num(r.unmatchedLines)} lines need matching.`);
      form.reset();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs text-muted">
        Platform
        <select name="platform" required className={inputClass}>
          {platforms.map((p) => (
            <option key={p.code} value={p.code}>{p.name} ({p.format})</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Month
        <select name="month" required className={inputClass}>
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Report file
        <input name="file" type="file" accept=".csv,.json,text/csv,application/json" required className="text-sm" />
      </label>
      <button type="submit" disabled={busy} className={buttonClass}>{busy ? "Loading…" : "Upload & load"}</button>
      <div className="basis-full">
        <ErrorText error={error} />
        {done && <p className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{done}</p>}
      </div>
    </form>
  );
}

// ---------- unmatched line: pick a suggestion or a track id ----------

export function MatchActions({
  lineId,
  suggestions,
}: {
  lineId: string;
  suggestions: { track_id: number; title: string; similarity: number; confidence: string }[];
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<string>(suggestions[0] && suggestions[0].confidence !== "weak" ? String(suggestions[0].track_id) : "");
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(body: unknown) {
    setBusy(true);
    setError(null);
    try {
      await callApi(`/api/unmatched/${lineId}`, "POST", body);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  const trackId = manual.trim() || choice;

  return (
    <div>
      <div className="flex flex-col gap-1">
        {suggestions.map((s) => (
          <label key={s.track_id} className="flex items-center gap-2 text-sm">
            <input type="radio" name={`line-${lineId}`} checked={choice === String(s.track_id) && !manual} onChange={() => { setChoice(String(s.track_id)); setManual(""); }} />
            <span className="flex-1">{s.title}</span>
            <span className={`num rounded px-1.5 text-xs ${s.confidence === "likely" ? "bg-emerald-50 text-emerald-800" : s.confidence === "possible" ? "bg-amber-50 text-amber-800" : "bg-zinc-100 text-zinc-600"}`}>
              {s.similarity.toFixed(3)} {s.confidence}
            </span>
          </label>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="or track id" className={`${inputClass} w-28`} inputMode="numeric" />
        <button type="button" disabled={busy || !trackId} className={buttonClass} onClick={() => act({ action: "confirm", trackId: Number(trackId) })}>
          Confirm match
        </button>
        <button type="button" disabled={busy} className={dangerButtonClass} onClick={() => window.confirm("Write this line off? Its money will not be paid to anyone.") && act({ action: "write_off" })}>
          Write off
        </button>
      </div>
      <ErrorText error={error} />
    </div>
  );
}

// ---------- fraud review ----------

export function FlagReview({ trackId, periodStart }: { trackId: number; periodStart: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function decide(status: "cleared" | "confirmed") {
    setBusy(true);
    setError(null);
    try {
      await callApi("/api/fraud", "POST", { trackId, periodStart, status, note });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (required), e.g. playlist campaign verified" className={`${inputClass} w-full`} />
      <div className="flex gap-2">
        <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => decide("cleared")}>Clear: release money</button>
        <button type="button" disabled={busy} className={dangerButtonClass} onClick={() => decide("confirmed")}>Confirm fraud: forfeit</button>
      </div>
      <ErrorText error={error} />
    </div>
  );
}
