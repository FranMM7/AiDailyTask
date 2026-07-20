import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Archive, RotateCcw, X } from "lucide-react";
import {
  CATEGORIES,
  LEVELS,
  STATUSES,
  normalizeId,
  type Category,
  type EditableFields,
  type Level,
  type Status,
  type TaskDetail,
} from "@AiDailyTasks/shared";
import { useArchiveTask, useConfig, usePatchTask, useUnarchiveTask } from "@/api/hooks";
import { toast } from "@/store/toast";

interface FormState {
  title: string;
  project: string;
  category: Category;
  severity: Level;
  risk: Level;
  status: Status;
  status_detail: string;
  tags: string[];
  skills: string[];
  recurring: boolean;
  depends_on: string;
  blocks: string;
  relates_to: string;
  parent: string;
}

function toForm(task: TaskDetail): FormState {
  return {
    title: task.title,
    project: task.project,
    category: task.category,
    severity: task.severity,
    risk: task.risk,
    status: task.status,
    status_detail: task.status_detail ?? "",
    tags: [...task.tags],
    skills: [...task.skills],
    recurring: task.recurring,
    depends_on: task.depends_on.join(", "),
    blocks: task.blocks.join(", "),
    relates_to: task.relates_to.join(", "),
    parent: task.parent ?? "",
  };
}

function parseIds(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalizeId(s));
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </span>
      {children}
    </label>
  );
}

const selectCls =
  "w-full rounded-md border border-slate-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-slate-700";
const inputCls = selectCls;

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !tags.includes(v)) onChange([...tags, v]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-slate-300 p-1.5 dark:border-slate-700">
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 rounded bg-slate-200 px-1.5 py-0.5 text-xs dark:bg-slate-700"
        >
          {t}
          <button type="button" onClick={() => onChange(tags.filter((x) => x !== t))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        placeholder="add tag…"
        className="min-w-16 flex-1 bg-transparent text-xs outline-none"
      />
    </div>
  );
}

