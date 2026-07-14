import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Save, Network, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import type { CodeGraphIndexer, ProjectDef } from "@AiDailyTasks/shared";
import { useConfig, useUpdateProject, useCodeGraph, useGenerateCodeGraph } from "@/api/hooks";
import { toast } from "@/store/toast";

const inputCls =
  "w-full rounded-md border border-slate-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-slate-700";

/** Edit existing projects (label + source path) and generate their code graph. */
export function ManageProjectsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data: config } = useConfig();
  const projects = config?.projects ?? [];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(640px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-slate-200 bg-white text-slate-900 shadow-2xl outline-none dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100">
          <div className="flex items-center justify-between border-b border-slate-200 p-5 dark:border-slate-800">
            <div>
              <Dialog.Title className="text-base font-semibold">Manage projects</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-slate-500">
                Edit a project's label or source path, and generate its code graph.
              </Dialog.Description>
            </div>
            <Dialog.Close className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800">
              <X size={18} />
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
            {projects.length === 0 && (
              <p className="text-sm text-slate-500">
                No projects yet. Add one with the “＋” button in the top bar.
              </p>
            )}
            {projects.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function StatusBadge({ project }: { project: ProjectDef }) {
  const { data } = useCodeGraph(project.root ? project.id : undefined);
  const status = data?.meta.status ?? (project.root ? undefined : "empty");

  if (!project.root)
    return <span className="text-[11px] text-slate-400">no source path</span>;
  if (status === "indexing")
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-amber-500">
        <Loader2 size={12} className="animate-spin" /> indexing…
      </span>
    );
  if (status === "ready")
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-500">
        <CheckCircle2 size={12} /> {data?.meta.fileCount ?? 0} files · {data?.meta.edgeCount ?? 0} deps
      </span>
    );
  if (status === "failed")
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-red-500" title={data?.meta.error}>
        <AlertTriangle size={12} /> failed
      </span>
    );
  return <span className="text-[11px] text-slate-400">not generated</span>;
}

function ProjectRow({ project }: { project: ProjectDef }) {
  const update = useUpdateProject();
  const generate = useGenerateCodeGraph();
  const { data: graph } = useCodeGraph(project.root ? project.id : undefined);

  const [label, setLabel] = useState(project.label);
  const [root, setRoot] = useState(project.root ?? "");
  const [indexer, setIndexer] = useState<CodeGraphIndexer>(project.indexer ?? "builtin");

  const dirty =
    label.trim() !== project.label ||
    root.trim() !== (project.root ?? "") ||
    indexer !== (project.indexer ?? "builtin");
  const isIndexing = graph?.meta.status === "indexing";

  const editBody = () => ({ label: label.trim() || project.label, root: root.trim(), indexer });

  const save = () => {
    if (!dirty) return;
    update.mutate(
      { id: project.id, body: editBody() },
      { onSuccess: () => toast(`Saved ${project.id}`, "success") },
    );
  };

  const runGenerate = () => {
    if (!root.trim()) {
      toast("Set a source path first", "error");
      return;
    }
    // Persist any pending edit so the server graphs the path + engine shown here.
    const start = () =>
      generate.mutate(project.id, {
        onSuccess: () =>
          toast(
            `Graph generation started (${indexer === "graphify" ? "graphify" : "built-in"}) — this may take a while.`,
            "success",
          ),
      });
    if (dirty) {
      update.mutate({ id: project.id, body: editBody() }, { onSuccess: start });
    } else {
      start();
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-xs text-slate-500">{project.id}</span>
        <StatusBadge project={project} />
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_1.6fr]">
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Label
          </span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Source path
          </span>
          <input
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder="e.g. C:\\Code\\my-project"
            className={`${inputCls} font-mono text-xs`}
          />
        </label>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Engine</span>
        <select
          value={indexer}
          onChange={(e) => setIndexer(e.target.value as CodeGraphIndexer)}
          className="rounded-md border border-slate-300 bg-transparent px-2 py-1 text-xs outline-none focus:border-blue-500 dark:border-slate-700"
        >
          <option value="builtin">Built-in (files + imports)</option>
          <option value="graphify">Graphify (symbols + calls)</option>
        </select>
        <span className="text-[10px] text-slate-400">
          {indexer === "graphify"
            ? "richer AST graph — requires graphify installed"
            : "no toolchain needed"}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || update.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <Save size={13} />
          {update.isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={runGenerate}
          disabled={!root.trim() || isIndexing || generate.isPending}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {isIndexing ? <Loader2 size={13} className="animate-spin" /> : <Network size={13} />}
          {isIndexing ? "Indexing…" : graph?.meta.status === "ready" ? "Regenerate graph" : "Generate graph"}
        </button>
      </div>
    </div>
  );
}
