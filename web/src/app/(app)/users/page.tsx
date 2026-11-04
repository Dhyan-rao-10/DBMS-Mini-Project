import type { Metadata } from "next";
import { ActionButton } from "@/components/client";
import { Badge, Card, PageHeader, Table, td, th } from "@/components/ui";
import { actorOf, requireUser } from "@/lib/auth";
import { listUsers } from "@/lib/services/admin";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  const user = await requireUser("admin");
  const users = await listUsers(actorOf(user));
  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Users are deactivated, never deleted (the audit trail refers to them). Deactivating ends every session the user has, immediately (Redis)."
      />
      <Card>
        <Table>
          <thead>
            <tr><th className={th}>Name</th><th className={th}>Email</th><th className={th}>Role</th><th className={th}>Linked to</th><th className={th}>Status</th><th className={th} /></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.user_id}>
                <td className={`${td} font-medium`}>{u.full_name}</td>
                <td className={`${td} text-muted`}>{u.email}</td>
                <td className={td}><Badge tone={u.role === "admin" ? "critical" : u.role === "staff" ? "info" : "neutral"}>{u.role}</Badge></td>
                <td className={`${td} text-muted`}>{u.contributor ?? (u.desk ? `${u.desk} desk` : "—")}</td>
                <td className={td}>{u.is_active ? <Badge tone="good">active</Badge> : <Badge>inactive</Badge>}</td>
                <td className={td}>
                  {u.user_id !== user.userId && (
                    <ActionButton url={`/api/users/${u.user_id}`} method="PATCH" body={{ active: !u.is_active }} variant={u.is_active ? "danger" : "secondary"}
                      confirm={u.is_active ? `Deactivate ${u.full_name}? They will be signed out everywhere.` : undefined}>
                      {u.is_active ? "Deactivate" : "Reactivate"}
                    </ActionButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
