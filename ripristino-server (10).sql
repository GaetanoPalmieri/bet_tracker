-- Bet Tracker 4.26.1 — RIPRISTINO DEL SERVER dopo la cancellazione delle tabelle (9/11/2026).
-- Ricrea le tabelle dei pronostici (vuote), crea un nuovo segreto del giro e riaccende il cron "bet-avvisi-live"
-- (ogni 2 minuti: partite live, segnali, avvisi sul telefono, pronostici prepartita).
-- Supabase › SQL Editor › New query › incolla tutto › Run. Si può rieseguire senza danni (non cancella niente).
-- Le funzioni pronostici-avvisi e pronostici-dati devono essere pubblicate (lo sono già: rispondono all'app).

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- 1) Stato del giro (cache delle partite live, prepartita, segreto del cron…)
create table if not exists public.pronostici_stato (
  k          text primary key,
  v          jsonb,
  updated_at timestamptz not null default now()
);

-- 2) Segnali live salvati per utente (arrivano nell'app e servono all'export)
create table if not exists public.pronostici_segnali (
  user_id    uuid not null references auth.users(id) on delete cascade,
  key        text not null,
  tier       text,
  data       jsonb,
  pushed     text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
create index if not exists pronostici_segnali_upd on public.pronostici_segnali (user_id, updated_at);
create index if not exists pronostici_segnali_at  on public.pronostici_segnali (created_at);

-- 3) Traccia minuto per minuto delle partite live (14 giorni)
create table if not exists public.pronostici_traccia (
  id         bigserial primary key,
  af_id      text not null,
  min        int,
  st         text,
  league     text,
  home       text,
  away       text,
  d          jsonb,
  created_at timestamptz not null default now()
);
create index if not exists pronostici_traccia_at    on public.pronostici_traccia (created_at);
create index if not exists pronostici_traccia_af_at on public.pronostici_traccia (af_id, created_at);

-- 4) Partite finite: gol e angoli finali (120 giorni)
create table if not exists public.pronostici_finali (
  af_id         text primary key,
  league        text,
  home          text,
  away          text,
  kickoff       timestamptz,
  last_min      int,
  goals         jsonb,
  ht            jsonb,
  corners       jsonb,
  ht_corners    jsonb,
  goal_list     jsonb,
  confirmed     boolean not null default false,
  confirmed_at  timestamptz,
  source        text,
  model_version text,
  created_at    timestamptz not null default now()
);
create index if not exists pronostici_finali_home on public.pronostici_finali (home);
create index if not exists pronostici_finali_away on public.pronostici_finali (away);
create index if not exists pronostici_finali_at   on public.pronostici_finali (created_at);
create index if not exists pronostici_finali_confirmed_league on public.pronostici_finali (confirmed, league);

-- 5) Storico quote TotalCorner (per i backtest)
create table if not exists public.pronostici_storico_quote (
  af_id text primary key, league text, home text, away text, kickoff timestamptz,
  goals jsonb, ht jsonb, corners jsonb, ht_corners jsonb, red jsonb,
  gl jsonb, glh jsonb, cl jsonb, clh jsonb, x12 jsonb, ah jsonb,
  created_at timestamptz not null default now()
);
create index if not exists pronostici_storico_quote_ko on public.pronostici_storico_quote (kickoff);
create index if not exists pronostici_storico_quote_lg on public.pronostici_storico_quote (league);
create index if not exists pronostici_storico_quote_at on public.pronostici_storico_quote (created_at);

-- Solo le funzioni (chiave di servizio) leggono e scrivono queste tabelle.
alter table public.pronostici_stato         enable row level security;
alter table public.pronostici_segnali       enable row level security;
alter table public.pronostici_traccia       enable row level security;
alter table public.pronostici_finali        enable row level security;
alter table public.pronostici_storico_quote enable row level security;

-- 6) Telefoni iscritti alle notifiche (in comune con Bilancio: se c'è già non cambia niente)
create table if not exists public.push_subscriptions (
  id            bigserial primary key,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  app           text not null default 'bilancio',
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  tz            text not null default 'Europe/Rome',
  notify_hour   int  not null default 20 check (notify_hour between 0 and 23),
  show_amounts  boolean not null default false,
  enabled       boolean not null default true,
  last_sent_day date,
  device        text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "push: solo le mie" on public.push_subscriptions;
create policy "push: solo le mie" on public.push_subscriptions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 7) Nuovo segreto del giro (resta nella tabella, nessuna password da copiare) e cron ogni 2 minuti
insert into public.pronostici_stato (k, v)
values ('cron_secret', to_jsonb(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')))
on conflict (k) do nothing;

do $$
declare segreto text;
begin
  select v #>> '{}' into segreto from public.pronostici_stato where k = 'cron_secret';
  perform cron.unschedule(jobname) from cron.job where jobname in ('bet-prepartita', 'bet-avvisi-live');
  perform cron.schedule('bet-avvisi-live', '*/2 * * * *', format(
    $f$ select net.http_post(
          url     := 'https://thdlzqhqdktbkpnplxdm.supabase.co/functions/v1/pronostici-avvisi',
          headers := %L::jsonb,
          body    := '{}'::jsonb,
          timeout_milliseconds := 120000); $f$,
    json_build_object('Content-Type','application/json','x-cron-secret',segreto)::text));
end $$;

-- CONTROLLI (dopo 4-5 minuti):
--   select jobname, schedule, active from cron.job where jobname = 'bet-avvisi-live';            -- una riga, active = true
--   select status_code, left(content::text, 300), created from net._http_response order by created desc limit 5;  -- 200
--   select k, updated_at from public.pronostici_stato order by updated_at desc limit 10;           -- tcLive appena aggiornato
