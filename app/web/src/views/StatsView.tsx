import { useMemo, type ReactNode } from "react";
import { STATUSES, type Status, type TaskSummary } from "@AiDailyTaks/shared";
import { useConfig, useTasks } from "@/api/hooks";
import { statusColor, tint } from "@/lib/colors";

// ── Metric helpers ─────────────────────────────────────────────────────────────
const DAY_MS = 86_400_000;

function parseDay(s: string | undefined): number | null {
  if (!s) return null;
  const t = new Date(`${s.slice(0, 10)}T00:00:00Z`).getTime();
  return Number.isNaN(t) ? null : t;
}
function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}
/** "3d", "2w 1d", "—" */
function fmtDays(d: number | null): string {
  if (d === null) return "—";
  if (d === 0) return "<1d";
  if (d < 14) return `${d}d`;
  const w = Math.floor(d / 7);
  const rem = d % 7;
  return rem ? `${w}w ${rem}d` : `${w}w`;
}

const CLOSE_BUCKETS: { label: string; test: (d: number) => boolean }[] = [
  { label: "≤1 day", test: (d) => d <= 1 },
  { label: "2–3 days", test: (d) => d >= 2 && d <= 3 },
  { label: "4–7 days", test: (d) => d >= 4 && d <= 7 },
  { label: "1–2 weeks", test: (d) => d >= 8 && d <= 14 },
  { label: "2–4 weeks", test: (d) => d >= 15 && d <= 30 },
  { label: "30+ days", test: (d) => d > 30 },
];

