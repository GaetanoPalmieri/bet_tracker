-- Bet Tracker 2.1.0 — giro orario del promemoria serale "Segna il saldo di oggi".
-- Da eseguire DOPO aver pubblicato la funzione notify-bet (passo 3 della guida).
-- Non serve incollare nessuna password: usa lo stesso segreto del cron di Bilancio
-- (o, se manca, quello del promemoria peso di RecompApp).
-- La tabella push_subscriptions esiste già (creata per Bilancio): non va toccata.
-- Gira ogni ora al minuto 15: la funzione decide da sola a chi tocca, in base all'ora scelta nell'app.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
declare segreto text;
begin
  select substring(command from '"x-cron-secret":"([^"]+)"') into segreto
  from cron.job where jobname in ('bilancio-scadenze', 'gym-pesoreminder')
  order by (jobname = 'bilancio-scadenze') desc limit 1;
  if segreto is null or segreto like 'INCOLLA%' then
    raise exception 'Non trovo il segreto: prima vanno attivate le notifiche di Bilancio o di RecompApp';
  end if;

  perform cron.unschedule('bet-promemoria')
  where exists (select 1 from cron.job where jobname = 'bet-promemoria');

  perform cron.schedule('bet-promemoria', '15 * * * *', format(
    $f$ select net.http_post(
          url     := 'https://thdlzqhqdktbkpnplxdm.supabase.co/functions/v1/notify-bet',
          headers := %L::jsonb,
          body    := '{}'::jsonb); $f$,
    json_build_object('Content-Type','application/json','x-cron-secret',segreto)::text));
end $$;

-- Per controllare: select jobname, schedule from cron.job where jobname = 'bet-promemoria';
