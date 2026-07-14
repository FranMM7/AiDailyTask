import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Download, FileText } from "lucide-react";
import type {
  Category,
  ExportRequest,
  ExportResult,
  Level,
  Status,
} from "@AiDailyTasks/shared";
import { useConfig, useExport, useExports } from "@/api/hooks";
import { toast } from "@/store/toast";

type GroupBy = ExportRequest["groupBy"];

function CheckRow({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-blue-600"
      />
      {label}
    </label>
  );
}

export function ExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data: config } = useConfig();
  const exportMutation = useExport();
  const { data: exportsList } = useExports();

  const [statuses, setStatuses] = useState<Set<Status>>(new Set());
  const [categories, setCategories] = useState<Set<Category>>(new Set());
  const [projects, setProjects] = useState<Set<string>>(new Set());
  const [severities] = useState<Set<Level>>(new Set());
  const [includeScope, setIncludeScope] = useState(false);
  const [includeObservations, setIncludeObservations] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>("status");
  const [title, setTitle] = useState("");
  const [result, setResult] = useState<ExportResult | null>(null);

  function toggle<T>(set: Set<T>, value: T, apply: (s: Set<T>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  }

  const runExport = () => {
    const body: ExportRequest = {
      statuses: statuses.size ? [...statuses] : undefined,
      categories: categories.size ? [...categories] : undefined,
      projects: projects.size ? [...projects] : undefined,
      severities: severities.size ? [...severities] : undefined,
      includeScope,
      includeObservations,
      groupBy,
      title: title || undefined,
    };
    exportMutation.mutate(body, {
      onSuccess: ({ result: r }) => {
        setResult(r);
        toast(`Exported ${r.taskCount} task(s) → ${r.filename}`, "success");
      },
      onError: () => toast("Export failed", "error"),
    });
  };

  const download = () => {
    if (!result) return;
    const blob = new Blob([result.markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[min(760px,95vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <Dialog.Title className="text-base font-semibold">Export tasks</Dialog.Title>
            <Dialog.Description className="sr-only">
              Choose filters and generate a markdown export
            </Dialog.Description>
            <Dialog.Close className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800">
              <X size={18} />
            </Dialog.Close>
          </div>

          <div className="grid gap-4 overflow-y-auto p-4 md:grid-cols-2">
            <fieldset className="space-y-1">
              <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Statuses
              </legend>
              {config?.statuses.map((s) => (
                <CheckRow
                  key={s.id}
                  label={s.label ?? s.id}
                  checked={statuses.has(s.id as Status)}
                  onChange={() => toggle(statuses, s.id as Status, setStatuses)}
                />
              ))}
            </fieldset>

            <fieldset className="space-y-1">
              <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Categories
              </legend>
              {config?.categories.map((c) => (
                <CheckRow
                  key={c.id}
                  label={c.label ?? c.id}
                  checked={categories.has(c.id as Category)}
                  onChange={() => toggle(categories, c.id as Category, setCategories)}
                />
              ))}
            </fieldset>

            <fieldset className="space-y-1">
              <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Projects
              </legend>
              {config?.projects.map((p) => (
                <CheckRow
                  key={p.id}
                  label={p.label}
                  checked={projects.has(p.id)}
                  onChange={() => toggle(projects, p.id, setProjects)}
                />
              ))}
            </fieldset>

            <div className="space-y-3">
              <div className="space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Options
                </span>
                <CheckRow label="Include scope" checked={includeScope} onChange={setIncludeScope} />
                <CheckRow
                  label="Include observations"
                  checked={includeObservations}
                  onChange={setIncludeObservations}
                />
              </div>
              <label className="block text-sm">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Group by
                </span>
                <select
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value as GroupBy)}
                  className="w-full rounded-md border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700"
                >
                  <option value="status">Status</option>
                  <option value="category">Category</option>
                  <option value="project">Project</option>
                  <option value="none">None</option>
                </select>
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Title (optional)
                </span>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Weekly export"
                  className="w-full rounded-md border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700"
                />
              </label>
            </div>
          </div>

          {result && (
            <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-800">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="truncate text-xs text-slate-500">
                  Written to <code className="font-mono">{result.path}</code>
                </span>
                <button
                  type="button"
                  onClick={download}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  <Download size={13} /> Download
                </button>
              </div>
              <pre className="max-h-48 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
                {result.markdown}
              </pre>
            </div>
          )}

          {exportsList && exportsList.exports.length > 0 && (
            <div className="border-t border-slate-200 px-4 py-2 dark:border-slate-800">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Recent exports
              </span>
              <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto text-xs text-slate-500">
                {exportsList.exports.map((e) => (
                  <li key={e.path} className="flex items-center gap-1.5">
                    <FileText size={12} /> {e.filename}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
            <Dialog.Close className="rounded-md px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">
              Close
            </Dialog.Close>
            <button
              type="button"
              onClick={runExport}
              disabled={exportMutation.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
            >
              <Download size={15} />
              {exportMutation.isPending ? "Exporting…" : "Export"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
