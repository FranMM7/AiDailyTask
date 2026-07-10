import { X } from "lucide-react";
import { useToastStore } from "@/store/toast";

const KIND_CLS: Record<string, string> = {
  info: "border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
  success: "border-green-500/50 bg-green-500/10 text-green-700 dark:text-green-300",
  error: "border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-300",
};

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg ${
            KIND_CLS[t.kind] ?? KIND_CLS.info
          }`}
        >
          <span className="flex-1">{t.message}</span>
          <button type="button" onClick={() => dismiss(t.id)} className="opacity-60 hover:opacity-100">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
