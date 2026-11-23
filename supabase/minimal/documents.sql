-- SPDX-License-Identifier: GPL-3.0-or-later
-- Copyright 2026 PushForm contributors
-- PushForm: minimal Supabase schema for sign-in, the account profile and cloud documents.
-- Recreated from the app's client code (packages/cloud/src/CloudFiles.ts, CloudProfile.ts) and generated
-- types (db.types.ts); the upstream migrations are not public. Not included: Commons, billing, AI Chat,
-- admin, exports, account deletion, analytics. The app treats those as "not set up" and keeps working.
--
-- Run once in the Supabase dashboard: SQL Editor > New query > paste > Run. It is safe to run again.

begin;

-- ---------- tables ----------

create table if not exists public.cloud_profiles (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  first_name text not null check (length(first_name) between 1 and 100),
  last_name text not null check (length(last_name) between 1 and 100),
  account_type text not null check (account_type in ('company', 'individual')),
  company_name text,
  company_size text,
  industry text not null,
  industry_other text,
  terms_version text not null,
  terms_accepted_at timestamptz not null default now(),
  completed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  analytics_opt_in boolean,
  analytics_updated_at timestamptz,
  mailing_opted_in_at timestamptz
);

create table if not exists public.cloud_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  created_at timestamptz not null default now(),
  trashed_at timestamptz,
  purge_after timestamptz,
  -- The id of the item whose trashing moved this row to the Trash; restoring that item restores the row.
  trash_op uuid
);
create unique index if not exists cloud_projects_name on public.cloud_projects (owner_id, lower(name)) where trashed_at is null;

create table if not exists public.cloud_folders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid not null references public.cloud_projects (id) on delete cascade,
  parent_id uuid references public.cloud_folders (id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  created_at timestamptz not null default now(),
  trashed_at timestamptz,
  purge_after timestamptz,
  trash_op uuid
);
create unique index if not exists cloud_folders_name on public.cloud_folders
  (project_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) where trashed_at is null;

create table if not exists public.cloud_documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid not null references public.cloud_projects (id) on delete cascade,
  folder_id uuid references public.cloud_folders (id) on delete set null,
  name text not null check (length(name) between 1 and 200),
  kind text not null check (kind in ('model', 'layout')),
  is_template boolean not null default false,
  client_key uuid,
  current_revision_id uuid,
  revision_number integer not null default 0,
  size_bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  trashed_at timestamptz,
  purge_after timestamptz,
  trash_op uuid
);
create unique index if not exists cloud_documents_client_key on public.cloud_documents (owner_id, client_key) where client_key is not null;
create index if not exists cloud_documents_list on public.cloud_documents (owner_id, project_id, updated_at desc);

create table if not exists public.cloud_revisions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  document_id uuid not null references public.cloud_documents (id) on delete cascade,
  parent_revision_id uuid references public.cloud_revisions (id) on delete set null,
  name text not null,
  number integer,
  status text not null default 'pending' check (status in ('pending', 'ready')),
  blob_path text not null unique,
  size_bytes bigint not null check (size_bytes between 1 and 104857600),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  change_notes text not null default '',
  created_at timestamptz not null default now(),
  committed_at timestamptz
);
create index if not exists cloud_revisions_document on public.cloud_revisions (document_id);

do $$ begin
  alter table public.cloud_documents add constraint cloud_documents_current_revision
    foreign key (current_revision_id) references public.cloud_revisions (id) on delete set null;
exception when duplicate_object then null; end $$;

-- ---------- row level security: everyone reads only their own rows; all writes go through the functions ----------

alter table public.cloud_profiles enable row level security;
alter table public.cloud_projects enable row level security;
alter table public.cloud_folders enable row level security;
alter table public.cloud_documents enable row level security;
alter table public.cloud_revisions enable row level security;

drop policy if exists own_rows on public.cloud_profiles;
create policy own_rows on public.cloud_profiles for select to authenticated using (owner_id = auth.uid());
drop policy if exists own_rows on public.cloud_projects;
create policy own_rows on public.cloud_projects for select to authenticated using (owner_id = auth.uid());
drop policy if exists own_rows on public.cloud_folders;
create policy own_rows on public.cloud_folders for select to authenticated using (owner_id = auth.uid());
drop policy if exists own_rows on public.cloud_documents;
create policy own_rows on public.cloud_documents for select to authenticated using (owner_id = auth.uid());
drop policy if exists own_rows on public.cloud_revisions;
create policy own_rows on public.cloud_revisions for select to authenticated using (owner_id = auth.uid());

