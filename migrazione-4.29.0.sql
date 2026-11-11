-- Bet Tracker 4.29.0 · server pronostici-avvisi 4.21.0 — MENO TRAFFICO SUPABASE (egress)
-- Lanciare UNA volta in Supabase › SQL Editor. Si può rilanciare senza problemi.
--
-- A ogni giro (ogni 2 minuti) il server degli avvisi leggeva TUTTO il salvataggio dell'app (scommesse, diario, storico
-- dei pronostici, registro dei segnali...) solo per sapere le impostazioni degli avvisi e i pronostici di oggi.
-- Questa funzione prepara nel database solo quello che serve al motore:
--   pronostici da 2 giorni prima a 2 giorni dopo, e del modello: avvisi, parametri (base, learned), statsFrom,
--   preferite live, giocate non in prova delle ultime 8 ore.
-- Se la funzione non c'è il server legge tutto come prima (funziona lo stesso, ma consuma di più).

create or replace function public.bet_alert_data(p_user uuid, p_from text, p_to text, p_since bigint)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'predModel', jsonb_build_object(
      'alerts',    d.data -> 'predModel' -> 'alerts',
      'base',      d.data -> 'predModel' -> 'base',
      'learned',   d.data -> 'predModel' -> 'learned',
      'statsFrom', d.data -> 'predModel' -> 'statsFrom',
      'liveStars', d.data -> 'predModel' -> 'liveStars',
      'playLog', (
        select coalesce(jsonb_agg(e), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(d.data -> 'predModel' -> 'playLog') = 'array' then d.data -> 'predModel' -> 'playLog' else '[]'::jsonb end) e
        where jsonb_typeof(e -> 't') = 'number' and (e ->> 't')::numeric >= p_since
          and coalesce(e ->> 'trial', 'false') not in ('true', '1')
      )
    ),
    'predictions', (
      select coalesce(jsonb_agg(m), '[]'::jsonb)
      from jsonb_array_elements(case when jsonb_typeof(d.data -> 'predictions') = 'array' then d.data -> 'predictions' else '[]'::jsonb end) m
      where m ->> 'date' between p_from and p_to
    )
  )
  from public.app_data d
  where d.app = 'bet' and d.user_id = p_user
$$;

-- solo il server (chiave service_role) la può chiamare
revoke all on function public.bet_alert_data(uuid, text, text, bigint) from public;
revoke all on function public.bet_alert_data(uuid, text, text, bigint) from anon, authenticated;
grant execute on function public.bet_alert_data(uuid, text, text, bigint) to service_role;

-- PostgREST rilegge le funzioni disponibili
notify pgrst, 'reload schema';

-- Controllo (deve dire 1):
select count(*) as funzione_ok from pg_proc where proname = 'bet_alert_data';
