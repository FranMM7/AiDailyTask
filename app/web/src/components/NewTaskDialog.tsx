import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Plus } from "lucide-react";
import {
  CATEGORIES,
  LEVELS,
  STATUSES,
  type Category,
  type CreateRequest,
  type Level,
  type Status,
} from "@AiDailyTasks/shared";
import { useConfig, useCreateTask } from "@/api/hooks";
import { useTaskDrawer } from "@/lib/navigation";
import { toast } from "@/store/toast";

const selectCls =
  "w-full rounded-md border border-slate-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-slate-700";

/**
 * Create a new task from the UI. The server allocates the next id automatically
 * (max existing + 1) — the id field is intentionally not exposed here.
 */
export function NewTaskDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data: config } = useConfig();
  const create = useCreateTask();
  const { openTask } = useTaskDrawer();

  const projects = config?.projects ?? [];
  const categories = config?.categories ?? CATEGORIES.map((id) => ({ id, label: id }));
  const levels = config?.severities ?? LEVELS.map((id) => ({ id, label: id }));
  const risks = config?.risks ?? LEVELS.map((id) => ({ id, label: id }));
  const statuses = (config?.statuses ?? STATUSES.map((id) => ({ id, label: id }))).filter(
    (s) => s.id !== "Archived",
  );

  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [category, setCategory] = useState<Category>("Refactor");
  const [severity, setSeverity] = useState<Level>("Medium");
  const [risk, setRisk] = useState<Level>("Low");
  const [status, setStatus] = useState<Status>("Not started");
  const [recurring, setRecurring] = useState(false);
  const [summary, setSummary] = useState("");

  // Default the project to the first configured one once config arrives / dialog opens.
  useEffect(() => {
    if (open && !project && projects.length > 0) setProject(projects[0].id);
  }, [open, projects, project]);

  const reset = () => {
    setTitle("");
    setCategory("Refactor");
    setSeverity("Medium");
    setRisk("Low");
    setStatus("Not started");
    setRecurring(false);
    setSummary("");
  };

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const body: CreateRequest = {
      title: trimmed,
      project: project || projects[0]?.id || "Sample",
      category,
      severity,
      risk,
      status,
      status_detail: "",
      tags: [],
      skills: [],
      recurring,
      depends_on: [],
      blocks: [],
      relates_to: [],
      parent: null,
      summary: summary.trim(),
      scope: "",
    };
    create.mutate(body, {
      onSuccess: ({ task }) => {
        toast(`Created ${task.id}`, "success");
        reset();
        onOpenChange(false);
        openTask(task.id);
      },
      onError: () => toast("Couldn't create the task.", "error"),
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-200 bg-white p-5 text-slate-900 shadow-2xl outline-none dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">New task</Dialog.Title>
            <Dialog.Description className="sr-only">Create a new task</Dialog.Description>
            <Dialog.Close className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800">
              <X size={18} />
            </Dialog.Close>
          </div>

          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Title
              </span>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
                }}
                placeholder="Short, descriptive title…"
                className={selectCls}
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Project
                </span>
                <select value={project} onChange={(e) => setProject(e.target.value)} className={selectCls}>
                  {projects.length === 0 && <option value="">(none)</option>}
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Status
                </span>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as Status)}
                  className={selectCls}
                >
                  {statuses.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label ?? s.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Category
                </span>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as Category)}
                  className={selectCls}
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label ?? c.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Severity
                </span>
                <select
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value as Level)}
                  className={selectCls}
                >
                  {levels.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label ?? l.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Risk
                </span>
                <select value={risk} onChange={(e) => setRisk(e.target.value as Level)} className={selectCls}>
                  {risks.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label ?? l.id}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 p-2.5 dark:border-slate-800">
              <input
                type="checkbox"
                checked={recurring}
                onChange={(event) => setRecurring(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium">Recurring task</span>
                <span className="block text-xs text-slate-500">
                  Create the next occurrence in Backlog after this one is completed and archived.
                </span>
              </span>
            </label>

            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Summary (optional)
              </span>
              <textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={3}
                placeholder="One paragraph on what this is…"
                className={selectCls}
              />
            </label>
          </div>

          <div className="mt-5 flex items-center justify-end gap-2">
            <Dialog.Close className="rounded-md px-3 py-1.5 text-sm text-slate-500 hover:text-slate-900 dark:hover:text-white">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              onClick={submit}
              disabled={!title.trim() || create.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Plus size={15} />
              {create.isPending ? "Creating…" : "Create task"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
