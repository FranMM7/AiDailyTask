import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Share2, X } from "lucide-react";
import { request } from "@/api/client";

interface ShareStatus {
  phase: "idle" | "starting" | "active" | "stopping" | "error";
  installed: boolean;
  uiReady: boolean;
  url: string | null;
  expiresAt: string | null;
  error: string | null;
}
const control = "w-full rounded-md border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-600";

export function ShareDialog() {
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState("30");
  const [protectedLink, setProtectedLink] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ["share"], queryFn: () => request<ShareStatus>("/share"), enabled: local,
    retry: false,
    refetchInterval: query => ["starting", "active", "stopping"].includes(query.state.data?.phase ?? "") ? 2000 : false,
  });
  const action = useMutation({
    mutationFn: (stop: boolean) => request<ShareStatus>("/share", { method: stop ? "DELETE" : "POST",
      ...(stop ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minutes: Number(minutes), ...(protectedLink ? { auth: `${username}:${password}` } : {}) }) }),
    }),
    onSuccess: data => {
      client.setQueryData<ShareStatus>(["share"], old => ({ ...old!, ...data }));
      setPassword(""); setCopyMessage("");
      void client.invalidateQueries({ queryKey: ["share"] });
    },
  });
  if (!local) return null;
  const data = status.data;
  const running = data && ["starting", "active", "stopping"].includes(data.phase);
  const valid = Number.isInteger(Number(minutes)) && Number(minutes) >= 1 && Number(minutes) <= 1440 &&
    (!protectedLink || (!!username && !/[:\s]/.test(username) && !!password));
  return <Dialog.Root open={open} onOpenChange={value => { setOpen(value); if (value) { action.reset(); setCopyMessage(""); void status.refetch(); } else setPassword(""); }}>
    <Dialog.Trigger asChild><button type="button" className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm ${running ? "border-green-500 text-green-600 dark:text-green-400" : "border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"}`}><Share2 size={15}/>{running ? "Sharing" : "Share"}</button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/>
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center justify-between"><Dialog.Title className="text-lg font-semibold">Share your board</Dialog.Title><Dialog.Close aria-label="Close sharing" className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800"><X size={20}/></Dialog.Close></div>
        <Dialog.Description className="mt-2 text-sm text-slate-500">Create a temporary ngrok link. It closes automatically, even when you close this dialog.</Dialog.Description>
        <div className="mt-5 space-y-4 text-sm">
          {status.isPending && <p role="status">Checking ngrok…</p>}
          {(status.error || action.error || data?.error) && <p role="alert" className="break-words text-red-600 dark:text-red-400">{action.error?.message ?? status.error?.message ?? data?.error}</p>}
          {data && !data.installed && <p>ngrok was not found on PATH. <a className="text-blue-500 underline" href="https://ngrok.com/download" target="_blank" rel="noreferrer">Install ngrok</a>, configure it with <code className="break-all">ngrok config add-authtoken &lt;token&gt;</code>, then reopen this dialog.</p>}
          {data && !data.uiReady && <p>Run <code>npm run build</code> first so visitors can open the board.</p>}
          {running ? <>
            <p role="status">{data.phase === "starting" ? "Starting ngrok…" : data.phase === "stopping" ? "Closing the link…" : "Your link is ready"}</p>
            {data.url && <div className="space-y-2"><label className="block">Public link<input readOnly aria-label="Public link" className={`${control} mt-1`} value={data.url} onFocus={e => e.target.select()}/></label>
              <button type="button" className="inline-flex items-center gap-2 rounded border border-slate-300 px-3 py-2 dark:border-slate-600" onClick={() => { void navigator.clipboard.writeText(data.url!).then(() => setCopyMessage("Link copied")).catch(() => setCopyMessage("Select the link above and copy it manually.")); }}><Copy size={15}/>Copy link</button><span role="status" className="ml-2 text-xs">{copyMessage}</span></div>}
            {data.expiresAt && <p>Closes at {new Date(data.expiresAt).toLocaleString()}.</p>}
            <button type="button" disabled={action.isPending || data.phase === "stopping"} onClick={() => action.mutate(true)} className="rounded-md bg-red-600 px-4 py-2 font-medium text-white disabled:opacity-50">Stop sharing</button>
          </> : <form className="space-y-4" onSubmit={e => { e.preventDefault(); if (valid) action.mutate(false); }}>
            <label className="block space-y-1"><span>Link lifetime (minutes)</span><input type="number" min="1" max="1440" step="1" required value={minutes} onChange={e => setMinutes(e.target.value)} className={control}/><span className="block text-xs text-slate-500">From 1 minute to 24 hours. Stop it early at any time.</span></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={protectedLink} onChange={e => setProtectedLink(e.target.checked)}/>Require a username and password</label>
            {protectedLink && <div className="grid gap-3 sm:grid-cols-2"><label>Username<input required autoComplete="off" value={username} onChange={e => setUsername(e.target.value)} className={`${control} mt-1`}/></label><label>Password<input required type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} className={`${control} mt-1`}/></label></div>}
            <p className="rounded-md bg-amber-50 p-3 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">This shares the entire board with editing access. {protectedLink ? "Visitors must enter your credentials." : "Anyone with the link can view and edit it."}</p>
            <button type="submit" disabled={!valid || !data?.installed || !data?.uiReady || action.isPending || status.isError} className="rounded-md bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50">{action.isPending ? "Starting…" : "Start sharing"}</button>
          </form>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