export function StatsView() {
  const { data: config } = useConfig();
  // Include archived: completed tasks may have aged into the archive, but they still count.
  const { data, isLoading, isError } = useTasks({
    archived: "include",
    sort: "id",
    order: "asc",
  });

  const stats = useMemo(() => {
    const tasks = (data?.tasks ?? []).filter((t): t is TaskSummary => t.valid);
    const total = tasks.length;

    const byStatus = new Map<Status, number>();
    for (const s of STATUSES) byStatus.set(s, 0);
    for (const t of tasks) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);

    const completed = tasks.filter((t) => t.status === "Completed" || t.archived);
    const openTasks = tasks.filter((t) => t.status !== "Completed" && !t.archived);

    // Cycle time = created → completed, in whole days (negatives from bad data dropped).
    const cycles: number[] = [];
    let fastest: { id: string; days: number } | null = null;
    let slowest: { id: string; days: number } | null = null;
    for (const t of completed) {
      const c = parseDay(t.created);
      const done = parseDay(t.completed);
      if (c === null || done === null) continue;
      const days = Math.round((done - c) / DAY_MS);
      if (days < 0) continue;
      cycles.push(days);
      if (!fastest || days < fastest.days) fastest = { id: t.id, days };
      if (!slowest || days > slowest.days) slowest = { id: t.id, days };
    }

    // Age of still-open tasks (created → today).
    const today = Date.now();
    const openAges: number[] = [];
    for (const t of openTasks) {
      const c = parseDay(t.created);
      if (c !== null) openAges.push(Math.max(0, Math.round((today - c) / DAY_MS)));
    }

    // Throughput: completions in the last 7 / 30 days.
    const within = (days: number) =>
      completed.filter((t) => {
        const done = parseDay(t.completed);
        return done !== null && today - done <= days * DAY_MS;
      }).length;

    const bucketCounts = CLOSE_BUCKETS.map((b) => ({
      label: b.label,
      count: cycles.filter((d) => b.test(d)).length,
    }));

    return {
      total,
      byStatus,
      completedCount: completed.length,
      openCount: openTasks.length,
      avgClose: mean(cycles),
      medianClose: median(cycles),
      fastest,
      slowest,
      avgOpenAge: mean(openAges),
      closedLast7: within(7),
      closedLast30: within(30),
      measured: cycles.length,
      bucketCounts,
    };
  }, [data]);

  if (isLoading) return <Msg>Loading statistics…</Msg>;
  if (isError) return <Msg>Failed to load statistics.</Msg>;

  const pct = (n: number) => (stats.total ? Math.round((n / stats.total) * 100) : 0);
  const maxStatus = Math.max(1, ...[...stats.byStatus.values()]);
  const maxBucket = Math.max(1, ...stats.bucketCounts.map((b) => b.count));

  return (
    <div className="h-full overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <h1 className="text-lg font-semibold">Statistics</h1>
          <p className="text-xs text-slate-500">
            How much is on the board and how quickly tasks go from created to completed.
          </p>
        </header>

        {/* Hero tiles */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Tile label="Total tasks" value={stats.total} />
          <Tile
            label="Completed"
            value={stats.completedCount}
            sub={`${pct(stats.completedCount)}% of all`}
          />
          <Tile label="Open" value={stats.openCount} sub={`${pct(stats.openCount)}% of all`} />
          <Tile
            label="Avg time to close"
            value={fmtDays(stats.avgClose)}
            sub={`median ${fmtDays(stats.medianClose)}`}
            accent
          />
          <Tile label="Fastest close" value={fmtDays(stats.fastest?.days ?? null)} sub={stats.fastest?.id} />
          <Tile label="Slowest close" value={fmtDays(stats.slowest?.days ?? null)} sub={stats.slowest?.id} />
          <Tile label="Closed · last 7d" value={stats.closedLast7} />
          <Tile label="Closed · last 30d" value={stats.closedLast30} />
        </section>

        {/* Status distribution — reuses the board's themed status colors (one bar per state) */}
        <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <h2 className="mb-3 text-sm font-semibold">Tasks by status</h2>
          <div className="space-y-2">
            {STATUSES.map((s) => {
              const count = stats.byStatus.get(s) ?? 0;
              const color = statusColor(config, s);
              return (
                <div key={s} className="flex items-center gap-3">
                  <span className="w-24 shrink-0 text-xs text-slate-500">{s}</span>
                  <div className="h-5 flex-1 overflow-hidden rounded-md" style={{ background: tint(color, 0.12) }}>
                    <div
                      className="flex h-full items-center justify-end rounded-md px-2 text-[11px] font-medium text-white transition-all"
                      style={{
                        width: `${Math.max(count ? 8 : 0, (count / maxStatus) * 100)}%`,
                        backgroundColor: color,
                      }}
                    >
                      {count > 0 ? count : ""}
                    </div>
                  </div>
                  <span className="w-10 shrink-0 text-right text-xs tabular-nums text-slate-400">
                    {pct(count)}%
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Close-time distribution — single-hue magnitude, no legend needed */}
        <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <h2 className="mb-1 text-sm font-semibold">How long tasks take to close</h2>
          <p className="mb-3 text-xs text-slate-500">
            Based on {stats.measured} completed task{stats.measured === 1 ? "" : "s"} with a created &amp;
            completed date.
          </p>
          {stats.measured === 0 ? (
            <p className="text-xs text-slate-500">No completed tasks with dates yet.</p>
          ) : (
            <div className="space-y-2">
              {stats.bucketCounts.map((b) => (
                <div key={b.label} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-slate-500">{b.label}</span>
                  <div className="h-5 flex-1 overflow-hidden rounded-md bg-slate-200/50 dark:bg-slate-800/50">
                    <div
                      className="h-full rounded-md bg-blue-600 transition-all"
                      style={{ width: `${(b.count / maxBucket) * 100}%` }}
                    />
                  </div>
                  <span className="w-8 shrink-0 text-right text-xs tabular-nums text-slate-400">
                    {b.count}
                  </span>
                </div>
              ))}
            </div>
          )}
          {stats.avgOpenAge !== null && (
            <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-800">
              Open tasks have been waiting <strong className="text-slate-700 dark:text-slate-200">{fmtDays(stats.avgOpenAge)}</strong> on average.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        accent
          ? "border-blue-500/30 bg-blue-500/5"
          : "border-slate-200 dark:border-slate-800"
      }`}
    >
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

function Msg({ children }: { children: ReactNode }) {
  return <div className="p-8 text-center text-sm text-slate-500">{children}</div>;
}
