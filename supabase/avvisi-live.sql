-- Bet Tracker 4.13.0 — RIACCENDE IL GIRO DEL SERVER (cron "bet-avvisi-live", ogni 2 minuti).
-- Un solo giro fa tutto: segnali live (solo prossimo gol 1° tempo e la sua quota raggiunta), avvisi sul telefono
-- e pronostici prepartita dei prossimi 3 giorni (Top, angoli, gol squadra, classifiche TotalCorner).
-- Toglie il giro solo prepartita (bet-prepartita) se c'era: tenerli tutti e due manderebbe troppe richieste a TotalCorner.
-- Da eseguire DOPO aver ripubblicato la funzione pronostici-avvisi con il file pronostici-avvisi.txt della 4.13.0.
-- Supabase > SQL Editor > New query > incolla tutto > Run. Si può rieseguire senza danni.
-- Non serve incollare nessuna password: usa il segreto del vecchio bet-avvisi-live o quello in pronostici_stato.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
declare segreto text;
begin
  select substring(command from '"x-cron-secret"\s*:\s*"([^"]+)"') into segreto
  from cron.job where jobname = 'bet-avvisi-live' limit 1;
  if segreto is null or segreto like 'INCOLLA%' then
    select v #>> '{}' into segreto from public.pronostici_stato where k = 'cron_secret';
  end if;
  if segreto is null or segreto = '' then
    raise exception 'Non trovo il segreto del giro: manca il cron bet-avvisi-live e anche cron_secret in pronostici_stato';
  end if;

  perform cron.unschedule(jobname) from cron.job where jobname in ('bet-prepartita', 'bet-avvisi-live');

  perform cron.schedule('bet-avvisi-live', '*/2 * * * *', format(
    $f$ select net.http_post(
          url     := 'https://thdlzqhqdktbkpnplxdm.supabase.co/functions/v1/pronostici-avvisi',
          headers := %L::jsonb,
          body    := '{}'::jsonb,
          timeout_milliseconds := 120000); $f$,
    json_build_object('Content-Type','application/json','x-cron-secret',segreto)::text));
end $$;

-- Per controllare:
--   select jobname, schedule, active from cron.job where jobname in ('bet-avvisi-live', 'bet-prepartita');
--   select status_code, left(content::text, 300) from net._http_response order by created desc limit 5;
-- Per spegnerlo di nuovo: select cron.unschedule('bet-avvisi-live');
