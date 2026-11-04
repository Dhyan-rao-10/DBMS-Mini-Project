"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { buttonClass, dangerButtonClass, inputClass, secondaryButtonClass } from "./ui";

/** Interactive pieces. Every mutation goes through the app's Route Handlers (/api/...). */

export async function callApi<T = unknown>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined || body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null;
}

// ---------- navigation ----------

export function NavLinks({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {items.map((it) => {
        const active = it.href === "/" ? path === "/" : path.startsWith(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`rounded-md px-3 py-1.5 text-sm ${active ? "bg-accent/10 font-medium text-accent" : "text-zinc-700 hover:bg-zinc-100"}`}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="text-sm text-muted hover:text-foreground"
      onClick={async () => {
        await callApi("/api/auth/logout", "POST").catch(() => undefined);
        router.push("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}

// ---------- login ----------

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const { redirectTo } = await callApi<{ redirectTo: string }>("/api/auth/login", "POST", {
        email: form.get("email"),
        password: form.get("password"),
      });
      router.push(redirectTo);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input name="email" type="email" autoComplete="username" required className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Password
        <input name="password" type="password" autoComplete="current-password" required className={inputClass} />
      </label>
      <button type="submit" disabled={busy} className={`${buttonClass} mt-2`}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <ErrorText error={error} />
    </form>
  );
}

// ---------- generic one-click action ----------

export function ActionButton({
  url,
  method = "POST",
  body,
  children,
  variant = "primary",
  confirm,
  onDone,
}: {
  url: string;
  method?: string;
  body?: unknown;
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger";
  confirm?: string;
  onDone?: (data: unknown) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cls = variant === "primary" ? buttonClass : variant === "danger" ? dangerButtonClass : secondaryButtonClass;
  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        disabled={busy}
        className={cls}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          setError(null);
          try {
            const data = await callApi(url, method, body);
            onDone?.(data);
            router.refresh();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Working…" : children}
      </button>
      <ErrorText error={error} />
    </span>
  );
}
