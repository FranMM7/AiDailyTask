import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import type { TaskSummaryOrInvalid } from "@AiDailyTasks/shared";
import { LEVEL_RANK, STATUS_ORDER } from "@AiDailyTasks/shared";
import { useTasks } from "@/api/hooks";
import { readFilter } from "@/lib/filters";
import { useTaskDrawer } from "@/lib/navigation";
import { CategoryBadge, InvalidBadge, LevelBadge, StatusBadge } from "@/components/badges";

const col = createColumnHelper<TaskSummaryOrInvalid>();

function fmtDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

// NOTE: these are ACCESSOR columns (not display columns) so TanStack's sort
// machinery has a value to order by — display columns are not sortable, which
// is why header clicks did nothing before. Each accessor returns a sortable
// primitive (rank for severity/risk/status); the cell renders the badge.
const columns = [
  col.accessor((r) => r.id, {
    id: "id",
    header: "ID",
    cell: (c) => <span className="font-mono text-xs">{c.row.original.id}</span>,
  }),
  col.accessor((r) => (r.valid ? r.title : (r.parseError ?? "")), {
    id: "title",
    header: "Title",
    cell: (c) => {
      const t = c.row.original;
      return t.valid ? (
        <span className="font-medium">{t.title}</span>
      ) : (
        <span className="inline-flex items-center gap-2 text-red-500">
          <InvalidBadge /> {t.parseError}
        </span>
      );
    },
  }),
  col.accessor((r) => (r.valid ? r.project : ""), {
    id: "project",
    header: "Project",
    cell: (c) => (c.row.original.valid ? c.row.original.project : ""),
  }),
  col.accessor((r) => (r.valid ? r.category : ""), {
    id: "category",
    header: "Category",
    cell: (c) =>
      c.row.original.valid ? <CategoryBadge category={c.row.original.category} /> : null,
  }),
  col.accessor((r) => (r.valid ? LEVEL_RANK[r.severity] : 0), {
    id: "severity",
    header: "Severity",
    sortingFn: "basic",
    cell: (c) =>
      c.row.original.valid ? <LevelBadge kind="severity" level={c.row.original.severity} /> : null,
  }),
  col.accessor((r) => (r.valid ? LEVEL_RANK[r.risk] : 0), {
    id: "risk",
    header: "Risk",
    sortingFn: "basic",
    cell: (c) => (c.row.original.valid ? <LevelBadge kind="risk" level={c.row.original.risk} /> : null),
  }),
  col.accessor((r) => (r.valid ? STATUS_ORDER[r.status] : -1), {
    id: "status",
    header: "Status",
    sortingFn: "basic",
    cell: (c) => (c.row.original.valid ? <StatusBadge status={c.row.original.status} /> : null),
  }),
  col.accessor((r) => (r.valid ? (r.updated ?? r.created ?? "") : ""), {
    id: "updated",
    header: "Updated",
    cell: (c) => (
      <span className="text-xs text-slate-500">
        {c.row.original.valid ? fmtDate(c.row.original.updated ?? c.row.original.created ?? "") : ""}
      </span>
    ),
  }),
];

export function TableView() {
  const [params] = useSearchParams();
  const filter = useMemo(() => readFilter(params), [params]);
  const { data, isLoading, isError } = useTasks(filter);
  const { openTask } = useTaskDrawer();
  const [sorting, setSorting] = useState<SortingState>([{ id: "id", desc: false }]);

  const rows = useMemo(() => data?.tasks ?? [], [data]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.id,
  });

  if (isLoading) return <div className="p-8 text-center text-sm text-slate-500">Loading…</div>;
  if (isError)
    return <div className="p-8 text-center text-sm text-slate-500">Failed to load tasks.</div>;

  return (
    <div className="h-full overflow-auto p-4">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-slate-900">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    className="cursor-pointer select-none border-b border-slate-200 px-3 py-2 text-left font-semibold dark:border-slate-800"
                  >
                    <span className="inline-flex items-center gap-1">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {sorted === "asc" ? (
                        <ArrowUp size={12} />
                      ) : sorted === "desc" ? (
                        <ArrowDown size={12} />
                      ) : (
                        <ArrowUpDown size={12} className="opacity-30" />
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              onClick={() => openTask(row.original.id)}
              className="cursor-pointer border-b border-slate-100 hover:bg-slate-100 dark:border-slate-800/60 dark:hover:bg-slate-800/50"
            >
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="px-3 py-2 align-middle">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
          {table.getRowModel().rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-slate-500">
                No tasks match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
