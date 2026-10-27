import type postgres from 'postgres';

/**
 * Replicas of CanadaWide's legacy lead tables (public.internet_leads,
 * public.mobility_leads and public.mobility_id_uploads) with production's
 * columns, NOT NULL rules, defaults and checks, for the suites that exercise
 * the 0002 and 0005 mirrors and the historical import. The runtime role gets
 * no grant on them: only the SECURITY DEFINER owners and the import (run as
 * `postgres`) touch them.
 */
export const LEGACY_TABLES_DDL = `
  create table if not exists public.internet_leads (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    plan text not null,
    landing_city text,
    date_of_birth date not null,
    email text not null,
    phone text not null,
    street_address text not null,
    apt_unit text,
    city text not null,
    postal_code text,
    current_provider text,
    consent boolean not null default false,
    consented_at timestamptz,
    status text not null default 'new',
    notes text,
    notes_updated_at timestamptz,
    reminder_at date,
    reminder_note text,
    reminder_done_at timestamptz,
    full_name text not null,
    preferred_installation_time text,
    deleted_at timestamptz,
    plan_id text
  );
  create table if not exists public.mobility_leads (
    id uuid primary key,
    full_name text not null,
    email text not null,
    phone text not null,
    keep_number boolean not null,
    sim_type text not null check (sim_type in ('esim', 'physical')),
    street_address text not null,
    city text not null,
    postal_code text not null,
    created_at timestamptz not null default now(),
    plan_id text,
    line_count smallint check (line_count between 1 and 10),
    status text not null default 'new',
    notes text,
    notes_updated_at timestamptz,
    reminder_at date,
    reminder_note text,
    reminder_done_at timestamptz,
    deleted_at timestamptz,
    current_provider text check (char_length(current_provider) <= 60),
    apt_unit text check (char_length(apt_unit) <= 40),
    first_name text check (char_length(first_name) <= 80),
    last_name text check (char_length(last_name) <= 80)
  );
  create table if not exists public.mobility_id_uploads (
    id uuid primary key,
    lead_id uuid not null references public.mobility_leads (id) on delete cascade,
    id_type text not null
      check (id_type in ('drivers-licence', 'provincial-id', 'passport', 'sin')),
    id_file_path text,
    credit_check_consent boolean not null check (credit_check_consent),
    consented_at timestamptz not null,
    created_at timestamptz not null default now(),
    sin text,
    date_of_birth date,
    constraint mobility_id_uploads_sin_or_file_check check (
      (id_type = 'sin' and sin ~ '^[0-9]{9}$' and id_file_path is null)
      or (id_type <> 'sin' and sin is null and id_file_path is not null)
    ),
    constraint mobility_id_uploads_sin_date_of_birth_check check (
      (id_type = 'sin' and date_of_birth is not null and date_of_birth >= '1900-01-01')
      or (id_type <> 'sin' and date_of_birth is null)
    )
  );
`;

// Next to the runtime-password key (745284914) in packages/db/src/test-helpers.ts.
const LEGACY_TABLES_LOCK_KEY = 745284915;

/**
 * Takes the legacy tables for one suite: waits for any other suite using
 * them, then creates them fresh. Both mirror and import suites share the
 * database and the `canadawide` slug, so they must not run at once. The lock
 * is session-level, so `admin` must be a single-connection client; release it
 * with `releaseLegacyTables`.
 */
export async function claimLegacyTables(admin: postgres.Sql): Promise<void> {
  await admin`select pg_advisory_lock(${LEGACY_TABLES_LOCK_KEY})`;
  await admin`drop table if exists public.mobility_id_uploads, public.internet_leads, public.mobility_leads`;
  await admin.unsafe(LEGACY_TABLES_DDL);
}

export async function releaseLegacyTables(admin: postgres.Sql): Promise<void> {
  await admin`drop table if exists public.mobility_id_uploads, public.internet_leads, public.mobility_leads`;
  await admin`select pg_advisory_unlock(${LEGACY_TABLES_LOCK_KEY})`;
}
