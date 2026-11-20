import type postgres from 'postgres';

/**
 * Get Canada Sim's `orders` and `partners` (and the `/track` change requests)
 * with production's columns, NOT NULL rules, defaults and checks (read from
 * the live catalog, 2026-10-27; `orders` rechecked 2026-11-20). No triggers,
 * and the runtime role gets no grant on them: only the import (run as
 * `postgres`) and the 0041 mirror's SECURITY DEFINER owner touch them. Shared
 * by the import and mirror suites, which take `GCS_TABLES_LOCK_KEY` for as
 * long as they use them.
 */
export const GCS_TABLES_DDL = `
  create table public.partners (
    id uuid primary key default gen_random_uuid(),
    partner_no bigint not null unique,
    company text not null,
    contact_name text not null,
    email text not null,
    phone text not null,
    website text,
    country text,
    business_type text,
    volume text,
    message text,
    status text not null default 'new'
      check (status in ('new', 'contacted', 'approved', 'declined')),
    created_at timestamptz not null default now(),
    license_path text,
    commission_rate numeric not null default 0,
    payment_settings jsonb
  );
  create table public.orders (
    id uuid primary key default gen_random_uuid(),
    order_no bigint not null unique,
    full_name text not null,
    email text not null,
    phone text not null,
    plan text,
    delivery text not null default 'esim' check (delivery in ('esim', 'pickup')),
    arrival date,
    permit_type text,
    reference text,
    notes text,
    passport_path text,
    permit_path text,
    status text not null default 'pending' check (status in (
      'incomplete', 'pending', 'verified', 'on_hold', 'delivered', 'activated',
      'completed', 'invoiced', 'paid', 'cancelled'
    )),
    created_at timestamptz not null default now(),
    partner_id uuid references public.partners (id),
    canada_address text,
    flight_booked boolean,
    partner_note text,
    partner_note_at timestamptz,
    admin_note text,
    admin_note_at timestamptz,
    shipping_address text,
    got_visa boolean,
    reminder_at date,
    reminder_note text,
    reminder_done_at timestamptz,
    archived_at timestamptz,
    sim_photo_path text,
    ip_address text,
    country_code text,
    sim_number text check (sim_number is null or char_length(sim_number) <= 40),
    billing_contract_path text,
    viewed_at timestamptz,
    commission_status text check (
      commission_status is null or commission_status in ('invoiced', 'commission_received', 'claw_back')
    )
  );
  create table public.order_edit_requests (
    id uuid primary key default gen_random_uuid(),
    request_no bigint generated always as identity,
    order_id uuid not null references public.orders (id) on delete cascade,
    email text not null,
    changes jsonb not null,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    reviewed_at timestamptz,
    created_at timestamptz not null default now()
  );
`;

// Next to the legacy CanadaWide tables' key (745284915).
export const GCS_TABLES_LOCK_KEY = 745284916;

/** Drops the three tables (a database without them is CI's and Canadian Plans'). */
export async function dropGetCanadaSimTables(admin: postgres.Sql): Promise<void> {
  await admin`drop table if exists public.order_edit_requests, public.orders, public.partners`;
}

/**
 * Takes the tables for one suite: waits for any other suite using them, then
 * creates them fresh. Session-level lock, so `admin` must be a
 * single-connection client; release it with `releaseGetCanadaSimTables`.
 */
export async function claimGetCanadaSimTables(admin: postgres.Sql): Promise<void> {
  await admin`select pg_advisory_lock(${GCS_TABLES_LOCK_KEY})`;
  await dropGetCanadaSimTables(admin);
  await admin.unsafe(GCS_TABLES_DDL);
}

export async function releaseGetCanadaSimTables(admin: postgres.Sql): Promise<void> {
  await dropGetCanadaSimTables(admin);
  await admin`select pg_advisory_unlock(${GCS_TABLES_LOCK_KEY})`;
}
