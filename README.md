# Supabase Compute + OpenWorkflow experiment

This is a small test app to see if long running background workflows behave on Supabase Compute. Compute is only billed for usage, so I want to make sure a workflow that sleeps for 30 seconds actually wakes up on time, and keeps doing that for 24 hours.

## How it works

- **One container runs both the API and the worker.** It's a Bun + Hono API and an OpenWorkflow worker in the same process, backed by Postgres.
- **Every 30 seconds the workflow writes a heartbeat.** Each row stores when the tick should have happened and when it actually did.
- **A test runs for 24 hours.** OpenWorkflow caps a run at 1,000 steps, so each run covers 1 hour and then hands off to the next one under the same test ID.

Drift means how late a tick woke up compared to when it should have. It does not mean the API was slow.

The app lives in `supabase/compute/compute-lucid-221052/`.

## Running it

Locally:

```sh
cd supabase/compute/compute-lucid-221052
cp .env.example .env   # add your DATABASE_URL
bun install
bun dev
```

Deploying needs the beta CLI since Compute is in alpha. `[experimental] compute = true` in `supabase/config.toml` turns the command on.

```sh
bunx supabase@beta compute push compute-lucid-221052
```

`DATABASE_URL` is set as a project secret. Use the direct connection or the session pooler. The transaction pooler won't work with OpenWorkflow.

## API

- `POST /tests` starts a test. Optional body: `{ "hours": 24 }`.
- `GET /tests/:id` shows the tick count, avg/p99/max drift, and the last 20 heartbeats.

The compute is private right now, so these 404 over HTTP (more below). You can check a test with SQL instead:

```sh
bunx supabase db query --linked "select count(*), avg(drift_ms)::int, max(drift_ms) from compute_test.heartbeats where test_id = '<test id>'"
```

## What I've found so far (19 Oct)

The first 24 hour test (`f59ce3cf-3d6e-4686-834c-5e0591eb4a8b`) started at 17:02 UTC.

- **Drift is low.** Ticks wake up 0.2 to 0.9 seconds late. That's mostly the worker polling once a second.
- **Redeploys don't break the workflow.** I redeployed in the middle of a sleep. The old instance drained in under a second and the new one picked up the next tick with 375ms drift. No gaps, no duplicate ticks.
- **Private computes 404 through the gateway.** Every request to `/compute/v1/<name>` returned "compute instance not found", even with the service role key. Public works, but public has no auth at all.
- **A few CLI quirks.** `supabase compute` only shows up in the beta CLI with the experimental flag. The CLI wants `size = "2gb"` while the dashboard says `2gb-1vcpu`. `source` can't be the project root.

Not tested yet: a deploy that lands in the middle of a tick, and an instance that gets killed instead of drained.

Would love any feedback here!

The goal is not a fancy app. The goal is to prove a sleeping workflow wakes up on time on Compute.
