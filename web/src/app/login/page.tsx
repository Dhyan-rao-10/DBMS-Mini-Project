import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/client";
import { getCurrentUser, homeFor } from "@/lib/auth";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect(homeFor(user.role));
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-7 shadow-sm">
        <h1 className="text-xl font-semibold">Monsoon Records</h1>
        <p className="mb-6 mt-1 text-sm text-muted">Royalty splits &amp; payouts. Sign in to continue.</p>
        <LoginForm />
      </div>
    </div>
  );
}
