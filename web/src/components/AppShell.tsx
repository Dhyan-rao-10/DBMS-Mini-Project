import type { ReactNode } from "react";
import type { CurrentUser } from "@/lib/auth";
import { LogoutButton, NavLinks } from "./client";

const NAV = {
  admin: [
    { href: "/", label: "Dashboard" },
    { href: "/tracks", label: "Tracks & splits" },
    { href: "/contributors", label: "Contributors" },
    { href: "/network", label: "Network" },
    { href: "/reports", label: "Reports & reconciliation" },
    { href: "/unmatched", label: "Unmatched lines" },
    { href: "/fraud", label: "Fraud review" },
    { href: "/payouts", label: "Payouts" },
    { href: "/audit", label: "Audit log" },
    { href: "/users", label: "Users" },
  ],
  staff: [
    { href: "/", label: "Dashboard" },
    { href: "/tracks", label: "Tracks & splits" },
    { href: "/contributors", label: "Contributors" },
    { href: "/network", label: "Network" },
    { href: "/reports", label: "Reports & reconciliation" },
    { href: "/unmatched", label: "Unmatched lines" },
  ],
  contributor: [{ href: "/me", label: "My royalties" }],
};

const ROLE_LABEL = { admin: "Admin", staff: "Label staff", contributor: "Contributor" };

export function AppShell({ user, children }: { user: CurrentUser; children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-border bg-surface px-3 py-5">
        <div className="mb-6 px-3">
          <div className="text-sm font-semibold">Monsoon Records</div>
          <div className="text-xs text-muted">Royalty splits &amp; payouts</div>
        </div>
        <NavLinks items={NAV[user.role]} />
        <div className="mt-auto border-t border-border px-3 pt-4">
          <div className="text-sm font-medium">{user.name}</div>
          <div className="mb-2 text-xs text-muted">{ROLE_LABEL[user.role]}</div>
          <LogoutButton />
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-8 py-7">{children}</main>
    </div>
  );
}
