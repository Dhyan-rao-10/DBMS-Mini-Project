import { withTx, type Actor } from "../db/pg";

/**
 * The contributor portal. Runs as app_contributor, which can read nothing but
 * the v_my_* views, so a contributor can only ever see their own rows.
 */

export interface PendingProposal {
  version_id: number;
  isrc: string;
  title: string;
  valid_from: string;
  shares: { legal_name: string; role: string; share_pct: string; is_me: boolean }[];
}

export async function myOverview(actor: Actor) {
  return withTx(actor, async (c) => {
    const statements = await c.query("SELECT * FROM v_my_statements ORDER BY period_start DESC");
    const splits = await c.query("SELECT * FROM v_my_splits ORDER BY status = 'active' DESC, valid_from DESC, title");
    const advances = await c.query("SELECT * FROM v_my_advances ORDER BY issued_on");
    const pending = await c.query<PendingProposal>(
      `SELECT version_id, isrc, title, valid_from::text,
              json_agg(json_build_object('legal_name', legal_name, 'role', role, 'share_pct', share_pct, 'is_me', is_me)
                       ORDER BY share_pct DESC) AS shares
       FROM v_my_pending_proposals
       GROUP BY version_id, isrc, title, valid_from
       ORDER BY valid_from`,
    );
    return { statements: statements.rows, splits: splits.rows, advances: advances.rows, pending: pending.rows };
  });
}

export async function myStatementLines(actor: Actor, statementId: number) {
  const { rows } = await withTx(actor, (c) =>
    c.query("SELECT * FROM v_my_statement_lines WHERE statement_id = $1 ORDER BY line_no", [statementId]),
  );
  return rows;
}
