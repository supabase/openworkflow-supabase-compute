import { Hono } from "hono";
import { OpenWorkflow } from "openworkflow";
import { BackendPostgres } from "openworkflow/postgres";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const TICK_MS = 30_000;
// OpenWorkflow caps a run at 1000 step attempts and each tick costs 2 steps
// (run + sleep), so each run covers 1 hour of ticks, then hands off to a new run.
const TICKS_PER_RUN = 120;

const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
await sql`create schema if not exists compute_test`;
await sql`create table if not exists compute_test.heartbeats (
  test_id text not null,
  seq int not null,
  run_id text not null,
  expected_at timestamptz,
  actual_at timestamptz not null,
  drift_ms int,
  primary key (test_id, seq)
)`;

const backend = await BackendPostgres.connect(DATABASE_URL);
const ow = new OpenWorkflow({ backend });

type HeartbeatInput = {
  testId: string;
  endsAt: number;
  seq: number;
  prevAt: number | null;
};

const heartbeat = ow.defineWorkflow<HeartbeatInput, void>(
  { name: "heartbeat" },
  async ({ input, step, run }): Promise<void> => {
    let prevAt = input.prevAt;
    const nextSeq = input.seq + TICKS_PER_RUN;

    for (let seq = input.seq; seq < nextSeq; seq++) {
      const expectedAt = prevAt === null ? null : prevAt + TICK_MS;
      prevAt = await step.run({ name: `tick-${seq}` }, async () => {
        const now = Date.now();
        const drift = expectedAt === null ? null : now - expectedAt;
        await sql`insert into compute_test.heartbeats values (
          ${input.testId}, ${seq}, ${run.id},
          ${expectedAt === null ? null : new Date(expectedAt)}, ${new Date(now)}, ${drift}
        ) on conflict do nothing`;
        console.log(`[${input.testId}] tick ${seq} drift=${drift ?? "-"}ms`);
        return now;
      });
      if (prevAt >= input.endsAt) return;
      await step.sleep(`sleep-${seq}`, `${TICK_MS}ms`);
    }

    await step.run({ name: "continue" }, async () => {
      await heartbeat.run(
        { ...input, seq: nextSeq, prevAt },
        { idempotencyKey: `${input.testId}:${nextSeq}` },
      );
    });
  },
);

const app = new Hono();

app.get("/", (c) => c.text("ok"));

app.post("/tests", async (c) => {
  const { hours = 24 } = await c.req
    .json<{ hours?: number }>()
    .catch((): { hours?: number } => ({}));
  if (!(Number.isFinite(hours) && hours > 0 && hours <= 168)) {
    return c.json({ error: "hours must be a number in (0, 168]" }, 400);
  }
  const testId = crypto.randomUUID();
  const endsAt = Date.now() + hours * 3_600_000;
  const handle = await heartbeat.run({ testId, endsAt, seq: 0, prevAt: null });
  return c.json(
    { testId, runId: handle.workflowRun.id, endsAt: new Date(endsAt) },
    201,
  );
});

app.get("/tests/:id", async (c) => {
  const id = c.req.param("id");
  const [summary] = await sql`select
      count(*)::int as ticks,
      min(actual_at) as first_at,
      max(actual_at) as last_at,
      avg(drift_ms)::int as avg_drift_ms,
      (percentile_cont(0.99) within group (order by drift_ms))::int as p99_drift_ms,
      max(drift_ms) as max_drift_ms,
      count(*) filter (where drift_ms > ${TICK_MS})::int as ticks_over_one_interval_late
    from compute_test.heartbeats where test_id = ${id}`;
  if (!summary?.ticks) return c.json({ error: "not found" }, 404);

  const recent = await sql`select seq, run_id, actual_at, drift_ms
    from compute_test.heartbeats where test_id = ${id}
    order by seq desc limit 20`;
  const latestRun = await backend.getWorkflowRun({
    workflowRunId: recent[0]!.run_id,
  });
  return c.json({
    testId: id,
    latestRunStatus: latestRun?.status,
    latestRunError: latestRun?.error,
    ...summary,
    recent,
  });
});

const worker = ow.newWorker();
await worker.start();
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
});
console.log(`api + worker listening on :${server.port}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await server.stop();
    await worker.stop();
    await backend.stop();
    await sql.end();
    process.exit(0);
  });
}
