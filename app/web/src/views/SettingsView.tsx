import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff, Pencil, Plus, RotateCcw, Save, Trash2, X } from "lucide-react";
import type { BoardConfig, EnumDef } from "@AiDailyTasks/shared";
import { useConfig, useUpdateConfig } from "@/api/hooks";
import { toast } from "@/store/toast";

const PROTECTED_STATUSES = new Set(["Backlog", "Completed"]);
const NAV_TABS = [
  ["/backlog", "Backlog"],
  ["/table", "Table"],
  ["/graph", "Graph"],
  ["/code-graph", "Code map"],
  ["/projects", "Projects"],
  ["/archive", "Archive"],
  ["/stats", "Stats"],
  ["/connect", "Connect"],
] as const;

function normalize(config: BoardConfig): BoardConfig {
  const withOrder = (defs: EnumDef[]) => defs.map((item, index) => ({ ...item, order: index }));
  const withRank = (defs: EnumDef[]) => defs.map((item, index) => ({ ...item, rank: index + 1 }));
  return {
    ...config,
    statuses: withOrder(config.statuses),
    categories: config.categories.map((item) => ({ ...item })),
    skills: config.skills.map((item) => ({
      ...item,
      label: item.id,
      instructions:
        item.instructions ?? (item.label && item.label !== item.id ? item.label : ""),
    })),
    severities: withRank(config.severities),
    risks: withRank(config.risks),
  };
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mb-4 mt-1 text-xs text-slate-500">{description}</p>
      {children}
    </section>
  );
}

