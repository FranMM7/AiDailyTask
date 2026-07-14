import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, FolderPlus } from "lucide-react";
import { useAddProject } from "@/api/hooks";
import { toast } from "@/store/toast";

const inputCls =
  "w-full rounded-md border border-slate-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-slate-700";

/** Add a project to the local projects.json. Name doubles as id + label. */
export function AddProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const addProject = useAddProject();
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const rootTrimmed = root.trim();
    addProject.mutate(
      { id: trimmed, label: trimmed, ...(rootTrimmed ? { root: rootTrimmed } : {}) },
      {
        onSuccess: () => {
          toast(`Added project ${trimmed}`, "success");
          setName("");
          setRoot("");
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-200 bg-white p-5 text-slate-900 shadow-2xl outline-none dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">Add project</Dialog.Title>
            <Dialog.Description className="sr-only">Add a new project</Dialog.Description>
            <Dialog.Close className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800">
              <X size={18} />
            </Dialog.Close>
          </div>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Project name
            </span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="e.g. Desktop App, Website, Infra…"
              className={inputCls}
            />
          </label>

          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Source path <span className="font-normal normal-case text-slate-400">(optional)</span>
            </span>
            <input
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="e.g. C:\\Code\\my-project"
              className={`${inputCls} font-mono text-xs`}
            />
          </label>
          <p className="mt-2 text-xs text-slate-500">
            Saved to the local <code>projects.json</code> (not committed). The source path enables{" "}
            <strong>code-graph</strong> generation and can be added later.
          </p>

          <div className="mt-5 flex items-center justify-end gap-2">
            <Dialog.Close className="rounded-md px-3 py-1.5 text-sm text-slate-500 hover:text-slate-900 dark:hover:text-white">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              onClick={submit}
              disabled={!name.trim() || addProject.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <FolderPlus size={15} />
              {addProject.isPending ? "Adding…" : "Add project"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
