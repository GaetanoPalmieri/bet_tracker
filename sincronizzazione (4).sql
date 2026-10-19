-- Bet Tracker — sincronizzazione: errore 400, codice 23514
-- "new row for relation app_data violates check constraint"
--
-- Causa: la tabella app_data (creata per Bilancio, RecompApp e Style) ha un controllo
-- che accetta solo i nomi delle app di allora. Bet Tracker salva con app = 'bet',
-- quindi la prima scrittura viene rifiutata.
--
-- Come si usa: Supabase > SQL Editor > New query > incolla tutto > Run.
-- Si puo' eseguire piu' volte senza danni. Non tocca i dati gia' salvati.

do $$
declare
  t text;
  c record;
begin
  foreach t in array array['app_data', 'app_data_history'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    -- toglie solo i controlli che riguardano la colonna "app"
    for c in
      select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid = ('public.' || t)::regclass
        and contype = 'c'
        and pg_get_constraintdef(oid) ~* '\mapp\M'
    loop
      raise notice 'Tolgo da %: % (%)', t, c.conname, c.def;
      execute format('alter table public.%I drop constraint %I', t, c.conname);
    end loop;
    -- e lo rimette con tutte le app della suite
    execute format(
      'alter table public.%I add constraint %I check (app in (''bilancio'', ''recomp'', ''style'', ''bet''))',
      t, t || '_app_check');
  end loop;
end $$;

-- Controllo finale: i vincoli rimasti sulle due tabelle
select conrelid::regclass as tabella, conname as vincolo, pg_get_constraintdef(oid) as regola
from pg_constraint
where conrelid in (to_regclass('public.app_data'), to_regclass('public.app_data_history'))
  and contype = 'c';