function VocabularyEditor({
  title,
  description,
  singular,
  values,
  protectedIds = new Set<string>(),
  allowEmpty = false,
  onChange,
}: {
  title: string;
  description: string;
  singular: string;
  values: EnumDef[];
  protectedIds?: Set<string>;
  allowEmpty?: boolean;
  onChange: (values: EnumDef[]) => void;
}) {
  const update = (index: number, patch: Partial<EnumDef>) =>
    onChange(values.map((value, current) => (current === index ? { ...value, ...patch } : value)));
  const add = () => {
    let suffix = values.length + 1;
    let id = `New ${singular}`;
    while (values.some((value) => value.id === id)) id = `New ${singular} ${suffix++}`;
    onChange([...values, { id, label: id, color: "#64748b" }]);
  };

  return (
    <Section title={title} description={description}>
      <div className="space-y-2">
        {values.map((value, index) => {
          const protectedId = protectedIds.has(value.id);
          const canRemove = !protectedId && (allowEmpty || values.length > 1);
          return (
            <div key={index} className="grid grid-cols-[minmax(8rem,1fr)_minmax(8rem,1fr)_2.5rem_2.25rem] items-center gap-2">
              <input
                aria-label={`${title} id ${index + 1}`}
                value={value.id}
                disabled={protectedId}
                onChange={(event) => update(index, { id: event.target.value })}
                className="min-w-0 rounded-md border border-slate-300 bg-transparent px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700"
              />
              <input
                aria-label={`${title} label ${index + 1}`}
                value={value.label ?? value.id}
                onChange={(event) => update(index, { label: event.target.value })}
                className="min-w-0 rounded-md border border-slate-300 bg-transparent px-2 py-1.5 text-sm dark:border-slate-700"
              />
              <input
                aria-label={`${title} color ${index + 1}`}
                type="color"
                value={value.color}
                onChange={(event) => update(index, { color: event.target.value })}
                className="h-8 w-10 cursor-pointer rounded border border-slate-300 bg-transparent p-0.5 dark:border-slate-700"
              />
              <button
                type="button"
                aria-label={`Remove ${value.id}`}
                title={protectedId ? `${value.id} is required by task lifecycle behavior` : `Remove ${value.id}`}
                disabled={!canRemove}
                onClick={() => onChange(values.filter((_, current) => current !== index))}
                className="rounded-md p-2 text-slate-400 hover:bg-red-500/10 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-25"
              >
                <Trash2 size={15} />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" onClick={add} className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
        <Plus size={14} /> Add {singular}
      </button>
    </Section>
  );
}

function SkillEditor({ values, onChange }: { values: EnumDef[]; onChange: (values: EnumDef[]) => void }) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const update = (index: number, patch: Partial<EnumDef>) =>
    onChange(values.map((value, current) => (current === index ? { ...value, ...patch } : value)));
  const add = () => {
    let suffix = values.length + 1;
    let id = "New skill";
    while (values.some((value) => value.id === id)) id = `New skill ${suffix++}`;
    const index = values.length;
    onChange([...values, { id, label: id, instructions: "", color: "#64748b" }]);
    setEditing(index);
    setExpanded((current) => new Set(current).add(index));
  };
  const remove = (index: number) => {
    onChange(values.filter((_, current) => current !== index));
    setEditing((current) => current === index ? null : current !== null && current > index ? current - 1 : current);
    setExpanded((current) => new Set([...current].flatMap((item) => item === index ? [] : [item > index ? item - 1 : item])));
  };
  const toggleExpanded = (index: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      next.has(index) ? next.delete(index) : next.add(index);
      return next;
    });
  };

  return (
    <Section
      title="Skills"
      description="Give each reusable execution role a title and the full instructions an agent should follow."
    >
      <div className="space-y-2">
        {values.map((value, index) => {
          const isEditing = editing === index;
          const isExpanded = expanded.has(index) || isEditing;
          return (
            <div key={index} className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
              <div className="flex min-h-11 items-center gap-2 px-3 py-2">
                <button type="button" aria-label={`${isExpanded ? "Collapse" : "Expand"} ${value.id}`} aria-expanded={isExpanded} onClick={() => toggleExpanded(index)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200">
                  {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: value.color }} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{value.id}</span>
                <button type="button" aria-label={`${isEditing ? "Stop editing" : "Edit"} ${value.id}`} onClick={() => { setEditing(isEditing ? null : index); setExpanded((current) => new Set(current).add(index)); }} className="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200">
                  {isEditing ? <X size={15} /> : <Pencil size={15} />}
                </button>
              </div>
              {isExpanded ? (
                <div className="border-t border-slate-200 px-3 py-3 dark:border-slate-800">
                  {isEditing ? (
                    <div className="grid grid-cols-[minmax(0,1fr)_2.5rem_2.25rem] gap-2">
                      <label className="min-w-0 text-xs font-medium text-slate-500">Skill title<input aria-label={`Skills title ${index + 1}`} value={value.id} onChange={(event) => update(index, { id: event.target.value, label: event.target.value })} className="mt-1 block w-full min-w-0 rounded-md border border-slate-300 bg-transparent px-2 py-1.5 text-sm font-normal text-slate-950 dark:border-slate-700 dark:text-slate-50" /></label>
                      <input aria-label={`Skills color ${index + 1}`} title="Skill color" type="color" value={value.color} onChange={(event) => update(index, { color: event.target.value })} className="mt-5 h-8 w-10 cursor-pointer rounded border border-slate-300 bg-transparent p-0.5 dark:border-slate-700" />
                      <button type="button" aria-label={`Remove ${value.id}`} onClick={() => remove(index)} className="mt-5 rounded-md p-2 text-slate-400 hover:bg-red-500/10 hover:text-red-500"><Trash2 size={15} /></button>
                      <label className="col-span-3 text-xs font-medium text-slate-500">Agent instructions<textarea aria-label={`Skills instructions ${index + 1}`} value={value.instructions ?? ""} onChange={(event) => update(index, { instructions: event.target.value })} placeholder="Describe how the agent should plan, implement, and verify work using this skill." rows={4} className="mt-1 block w-full resize-y rounded-md border border-slate-300 bg-transparent px-2 py-1.5 text-sm font-normal text-slate-950 dark:border-slate-700 dark:text-slate-50" /></label>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap text-sm leading-6 text-slate-600 dark:text-slate-300">{value.instructions?.trim() || "No agent instructions yet."}</p>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <button type="button" onClick={add} className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
        <Plus size={14} /> Add skill
      </button>
    </Section>
  );
}

export function SettingsView() {
  const { data: config, isLoading } = useConfig();
  const update = useUpdateConfig();
  const [draft, setDraft] = useState<BoardConfig | null>(null);

  useEffect(() => {
    if (config) setDraft(normalize(config));
  }, [config]);

  const dirty = useMemo(
    () => Boolean(config && draft && JSON.stringify(normalize(config)) !== JSON.stringify(normalize(draft))),
    [config, draft],
  );

  if (isLoading || !config || !draft) {
    return <div className="p-8 text-center text-sm text-slate-500">Loading settings…</div>;
  }

  const hiddenTabs = new Set(draft.navigation?.hiddenTabs ?? []);
  const hiddenColumns = new Set(draft.board?.hiddenColumns ?? []);
  const patch = (next: Partial<BoardConfig>) => setDraft((current) => (current ? { ...current, ...next } : current));

  const save = () => {
    update.mutate(normalize(draft), {
      onSuccess: (saved) => {
        setDraft(normalize(saved));
        toast("Settings saved", "success");
      },
    });
  };

  return (
    <div className="h-full overflow-auto bg-slate-50/50 p-4 dark:bg-slate-950/30 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Workspace settings</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-500">
              These values are stored locally in board.config.json. Changing an id does not rewrite existing task files.
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" disabled={!dirty || update.isPending} onClick={() => setDraft(normalize(config))} className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-slate-700">
              <RotateCcw size={14} /> Reset
            </button>
            <button type="button" disabled={!dirty || update.isPending} onClick={save} className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
              <Save size={14} /> {update.isPending ? "Saving…" : "Save settings"}
            </button>
          </div>
        </header>

        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Board columns" description="Choose which configured statuses appear on the Kanban board. Backlog also has its own dedicated view.">
            <label className="mb-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.board?.showBacklogColumn ?? false} onChange={(event) => patch({ board: { ...draft.board, showBacklogColumn: event.target.checked } })} />
              Show Backlog as a board column
            </label>
            <div className="space-y-1.5">
              {draft.statuses.filter((status) => status.id !== "Backlog").map((status) => {
                const visible = !hiddenColumns.has(status.id);
                return <button key={status.id} type="button" onClick={() => { const next = new Set(hiddenColumns); visible ? next.add(status.id) : next.delete(status.id); patch({ board: { ...draft.board, hiddenColumns: [...next] } }); }} className="flex w-full items-center justify-between rounded-md border border-slate-200 px-2.5 py-2 text-sm hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900"><span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: status.color }} />{status.label ?? status.id}</span>{visible ? <Eye size={15} /> : <EyeOff size={15} className="text-slate-400" />}</button>;
              })}
            </div>
            <label className="mt-3 block text-sm">Completed card limit<input type="number" min={1} max={500} value={draft.board?.completedColumnLimit ?? 10} onChange={(event) => patch({ board: { ...draft.board, completedColumnLimit: Number(event.target.value) || 10 } })} className="ml-3 w-20 rounded-md border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700" /></label>
          </Section>

          <Section title="Navigation tabs" description="Hide views you do not use. Hidden routes remain available by direct URL and can be restored here.">
            <div className="grid grid-cols-2 gap-2">
              {NAV_TABS.map(([route, label]) => {
                const visible = !hiddenTabs.has(route);
                return <button key={route} type="button" onClick={() => { const next = new Set(hiddenTabs); visible ? next.add(route) : next.delete(route); patch({ navigation: { hiddenTabs: [...next] } }); }} className="flex items-center justify-between rounded-md border border-slate-200 px-2.5 py-2 text-sm hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900"><span>{label}</span>{visible ? <Eye size={15} /> : <EyeOff size={15} className="text-slate-400" />}</button>;
              })}
            </div>
          </Section>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <VocabularyEditor title="Statuses" description="Backlog and Completed ids are protected because lifecycle behavior depends on them." singular="status" values={draft.statuses} protectedIds={PROTECTED_STATUSES} onChange={(statuses) => patch({ statuses })} />
          <VocabularyEditor title="Categories" description="Organize work by its primary kind." singular="category" values={draft.categories} onChange={(categories) => patch({ categories })} />
          <VocabularyEditor title="Severities" description="Ordered impact levels; order here determines rank." singular="severity" values={draft.severities} onChange={(severities) => patch({ severities })} />
          <VocabularyEditor title="Risks" description="Ordered delivery-risk levels; order here determines rank." singular="risk" values={draft.risks} onChange={(risks) => patch({ risks })} />
          <div className="lg:col-span-2">
            <SkillEditor values={draft.skills} onChange={(skills) => patch({ skills })} />
          </div>
        </div>
      </div>
    </div>
  );
}
