import { useState } from "react";
import type { TaskDetail } from "@AiDailyTasks/shared";
import { usePatchTask } from "@/api/hooks";
import { toast } from "@/store/toast";
import { MarkdownView } from "./MarkdownView";

export function BlockerSection({ task }: { task: TaskDetail }) {
  const patch = usePatchTask();
  const [draft, setDraft] = useState<{ text: string; rev: number } | null>(null);
  const [preview, setPreview] = useState(false);
  const save = (text: string, rev: number) => {
    patch.mutate({ id: task.id, body: { baseRev: rev, fields: { blocker: text } } }, {
      onSuccess: () => {
        setDraft(null);
        setPreview(false);
        toast(text.trim() ? "Blocker saved" : "Blocker resolved and recorded in observations", "success");
      },
    });
  };
  const button = "rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-slate-700";
  return (
    <section className="space-y-4" aria-label="Blocker details">
      <div>
        <h3 className="text-sm font-semibold">{task.blocker ? "Current blocker" : "No active blocker"}</h3>
        <p className="mt-1 text-xs text-slate-500">
          {task.blocked_since ? `Blocked since ${new Date(task.blocked_since).toLocaleString()}. ` : ""}
          Describe what prevents progress, the evidence, what has been tried, and what is needed next.
          Resolving saves the full details and dates in observations.
        </p>
      </div>
      {draft ? (
        <>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} onClick={() => setPreview(!preview)}>
              {preview ? "Continue editing" : "Preview Markdown"}
            </button>
            <span className="self-center text-xs text-slate-500">{draft.text.length.toLocaleString()} / 100,000 characters</span>
          </div>
          {preview ? <MarkdownView markdown={draft.text || "Nothing to preview yet."} /> : (
            <textarea aria-label="Blocker Markdown" value={draft.text} rows={18} maxLength={100_000}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              placeholder={"## What is blocking progress\n\n## Evidence and attempts\n\n## What is needed to unblock"}
              className="min-h-80 w-full rounded-md border border-slate-300 bg-transparent p-3 font-mono text-sm outline-none focus:border-blue-500 dark:border-slate-700" />
          )}
          {draft.rev !== task.rev && <p className="text-sm text-amber-600">This task changed while you were editing. Your draft is preserved; cancel and reopen to load the latest version before saving.</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={button} disabled={patch.isPending} onClick={() => { setDraft(null); setPreview(false); }}>Cancel</button>
            <button type="button" disabled={patch.isPending || !draft.text.trim() || draft.rev !== task.rev}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
              onClick={() => save(draft.text, draft.rev)}>{patch.isPending ? "Saving..." : "Save blocker"}</button>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={patch.isPending}
              onClick={() => setDraft({ text: task.blocker, rev: task.rev })}>{task.blocker ? "Edit blocker" : "Add blocker"}</button>
            {task.blocker && <button type="button" className={button} disabled={patch.isPending}
              onClick={() => save("", task.rev)}>Resolve blocker</button>}
          </div>
          {task.blocker && <MarkdownView markdown={task.blocker} />}
        </>
      )}
    </section>
  );
}
