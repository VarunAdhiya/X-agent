begin;
alter table agent.automation_settings drop column gemini_daily_limit;
create or replace function agent.command(op text, p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = pg_catalog, agent as $$
declare
  s agent.automation_settings%rowtype;
  d agent.tweet_drafts%rowtype;
  t agent.topics%rowtype;
  a agent.publication_attempts%rowtype;
  g agent.generation_runs%rowtype;
  e agent.edit_sessions%rowtype;
  v jsonb; result jsonb; rec record; ident uuid;
  today date := (now() at time zone 'Asia/Kolkata')::date;
  actor text := p->>'actor';
begin
  -- A single short transaction lock serializes claims and the daily budget.
  -- No HTTP call is made while this lock is held.
  select * into s from agent.automation_settings where id for update;
  if op='settings' then
    return to_jsonb(s);
  elsif op='context' then
    return jsonb_build_object('settings',to_jsonb(s),'day',today,
      'topics',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from agent.topics
        where created_at>now()-interval '14 days' order by relevance_score desc limit 200) x),'[]'::jsonb),
      'recent',coalesce((select jsonb_agg(to_jsonb(x)) from (select id,topic_id,content,created_at from agent.tweet_drafts
        where created_at>now()-interval '14 days') x),'[]'::jsonb));
  elsif op='topics' then
    if s.paused or not s.generation_enabled then return '{"skipped":true}'; end if;
    for v in select value from jsonb_array_elements(p->'topics') loop
      -- One article URL can acquire a new headline; do not abort the whole batch.
      if v->>'source_url' is not null and exists(select 1 from agent.topics
        where source_url=v->>'source_url' and fingerprint<>v->>'fingerprint') then continue; end if;
      insert into agent.topics(title,category,source,source_url,fingerprint,published_at,relevance_score,evidence)
      values(v->>'title',v->>'category',v->>'source',v->>'source_url',v->>'fingerprint',
        (v->>'published_at')::timestamptz,(v->>'relevance_score')::float8,coalesce(v->'evidence','{}'))
      on conflict(fingerprint) do update set created_at=now(),evidence=excluded.evidence,
        relevance_score=excluded.relevance_score,published_at=excluded.published_at
      where not exists(select 1 from agent.tweet_drafts where topic_id=topics.id and created_at>now()-interval '14 days');
    end loop;
  elsif op='generation_start' then
    if s.paused or not s.generation_enabled then return '{"skipped":true}'; end if;
    if coalesce(p->>'mode','scheduled') not in ('scheduled','manual') then raise exception 'invalid generation mode'; end if;
    if p->>'mode'='manual' then
      if coalesce(p->>'request_id','') !~ '^[A-Za-z0-9:_-]{1,120}$' then raise exception 'manual request ID required'; end if;
      insert into agent.generation_runs(day,state,mode,request_id) values(today,'running','manual',p->>'request_id')
        on conflict(request_id) do update set state='running',token=gen_random_uuid(),started_at=now()
        where generation_runs.state='failed' or (generation_runs.state='running' and generation_runs.started_at<now()-interval '10 minutes')
        returning * into g;
    else
      insert into agent.generation_runs(day,state) values(today,'running')
        on conflict(day) where mode='scheduled' do update set state='running',token=gen_random_uuid(),started_at=now()
        where generation_runs.state='failed' or (generation_runs.state='running' and generation_runs.started_at<now()-interval '10 minutes')
        returning * into g;
    end if;
    if g.id is null then return '{"skipped":true,"reason":"batch_already_started_or_complete"}'; end if;
    return to_jsonb(g);
  elsif op='generation_fail' then
    update agent.generation_runs set state='failed' where token=(p->>'token')::uuid and state='running';
  elsif op='generation_save' then
    select * into g from agent.generation_runs where token=(p->>'token')::uuid and state='running';
    if g.day is null or g.day<>today or s.paused or not s.generation_enabled then raise exception 'generation lease invalid'; end if;
    if jsonb_typeof(p->'drafts') is distinct from 'array' or jsonb_array_length(p->'drafts') is distinct from 5 then raise exception 'exactly five drafts required'; end if;
    for v in select value from jsonb_array_elements(p->'drafts') loop
      if (v->'validation'->>'valid')::boolean is distinct from true then raise exception 'invalid content'; end if;
      if not exists(select 1 from agent.topics where id=(v->>'topic_id')::uuid) then raise exception 'unknown topic'; end if;
      insert into agent.tweet_drafts(topic_id,generation_day,generation_run_id,slot,content,content_hash,category,scheduled_at,source_urls,rationale,validation)
      values((v->>'topic_id')::uuid,g.day,g.id,(v->>'slot')::int,v->>'content',v->>'content_hash',v->>'category',
        case when g.mode='scheduled' then (g.day::text||' '||(array['10:00','13:00','16:00','19:00','22:00'])[(v->>'slot')::int+1])::timestamp at time zone 'Asia/Kolkata' else null end,
        v->'source_urls',v->>'rationale',v->'validation') returning * into d;
      insert into agent.tweet_revisions(tweet_id,version,content,content_hash,revision_type) values(d.id,1,d.content,d.content_hash,'generated');
      insert into agent.outbox(dedupe_key,payload) values('draft:'||d.id||':1',jsonb_build_object('kind','draft','id',d.id,'version',1));
    end loop;
    update agent.generation_runs set state='complete' where id=g.id;
    return jsonb_build_object('generated',5,'day',g.day);
  elsif op='gemini_budget' then
    if s.paused or not s.generation_enabled then raise exception 'generation disabled'; end if;
    insert into agent.api_usage(day,gemini_calls,last_call_at) values(today,1,now())
      on conflict(day) do update set gemini_calls=api_usage.gemini_calls+1,last_call_at=now()
      where api_usage.last_call_at<now()-interval '15 seconds'
      returning day into rec;
    if not found then raise exception 'Gemini local pacing limit'; end if;
  elsif op='draft' then
    select * into d from agent.tweet_drafts where id=(p->>'id')::uuid;
    return to_jsonb(d);
  elsif op='ingest' then
    if (p->>'actor'=any(s.telegram_user_ids)) is distinct from true or p->>'chat_id' is distinct from s.telegram_chat_id then raise exception 'unauthorized'; end if;
    insert into agent.inbox(update_id,payload) values((p->>'update_id')::bigint,p->'payload') on conflict do nothing;
  elsif op in ('inbox_claim','outbox_claim') then
    if op='inbox_claim' then
      update agent.inbox set state='processing',attempts=attempts+1,leased_at=now() where update_id=(
        select update_id from agent.inbox where attempts<3 and (state='pending' or
          (state='processing' and leased_at<now()-interval '5 minutes')) order by update_id limit 1)
        returning to_jsonb(inbox) into result;
    else
      update agent.outbox set state='processing',attempts=attempts+1,leased_at=now() where id=(
        select id from agent.outbox where attempts<5 and (state='pending' or
          (state='processing' and leased_at<now()-interval '5 minutes')) order by id limit 1)
        returning to_jsonb(outbox) into result;
    end if;
    return result;
  elsif op='inbox_done' then
    update agent.inbox set state='done' where update_id=(p->>'id')::bigint;
  elsif op='outbox_done' then
    update agent.outbox set state='done' where id=(p->>'id')::bigint;
  elsif op='message_sent' then
    update agent.tweet_drafts set telegram_chat_id=p->>'chat_id',telegram_message_id=(p->>'message_id')::bigint
      where id=(p->>'id')::uuid and content_version=(p->>'version')::int;
  elsif op in ('approve','reject','begin_edit','begin_regenerate','revise','edit_prompt','edit_lookup') then
    if (actor=any(s.telegram_user_ids)) is distinct from true or p->>'chat_id' is distinct from s.telegram_chat_id then raise exception 'unauthorized'; end if;
    if op='edit_lookup' then
      select * into e from agent.edit_sessions where prompt_id=(p->>'prompt_id')::bigint
        and p->>'actor'=edit_sessions.actor and chat_id=p->>'chat_id' and expires_at>now();
      return to_jsonb(e);
    end if;
    select * into d from agent.tweet_drafts where id=(p->>'id')::uuid for update;
    if d.id is null or d.content_version is distinct from (p->>'version')::int then raise exception 'expired callback or unknown draft'; end if;
    if d.status in ('publishing','published','simulated','uncertain','failed','expired','rejected') then raise exception 'draft locked'; end if;
    if op='approve' then
      if s.paused then raise exception 'globally paused'; end if;
      if d.status not in ('pending','approved') then raise exception 'revision in progress'; end if;
      if now()>=d.scheduled_at then
        update agent.tweet_drafts set status='expired',updated_at=now() where id=d.id;
        return '{"expired":true}';
      end if;
      update agent.tweet_drafts set status='approved',approved_at=now(),approved_version=content_version,
        approved_content=content,approved_by=actor,updated_at=now() where id=d.id;
    elsif op='reject' then
      update agent.tweet_drafts set status='rejected',approved_at=null,approved_version=null,approved_content=null,approved_by=null,updated_at=now() where id=d.id;
    elsif op in ('begin_edit','begin_regenerate') then
      if d.status not in ('pending','approved') then raise exception 'revision in progress'; end if;
      update agent.tweet_drafts set status=case when op='begin_edit' then 'editing' else 'regenerating' end,
        approved_at=null,approved_version=null,approved_content=null,approved_by=null,updated_at=now() where id=d.id;
    elsif op='edit_prompt' then
      if d.status<>'editing' then raise exception 'edit not started'; end if;
      insert into agent.edit_sessions(prompt_id,tweet_id,version,actor,chat_id)
        values((p->>'prompt_id')::bigint,d.id,d.content_version,actor,p->>'chat_id') on conflict do nothing;
    elsif op='revise' then
      if d.status not in ('editing','regenerating') or (p->'validation'->>'valid')::boolean is distinct from true then raise exception 'invalid revision'; end if;
      update agent.tweet_drafts set content=p->>'content',content_hash=p->>'content_hash',content_version=content_version+1,
        validation=p->'validation',status='pending',updated_at=now() where id=d.id returning * into d;
      insert into agent.tweet_revisions(tweet_id,version,content,content_hash,revision_type) values(d.id,d.content_version,d.content,d.content_hash,p->>'revision_type');
      insert into agent.outbox(dedupe_key,payload) values('draft:'||d.id||':'||d.content_version,jsonb_build_object('kind','draft','id',d.id,'version',d.content_version));
    end if;
    insert into agent.automation_logs(workflow_name,tweet_id,event_type,status,details)
      values('approval',d.id,op,'ok',jsonb_build_object('actor',actor,'version',d.content_version));
    return jsonb_build_object('ok',true,'id',d.id);
  elsif op='claim' then
    if s.paused then return null; end if;
    if p->>'mode' not in ('live','dry') then raise exception 'invalid mode'; end if;
    if p->>'mode'='live' and not s.publishing_enabled then return null; end if;
    -- Old approved drafts stay queued while disabled, then expire, never catch up.
    update agent.tweet_drafts set status='expired',updated_at=now() where status='approved' and scheduled_at<now()-interval '5 minutes';
    if (select count(*) from agent.publication_attempts where day=today and mode=p->>'mode'
      and state in ('publishing','published','simulated','uncertain'))>=s.daily_post_limit then return null; end if;
    select * into d from agent.tweet_drafts where status='approved' and approved_version=content_version
      and approved_content=content and scheduled_at<=now() and scheduled_at>=now()-interval '5 minutes'
      and approved_at<scheduled_at order by scheduled_at limit 1 for update;
    if d.id is null then return null; end if;
    insert into agent.publication_attempts(tweet_id,version,mode,state) values(d.id,d.content_version,p->>'mode','publishing') returning * into a;
    update agent.tweet_drafts set status='publishing',updated_at=now() where id=d.id;
    return jsonb_build_object('draft',to_jsonb(d),'attempt',to_jsonb(a));
  elsif op='finish' then
    select * into a from agent.publication_attempts where id=(p->>'attempt_id')::uuid for update;
    if a.id is null or a.state not in ('publishing','uncertain') then return '{"skipped":true}'; end if;
    if p->>'state' not in ('published','simulated','uncertain','failed') then raise exception 'invalid outcome'; end if;
    if a.mode='dry' and p->>'state'='published' or a.mode='live' and p->>'state'='simulated' then raise exception 'mode mismatch'; end if;
    if p->>'state'='published' and coalesce(p->>'x_post_id','') !~ '^[0-9]+$' then raise exception 'missing X post ID'; end if;
    update agent.publication_attempts set state=p->>'state',completed_at=now(),x_post_id=p->>'x_post_id',error_code=p->>'error_code' where id=a.id;
    update agent.tweet_drafts set status=p->>'state',published_at=case when p->>'state'='published' then now() end,
      x_post_id=p->>'x_post_id',updated_at=now() where id=a.tweet_id;
    insert into agent.outbox(dedupe_key,payload) values('publish:'||a.id||':'||(p->>'state'),jsonb_build_object('kind','notice',
      'text','Draft '||a.tweet_id||': '||(p->>'state')||coalesce(' â€” X ID '||(p->>'x_post_id'),'')||coalesce(' ('||(p->>'error_code')||')',''))) on conflict do nothing;
    insert into agent.automation_logs(workflow_name,tweet_id,event_type,status,error_message)
      values('publishing',a.tweet_id,'publish_result',p->>'state',p->>'error_code');
  elsif op='log' then
    insert into agent.automation_logs(workflow_name,event_type,status,error_message,details,dedupe_key)
      values(left(p->>'workflow',80),left(p->>'event',80),left(p->>'status',30),left(p->>'message',500),
        coalesce(p->'details','{}'),p->>'key') on conflict(dedupe_key) do nothing returning id into rec;
    if found and coalesce((p->>'alert')::boolean,false) then
      insert into agent.outbox(dedupe_key,payload) values('alert:'||rec.id,jsonb_build_object('kind','notice',
        'text','Agent: '||left(p->>'workflow',80)||' / '||left(p->>'event',80)||': '||left(coalesce(p->>'message',''),500)));
    end if;
  elsif op='monitor' then
    for a in select * from agent.publication_attempts where state='publishing' and started_at<now()-interval '2 minutes' loop
      perform agent.command('finish',jsonb_build_object('attempt_id',a.id,'state','uncertain','error_code','stuck_claim_manual_reconciliation'));
    end loop;
    update agent.tweet_drafts set status='pending',updated_at=now()
      where status in ('editing','regenerating') and updated_at<now()-interval '1 hour';
    for rec in select 'inbox' kind,update_id id from agent.inbox where state='processing' and attempts>=3 and leased_at<now()-interval '5 minutes'
      union all select 'outbox',id from agent.outbox where state='processing' and attempts>=5 and leased_at<now()-interval '5 minutes' loop
      perform agent.command('log',jsonb_build_object('workflow','monitor','event','dead_letter','status','error',
        'message',rec.kind||' item '||rec.id||' exhausted retries; inspect database','key','dead:'||rec.kind||':'||rec.id,'alert',rec.kind='inbox'));
    end loop;
    delete from agent.edit_sessions where expires_at<now()-interval '1 day';
    delete from agent.inbox where state='done' and created_at<now()-interval '7 days';
    delete from agent.outbox where state='done' and created_at<now()-interval '30 days';
    delete from agent.automation_logs where created_at<now()-interval '90 days';
    delete from agent.topics where created_at<now()-interval '30 days' and not exists(select 1 from agent.tweet_drafts where topic_id=topics.id);
    return jsonb_build_object('ok',true,'queued',(select count(*) from agent.tweet_drafts where status='approved'),
      'database_bytes',pg_database_size(current_database()));
  else
    raise exception 'unknown command';
  end if;
  return '{"ok":true}';
end $$;

commit;
