import { contextWorkspaceId, withTenantTx, type DatabaseClient } from '@gt-sales/db';
import { MAILBOX_PAGE_SIZE, mailboxItemSchema, type MailboxItem } from '@gt-sales/contracts';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { MAIL_STATUS, iso, toLeadActivity } from '../leads/staff-queries.js';
import type { Scope } from '../tenant-scope.js';

/**
 * Mail → the site's sent mail. One page of the `customer_emailed` timeline
 * entries of active, unrestricted leads: each customer's latest (with how many
 * they were sent), or one customer's, newest first, each with its lead and how
 * the send went. The entry is read exactly as the lead page reads it
 * (`toLeadActivity`), so both show the same subject, text and status.
 * Reads only.
 */
export interface MailboxPage {
  readonly items: readonly MailboxItem[];
  readonly total: number;
}

export interface MailboxStore {
  /** Without `leadId`: each customer's latest mail. With it: that customer's mails. */
  list(scope: Scope, input: { page: number; leadId?: string }): Promise<MailboxPage>;
}

const rowSchema = z.object({
  id: z.uuid(),
  actorId: z.uuid(),
  kind: z.string(),
  body: z.string().nullable(),
  data: z.unknown(),
  createdAt: z.string(),
  mailStatus: z.string().nullable(),
  leadId: z.uuid(),
  leadType: z.string(),
  leadName: z.string().nullable(),
  mails: z.coerce.number().int().positive().nullable(),
  total: z.coerce.number().int().nonnegative(),
});

export class DatabaseMailbox implements MailboxStore {
  constructor(private readonly database: Pick<DatabaseClient, 'withTenantTx'> = { withTenantTx }) {}

  list(scope: Scope, input: { page: number; leadId?: string }): Promise<MailboxPage> {
    const offset = (input.page - 1) * MAILBOX_PAGE_SIZE;
    return this.database.withTenantTx(scope, async (tx) => {
      await tx.execute(sql`set transaction read only`);
      await tx.execute(sql`select set_config('statement_timeout', '5000', true)`);
      const columns = sql`
        a.id, a.actor_id as "actorId", a.kind, a.body, a.data,
        a.created_at as at,
        ${MAIL_STATUS} as "mailStatus",
        l.id as "leadId", l.lead_type as "leadType",
        coalesce(l.full_name, l.email) as "leadName"
      `;
      const source = sql`
        from app.lead_activities a
        join app.leads l on l.workspace_id = a.workspace_id and l.id = a.lead_id
        where a.workspace_id = ${contextWorkspaceId}
          and a.kind = 'system'
          and a.data ->> 'event' = 'customer_emailed'
          and l.deleted_at is null
          and l.customer_data_restricted_at is null
      `;
      const rows = await tx.execute<{ [key: string]: unknown }>(
        input.leadId
          ? sql`
              select m.*, ${iso('m.at')} as "createdAt", null::bigint as mails,
                count(*) over () as total
              from (select ${columns} ${source} and l.id = ${input.leadId}) m
              order by m.at desc, m.id desc
              limit ${MAILBOX_PAGE_SIZE} offset ${offset}
            `
          : sql`
              select m.*, ${iso('m.at')} as "createdAt", count(*) over () as total
              from (
                select distinct on (a.lead_id) ${columns},
                  count(*) over (partition by a.lead_id) as mails
                ${source}
                order by a.lead_id, a.created_at desc, a.id desc
              ) m
              order by m.at desc, m.id desc
              limit ${MAILBOX_PAGE_SIZE} offset ${offset}
            `,
      );
      const parsed = rows.map((row) => rowSchema.parse(row));
      const items = parsed.flatMap((row) => {
        const entry = toLeadActivity(row);
        if (entry.kind !== 'system' || entry.event !== 'customer_emailed') return [];
        // A row this version cannot show (say, a newer lead type) is left out
        // rather than failing the page.
        const item = mailboxItemSchema.safeParse({
          id: entry.id,
          createdAt: entry.createdAt,
          actorId: entry.actorId,
          viaAi: entry.viaAi,
          automation: entry.automation,
          automationName: entry.automationName,
          template: entry.template,
          templateName: entry.templateName,
          subject: entry.subject,
          text: entry.text,
          textCut: entry.textCut,
          mailStatus: entry.mailStatus,
          ...(row.mails === null ? {} : { mails: row.mails }),
          lead: { id: row.leadId, leadType: row.leadType, name: row.leadName },
        });
        return item.success ? [item.data] : [];
      });
      return { items, total: parsed[0]?.total ?? 0 };
    });
  }
}