export function MetadataPanel({ task }: { task: TaskDetail }) {
  const { data: config } = useConfig();
  const patch = usePatchTask();
  const archive = useArchiveTask();
  const unarchive = useUnarchiveTask();

  const initial = useMemo(() => toForm(task), [task]);
  const [form, setForm] = useState<FormState>(initial);

  // reset local edits whenever the task changes on disk (rev bump)
  useEffect(() => {
    setForm(toForm(task));
  }, [task.rev, task.id]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const statuses = config?.statuses ?? STATUSES.map((id) => ({ id, label: id }));
  const categories = config?.categories ?? CATEGORIES.map((id) => ({ id, label: id }));
  const levels = config?.severities ?? LEVELS.map((id) => ({ id, label: id }));
  const risks = config?.risks ?? LEVELS.map((id) => ({ id, label: id }));
  const projects = config?.projects ?? [{ id: task.project, label: task.project }];

  const save = () => {
    const fields: EditableFields = {
      title: form.title,
      project: form.project,
      category: form.category,
      severity: form.severity,
      risk: form.risk,
      status: form.status,
      status_detail: form.status_detail,
      tags: form.tags,
      skills: form.skills,
      recurring: form.recurring,
      depends_on: parseIds(form.depends_on),
      blocks: parseIds(form.blocks),
      relates_to: parseIds(form.relates_to),
      parent: form.parent.trim() ? normalizeId(form.parent.trim()) : null,
    };
    patch.mutate(
      { id: task.id, body: { baseRev: task.rev, fields } },
      {
        onSuccess: () => toast("Saved", "success"),
      },
    );
  };

  return (
    <div className="space-y-3">
      <Field label="Title">
        <input value={form.title} onChange={(e) => set("title", e.target.value)} className={inputCls} />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Status">
          <select
            value={form.status}
            onChange={(e) => set("status", e.target.value as Status)}
            className={selectCls}
          >
            {statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label ?? s.id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Project">
          <select
            value={form.project}
            onChange={(e) => set("project", e.target.value)}
            className={selectCls}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Category">
          <select
            value={form.category}
            onChange={(e) => set("category", e.target.value as Category)}
            className={selectCls}
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label ?? c.id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Severity">
          <select
            value={form.severity}
            onChange={(e) => set("severity", e.target.value as Level)}
            className={selectCls}
          >
            {levels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label ?? l.id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Risk">
          <select
            value={form.risk}
            onChange={(e) => set("risk", e.target.value as Level)}
            className={selectCls}
          >
            {risks.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label ?? l.id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Parent">
          <input
            value={form.parent}
            onChange={(e) => set("parent", e.target.value)}
            placeholder="C10"
            className={inputCls}
          />
        </Field>
      </div>

      <Field label="Status detail">
        <input
          value={form.status_detail}
          onChange={(e) => set("status_detail", e.target.value)}
          placeholder="awaiting VS build, parked…"
          className={inputCls}
        />
      </Field>

      <Field label="Tags">
        <TagEditor tags={form.tags} onChange={(t) => set("tags", t)} />
      </Field>

      <div>
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Skills
        </span>
        <TagEditor tags={form.skills} onChange={(t) => set("skills", t)} />
        {(config?.skills?.length ?? 0) > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {config!.skills.filter((s) => !form.skills.includes(s.id)).map((s) => <button key={s.id} type="button" onClick={() => set("skills", [...form.skills, s.id])} className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">+ {s.label ?? s.id}</button>)}
          </div>
        )}
      </div>

      <label className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 p-2.5 dark:border-slate-800">
        <input
          type="checkbox"
          checked={form.recurring}
          onChange={(event) => set("recurring", event.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="block text-sm font-medium">Recurring task</span>
          <span className="block text-xs text-slate-500">
            After this task is completed and archived, create its next occurrence in Backlog.
          </span>
        </span>
      </label>

      <div className="grid grid-cols-1 gap-3">
        <Field label="Depends on">
          <input
            value={form.depends_on}
            onChange={(e) => set("depends_on", e.target.value)}
            placeholder="C01, C02"
            className={inputCls}
          />
        </Field>
        <Field label="Blocks">
          <input
            value={form.blocks}
            onChange={(e) => set("blocks", e.target.value)}
            placeholder="C13"
            className={inputCls}
          />
        </Field>
        <Field label="Relates to">
          <input
            value={form.relates_to}
            onChange={(e) => set("relates_to", e.target.value)}
            placeholder="C20, C21"
            className={inputCls}
          />
        </Field>
      </div>

      <dl className="grid grid-cols-3 gap-2 pt-1 text-xs text-slate-500">
        <div>
          <dt className="text-[10px] uppercase text-slate-400">Created</dt>
          <dd>{task.created ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase text-slate-400">Updated</dt>
          <dd>{task.updated ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase text-slate-400">Completed</dt>
          <dd>{task.completed ?? "—"}</dd>
        </div>
      </dl>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || patch.isPending}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {patch.isPending ? "Saving…" : "Save"}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => setForm(toForm(task))}
            className="rounded-md px-3 py-1.5 text-sm text-slate-500 hover:text-slate-900 dark:hover:text-white"
          >
            Reset
          </button>
        )}
        {task.archived ? (
          <button
            type="button"
            disabled={unarchive.isPending}
            onClick={() =>
              unarchive.mutate(
                { id: task.id, baseRev: task.rev },
                { onSuccess: () => toast("Restored", "success") },
              )
            }
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <RotateCcw size={14} /> Restore
          </button>
        ) : (
          <button
            type="button"
            disabled={archive.isPending}
            onClick={() =>
              archive.mutate(
                { id: task.id, baseRev: task.rev },
                {
                  onSuccess: ({ successor }) =>
                    toast(
                      successor ? `Archived · created ${successor.id} in Backlog` : "Archived",
                      "success",
                    ),
                },
              )
            }
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <Archive size={14} /> Archive
          </button>
        )}
        <span className="ml-auto font-mono text-[11px] text-slate-400">rev {task.rev}</span>
      </div>
    </div>
  );
}
