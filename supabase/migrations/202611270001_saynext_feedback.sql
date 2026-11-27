begin;
create schema if not exists saynext_private;
revoke all on schema saynext_private from public, anon, authenticated;
create table saynext_private.samples (
  id uuid primary key,
  revision integer not null check (revision > 0),
  policy text not null,
  version text not null,
  day date not null,
  suggestion text,
  actual text,
  previous_user text,
  previous_assistant text,
  filled boolean not null,
  outcome text,
  auto_intent text,
  auto_severe boolean,
  manual_intent text,
  manual_severe boolean,
  updated_at timestamptz not null default now()
);
alter table saynext_private.samples enable row level security;
revoke all on saynext_private.samples from public, anon, authenticated;
create index samples_by_version_day on saynext_private.samples(version, day);
create function public.write_saynext_sample(sample jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into saynext_private.samples as saved
    (id, revision, policy, version, day, suggestion, actual, previous_user, previous_assistant,
     filled, outcome, auto_intent, auto_severe, manual_intent, manual_severe)
  values ((sample->>'id')::uuid, (sample->>'revision')::int, sample->>'policy', sample->>'version',
    (sample->>'day')::date, sample->>'suggestion', sample->>'actual', sample->>'previousUser',
    sample->>'previousAssistant', (sample->>'filled')::boolean, sample->>'outcome',
    sample->>'autoIntent', (sample->>'autoSevere')::boolean, sample->>'manualIntent',
    (sample->>'manualSevere')::boolean)
  on conflict (id) do update set revision = excluded.revision, suggestion = excluded.suggestion,
    actual = excluded.actual, previous_user = excluded.previous_user,
    previous_assistant = excluded.previous_assistant, filled = excluded.filled, outcome = excluded.outcome,
    auto_intent = excluded.auto_intent, auto_severe = excluded.auto_severe,
    manual_intent = excluded.manual_intent, manual_severe = excluded.manual_severe, updated_at = now()
  where excluded.revision > saved.revision and excluded.version = saved.version
    and excluded.policy = saved.policy and excluded.day = saved.day;
$$;
revoke all on function public.write_saynext_sample(jsonb) from public, anon, authenticated;
grant execute on function public.write_saynext_sample(jsonb) to service_role;
commit;