revoke all on public.cloud_profiles, public.cloud_projects, public.cloud_folders, public.cloud_documents, public.cloud_revisions from anon, authenticated;
grant select on public.cloud_profiles, public.cloud_projects, public.cloud_folders, public.cloud_documents, public.cloud_revisions to authenticated;

-- ---------- helpers ----------

create or replace function public.cloud_uid() returns uuid language plpgsql stable set search_path = '' as $$
declare v uuid := auth.uid();
begin
  if v is null then raise exception 'cloud_auth: sign in required' using errcode = '28000'; end if;
  return v;
end $$;

create or replace function public.cloud_check_name(p_name text, p_max integer) returns text language plpgsql immutable set search_path = '' as $$
declare v text := btrim(coalesce(p_name, ''));
begin
  if v = '' or length(v) > p_max or v ~ '[\x00-\x1f\x7f/\\]' then raise exception 'cloud_invalid: name' using errcode = '23514'; end if;
  return v;
end $$;

create or replace function public.cloud_saved(p_revision uuid) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('file', to_jsonb(d), 'revision', to_jsonb(r))
  from public.cloud_revisions r join public.cloud_documents d on d.id = r.document_id where r.id = p_revision;
$$;

-- ---------- profile ----------

create or replace function public.cloud_save_profile_analytics(
  p_first_name text, p_last_name text, p_account_type text, p_company_name text, p_company_size text,
  p_industry text, p_industry_other text, p_terms_version text, p_analytics_opt_in boolean, p_mailing_opt_in boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := public.cloud_uid(); v_row public.cloud_profiles;
begin
  if p_terms_version is null and not exists (select 1 from public.cloud_profiles where owner_id = v_owner) then
    raise exception 'cloud_invalid: accept the terms' using errcode = '23514';
  end if;
  insert into public.cloud_profiles as p (owner_id, first_name, last_name, account_type, company_name, company_size, industry,
    industry_other, terms_version, analytics_opt_in, analytics_updated_at, mailing_opted_in_at)
  values (v_owner, btrim(p_first_name), btrim(p_last_name), p_account_type, nullif(btrim(p_company_name), ''), p_company_size, p_industry,
    nullif(btrim(p_industry_other), ''), p_terms_version, p_analytics_opt_in, case when p_analytics_opt_in is not null then now() end,
    case when p_mailing_opt_in then now() end)
  on conflict (owner_id) do update set
    first_name = excluded.first_name, last_name = excluded.last_name, account_type = excluded.account_type,
    company_name = excluded.company_name, company_size = excluded.company_size, industry = excluded.industry,
    industry_other = excluded.industry_other,
    terms_version = coalesce(p_terms_version, p.terms_version),
    terms_accepted_at = case when p_terms_version is not null and p_terms_version <> p.terms_version then now() else p.terms_accepted_at end,
    analytics_opt_in = coalesce(p_analytics_opt_in, p.analytics_opt_in),
    analytics_updated_at = case when p_analytics_opt_in is not null then now() else p.analytics_updated_at end,
    mailing_opted_in_at = case when p_mailing_opt_in then coalesce(p.mailing_opted_in_at, now()) else p.mailing_opted_in_at end,
    updated_at = now()
  returning * into v_row;
  return to_jsonb(v_row);
end $$;

create or replace function public.cloud_save_profile(
  p_first_name text, p_last_name text, p_account_type text, p_company_name text, p_company_size text,
  p_industry text, p_industry_other text, p_terms_version text, p_mailing_opt_in boolean default false)
returns jsonb language sql security definer set search_path = '' as $$
  select public.cloud_save_profile_analytics(p_first_name, p_last_name, p_account_type, p_company_name, p_company_size,
    p_industry, p_industry_other, p_terms_version, null, p_mailing_opt_in);
$$;

-- ---------- projects and folders ----------

create or replace function public.cloud_create_project(p_name text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.cloud_projects;
begin
  insert into public.cloud_projects (owner_id, name) values (public.cloud_uid(), public.cloud_check_name(p_name, 100)) returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'name', v_row.name);
end $$;

create or replace function public.cloud_live_project(p_project uuid) returns public.cloud_projects language plpgsql stable security definer set search_path = '' as $$
declare v_row public.cloud_projects;
begin
  select * into v_row from public.cloud_projects where id = p_project and owner_id = public.cloud_uid();
  if not found then raise exception 'cloud_not_found: project' using errcode = 'P0002'; end if;
  if v_row.trashed_at is not null then raise exception 'cloud_trashed_parent: project' using errcode = '23514'; end if;
  return v_row;
end $$;

create or replace function public.cloud_live_folder(p_folder uuid, p_project uuid) returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if p_folder is null then return; end if;
  if not exists (select 1 from public.cloud_folders where id = p_folder and project_id = p_project and owner_id = public.cloud_uid() and trashed_at is null) then
    raise exception 'cloud_not_found: folder' using errcode = 'P0002';
  end if;
end $$;

create or replace function public.cloud_create_folder(p_project uuid, p_parent uuid, p_name text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.cloud_folders;
begin
  perform public.cloud_live_project(p_project);
  perform public.cloud_live_folder(p_parent, p_project);
  insert into public.cloud_folders (owner_id, project_id, parent_id, name)
  values (public.cloud_uid(), p_project, p_parent, public.cloud_check_name(p_name, 100)) returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'project_id', v_row.project_id, 'parent_id', v_row.parent_id, 'name', v_row.name);
end $$;

-- ---------- saving: begin (pending revision) -> upload to storage -> commit ----------

create or replace function public.cloud_begin_save(
  p_project uuid, p_name text, p_kind text, p_size bigint, p_sha256 text,
  p_document uuid default null, p_parent uuid default null, p_folder uuid default null,
  p_client_key uuid default null, p_is_template boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := public.cloud_uid(); v_doc public.cloud_documents; v_rev public.cloud_revisions; v_name text := public.cloud_check_name(p_name, 200);
begin
  if p_kind not in ('model', 'layout') or p_size not between 1 and 104857600 or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'cloud_invalid: save' using errcode = '23514';
  end if;
  if p_document is null then
    perform public.cloud_live_project(p_project);
    perform public.cloud_live_folder(p_folder, p_project);
    if p_client_key is not null then
      select * into v_doc from public.cloud_documents where owner_id = v_owner and client_key = p_client_key;
    end if;
    if v_doc.id is null then
      insert into public.cloud_documents (owner_id, project_id, folder_id, name, kind, is_template, client_key)
      values (v_owner, p_project, p_folder, v_name, p_kind, coalesce(p_is_template, false), p_client_key) returning * into v_doc;
    elsif v_doc.current_revision_id is not null then
      -- A retried first save whose earlier attempt committed: hand back that revision.
      select * into v_rev from public.cloud_revisions where id = v_doc.current_revision_id;
      if v_rev.sha256 = p_sha256 then return to_jsonb(v_rev); end if;
      raise exception 'cloud_conflict: first save already recorded' using errcode = '40001';
    end if;
  else
    select * into v_doc from public.cloud_documents where id = p_document and owner_id = v_owner for update;
    if not found then raise exception 'cloud_not_found: document' using errcode = 'P0002'; end if;
    if v_doc.trashed_at is not null then raise exception 'cloud_trashed: document' using errcode = '23514'; end if;
    if v_doc.kind <> p_kind then raise exception 'cloud_invalid: kind' using errcode = '23514'; end if;
    if v_doc.current_revision_id is distinct from p_parent then raise exception 'cloud_conflict: newer revision' using errcode = '40001'; end if;
  end if;
  v_rev.id := gen_random_uuid();
  insert into public.cloud_revisions (id, owner_id, document_id, parent_revision_id, name, blob_path, size_bytes, sha256)
  values (v_rev.id, v_owner, v_doc.id, v_doc.current_revision_id, v_name, v_owner || '/' || v_doc.id || '/' || v_rev.id, p_size, p_sha256)
  returning * into v_rev;
  return to_jsonb(v_rev);
end $$;

create or replace function public.cloud_revision_notes(p_revision uuid, p_notes text) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.cloud_revisions set change_notes = left(coalesce(p_notes, ''), 4000)
  where id = p_revision and owner_id = public.cloud_uid() and status = 'pending';
  if not found then raise exception 'cloud_not_found: revision' using errcode = 'P0002'; end if;
end $$;

create or replace function public.cloud_commit_save(p_revision uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := public.cloud_uid(); v_rev public.cloud_revisions; v_doc public.cloud_documents;
begin
  select * into v_rev from public.cloud_revisions where id = p_revision and owner_id = v_owner for update;
  if not found then raise exception 'cloud_not_found: revision' using errcode = 'P0002'; end if;
  if v_rev.status = 'ready' then return public.cloud_saved(p_revision); end if;
  select * into v_doc from public.cloud_documents where id = v_rev.document_id for update;
  if v_doc.current_revision_id is distinct from v_rev.parent_revision_id then raise exception 'cloud_conflict: newer revision' using errcode = '40001'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'cloud-files' and name = v_rev.blob_path) then
    raise exception 'cloud_invalid: upload missing' using errcode = '23514';
  end if;
  update public.cloud_revisions set status = 'ready', number = v_doc.revision_number + 1, committed_at = now() where id = p_revision;
  update public.cloud_documents set current_revision_id = p_revision, revision_number = v_doc.revision_number + 1,
    size_bytes = v_rev.size_bytes, name = v_rev.name, updated_at = now() where id = v_doc.id;
  return public.cloud_saved(p_revision);
end $$;

create or replace function public.cloud_abort_save(p_revision uuid) returns void language plpgsql security definer set search_path = '' as $$
declare v_doc uuid;
begin
  delete from public.cloud_revisions where id = p_revision and owner_id = public.cloud_uid() and status = 'pending' returning document_id into v_doc;
  -- A first save that never committed leaves no document behind.
  delete from public.cloud_documents d where d.id = v_doc and d.current_revision_id is null
    and not exists (select 1 from public.cloud_revisions r where r.document_id = d.id);
end $$;

-- ---------- opening ----------

create or replace function public.cloud_open_file(p_document uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_doc public.cloud_documents;
begin
  select * into v_doc from public.cloud_documents where id = p_document and owner_id = public.cloud_uid();
  if not found or v_doc.current_revision_id is null then raise exception 'cloud_not_found: document' using errcode = 'P0002'; end if;
  if v_doc.trashed_at is not null then raise exception 'cloud_trashed: document' using errcode = '23514'; end if;
  return public.cloud_saved(v_doc.current_revision_id);
end $$;

create or replace function public.cloud_open_revision(p_revision uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rev public.cloud_revisions;
begin
  select * into v_rev from public.cloud_revisions where id = p_revision and owner_id = public.cloud_uid() and status = 'ready';
  if not found then raise exception 'cloud_not_found: revision' using errcode = 'P0002'; end if;
  return public.cloud_saved(p_revision);
end $$;

-- ---------- rename and move ----------

create or replace function public.cloud_rename_project(p_project uuid, p_name text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.cloud_projects;
begin
  update public.cloud_projects set name = public.cloud_check_name(p_name, 100) where id = p_project and owner_id = public.cloud_uid() returning * into v_row;
  if not found then raise exception 'cloud_not_found: project' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', v_row.id, 'name', v_row.name);
end $$;

create or replace function public.cloud_rename_folder(p_folder uuid, p_name text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.cloud_folders;
begin
  update public.cloud_folders set name = public.cloud_check_name(p_name, 100) where id = p_folder and owner_id = public.cloud_uid() returning * into v_row;
  if not found then raise exception 'cloud_not_found: folder' using errcode = 'P0002'; end if;
  return to_jsonb(v_row);
end $$;

create or replace function public.cloud_rename_document(p_document uuid, p_name text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.cloud_documents; v_name text := public.cloud_check_name(p_name, 200);
begin
  if v_name !~* '\.(pf|pfl)$' then raise exception 'cloud_invalid: extension' using errcode = '23514'; end if;
  update public.cloud_documents set name = v_name, updated_at = now() where id = p_document and owner_id = public.cloud_uid() returning * into v_row;
  if not found then raise exception 'cloud_not_found: document' using errcode = 'P0002'; end if;
  return to_jsonb(v_row);
end $$;

create or replace function public.cloud_move_document(p_document uuid, p_project uuid, p_folder uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.cloud_documents;
begin
  perform public.cloud_live_project(p_project);
  perform public.cloud_live_folder(p_folder, p_project);
  update public.cloud_documents set project_id = p_project, folder_id = p_folder, updated_at = now()
  where id = p_document and owner_id = public.cloud_uid() and trashed_at is null returning * into v_row;
  if not found then raise exception 'cloud_not_found: document' using errcode = 'P0002'; end if;
  return to_jsonb(v_row);
end $$;

create or replace function public.cloud_move_folder(p_folder uuid, p_parent uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.cloud_folders;
begin
  select * into v_row from public.cloud_folders where id = p_folder and owner_id = public.cloud_uid() and trashed_at is null;
  if not found then raise exception 'cloud_not_found: folder' using errcode = 'P0002'; end if;
  perform public.cloud_live_folder(p_parent, v_row.project_id);
  -- Refuse a move into itself or one of its own folders.
  if p_parent is not null and exists (
    with recursive up(id, parent_id) as (
      select id, parent_id from public.cloud_folders where id = p_parent
      union all select f.id, f.parent_id from public.cloud_folders f join up on f.id = up.parent_id)
    select 1 from up where id = p_folder) then
    raise exception 'cloud_invalid: folder cycle' using errcode = '23514';
  end if;
  update public.cloud_folders set parent_id = p_parent where id = p_folder returning * into v_row;
  return to_jsonb(v_row);
end $$;

-- ---------- Trash: kept 30 days; restore brings back everything trashed with the item ----------

create or replace function public.cloud_trash_project(p_project uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := public.cloud_uid();
begin
  update public.cloud_projects set trashed_at = now(), purge_after = now() + interval '30 days', trash_op = p_project
  where id = p_project and owner_id = v_owner and trashed_at is null;
  if not found then raise exception 'cloud_not_found: project' using errcode = 'P0002'; end if;
  update public.cloud_folders set trashed_at = now(), purge_after = now() + interval '30 days', trash_op = p_project
  where project_id = p_project and trashed_at is null;
  update public.cloud_documents set trashed_at = now(), purge_after = now() + interval '30 days', trash_op = p_project
  where project_id = p_project and trashed_at is null;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.cloud_trash_folder(p_folder uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := public.cloud_uid();
begin
  if not exists (select 1 from public.cloud_folders where id = p_folder and owner_id = v_owner and trashed_at is null) then
    raise exception 'cloud_not_found: folder' using errcode = 'P0002';
  end if;
  with recursive tree(id) as (
    select p_folder union all select f.id from public.cloud_folders f join tree on f.parent_id = tree.id where f.trashed_at is null)
  , folders as (
    update public.cloud_folders set trashed_at = now(), purge_after = now() + interval '30 days', trash_op = p_folder
    where id in (select id from tree) returning id)
  update public.cloud_documents set trashed_at = now(), purge_after = now() + interval '30 days', trash_op = p_folder
  where folder_id in (select id from tree) and trashed_at is null;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.cloud_trash_document(p_document uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  update public.cloud_documents set trashed_at = now(), purge_after = now() + interval '30 days', trash_op = p_document
  where id = p_document and owner_id = public.cloud_uid() and trashed_at is null;
  if not found then raise exception 'cloud_not_found: document' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.cloud_restore(p_kind text, p_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := public.cloud_uid(); v_project uuid;
begin
  if p_kind = 'project' then
    if not exists (select 1 from public.cloud_projects where id = p_id and owner_id = v_owner and trash_op = p_id) then raise exception 'cloud_not_trashed' using errcode = '23514'; end if;
  elsif p_kind = 'folder' then
    select project_id into v_project from public.cloud_folders where id = p_id and owner_id = v_owner and trash_op = p_id;
    if not found then raise exception 'cloud_not_trashed' using errcode = '23514'; end if;
    perform public.cloud_live_project(v_project);
  elsif p_kind = 'document' then
    select project_id into v_project from public.cloud_documents where id = p_id and owner_id = v_owner and trash_op = p_id;
    if not found then raise exception 'cloud_not_trashed' using errcode = '23514'; end if;
    perform public.cloud_live_project(v_project);
  else raise exception 'cloud_invalid: kind' using errcode = '23514'; end if;
  update public.cloud_projects set trashed_at = null, purge_after = null, trash_op = null where owner_id = v_owner and trash_op = p_id;
  update public.cloud_folders set trashed_at = null, purge_after = null, trash_op = null where owner_id = v_owner and trash_op = p_id;
  update public.cloud_documents set trashed_at = null, purge_after = null, trash_op = null where owner_id = v_owner and trash_op = p_id;
  -- A restored item whose folder is gone or still trashed lands at the project root.
  update public.cloud_documents d set folder_id = null where d.owner_id = v_owner and d.trashed_at is null and d.folder_id is not null
    and not exists (select 1 from public.cloud_folders f where f.id = d.folder_id and f.trashed_at is null);
  update public.cloud_folders c set parent_id = null where c.owner_id = v_owner and c.trashed_at is null and c.parent_id is not null
    and not exists (select 1 from public.cloud_folders f where f.id = c.parent_id and f.trashed_at is null);
  return jsonb_build_object('ok', true);
end $$;

-- Deletes the rows; the stored file bytes stay in the cloud-files bucket (Supabase does not allow deleting
-- storage objects from SQL). Empty the bucket folder from the dashboard if space matters.
create or replace function public.cloud_delete_forever(p_kind text, p_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := public.cloud_uid();
begin
  if p_kind = 'project' then
    delete from public.cloud_projects where id = p_id and owner_id = v_owner and trashed_at is not null;
  elsif p_kind = 'folder' then
    delete from public.cloud_documents where owner_id = v_owner and trash_op = p_id;
    delete from public.cloud_folders where owner_id = v_owner and trash_op = p_id;
  elsif p_kind = 'document' then
    delete from public.cloud_documents where id = p_id and owner_id = v_owner and trashed_at is not null;
  else raise exception 'cloud_invalid: kind' using errcode = '23514'; end if;
  if not found then raise exception 'cloud_not_trashed' using errcode = '23514'; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.cloud_list_trash() returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(item order by item->>'trashed_at' desc), '[]'::jsonb) from (
    select jsonb_build_object('kind', 'project', 'id', p.id, 'name', p.name, 'project_id', p.id, 'project_name', p.name, 'folder_id', null,
      'trashed_at', p.trashed_at, 'purge_after', p.purge_after) as item
    from public.cloud_projects p where p.owner_id = auth.uid() and p.trash_op = p.id
    union all
    select jsonb_build_object('kind', 'folder', 'id', f.id, 'name', f.name, 'project_id', f.project_id, 'project_name', p.name, 'folder_id', f.parent_id,
      'trashed_at', f.trashed_at, 'purge_after', f.purge_after)
    from public.cloud_folders f join public.cloud_projects p on p.id = f.project_id where f.owner_id = auth.uid() and f.trash_op = f.id
    union all
    select jsonb_build_object('kind', 'document', 'id', d.id, 'name', d.name, 'project_id', d.project_id, 'project_name', p.name, 'folder_id', d.folder_id,
      'trashed_at', d.trashed_at, 'purge_after', d.purge_after, 'document_kind', d.kind, 'is_template', d.is_template)
    from public.cloud_documents d join public.cloud_projects p on p.id = d.project_id where d.owner_id = auth.uid() and d.trash_op = d.id
  ) items;
$$;

create or replace function public.cloud_trashed_documents(p_ids uuid[]) returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(i), '{}') from unnest(p_ids) i
  where not exists (select 1 from public.cloud_documents d where d.id = i and d.owner_id = auth.uid() and d.trashed_at is null);
$$;

-- ---------- function permissions: signed-in users only ----------

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'cloud\_%' loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;

-- ---------- storage: private buckets, each account reads and writes only under its own id ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cloud-files', 'cloud-files', false, 104857600, null),
       ('cloud-thumbnails', 'cloud-thumbnails', false, 524288, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists pushform_own_read on storage.objects;
create policy pushform_own_read on storage.objects for select to authenticated
  using (bucket_id in ('cloud-files', 'cloud-thumbnails') and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists pushform_own_insert on storage.objects;
create policy pushform_own_insert on storage.objects for insert to authenticated
  with check (bucket_id in ('cloud-files', 'cloud-thumbnails') and (storage.foldername(name))[1] = auth.uid()::text);
-- Thumbnails are replaced in place (upsert).
drop policy if exists pushform_own_update on storage.objects;
create policy pushform_own_update on storage.objects for update to authenticated
  using (bucket_id = 'cloud-thumbnails' and (storage.foldername(name))[1] = auth.uid()::text);
-- File bytes may be removed only while their revision is still pending (a failed save cleaning up).
drop policy if exists pushform_own_delete on storage.objects;
create policy pushform_own_delete on storage.objects for delete to authenticated
  using ((storage.foldername(name))[1] = auth.uid()::text and (bucket_id = 'cloud-thumbnails'
    or (bucket_id = 'cloud-files' and exists (select 1 from public.cloud_revisions r where r.blob_path = name and r.status = 'pending'))));

commit;

notify pgrst, 'reload schema';
