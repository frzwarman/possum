import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { useApp } from "./context";
import { Button } from "../components/ui/button";
import { telegramBot } from "../lib/supabase";
import type { Approval } from "../domain/types";
import type { ApprovalRequest } from "./Approval";
// The other way to get a manager's yes: the request goes to every linked owner and manager on Telegram,
// and the till checks every 2 seconds until someone answers or 5 minutes pass. The PIN stays above.
export function TelegramApproval({
  request,
  onApproved,
}: {
  request: ApprovalRequest;
  onApproved: (approval: Approval) => void;
}) {
  const { commands, user } = useApp();
  const [asked, setAsked] = useState<{ id: string; sent: number }>();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // The parent passes a new callback each render; keep the waiting loop running through those renders.
  const done = useRef(onApproved);
  done.current = onApproved;
  useEffect(() => {
    setAsked(undefined);
    setNote("");
  }, [request]);
  useEffect(() => {
    if (!asked) return;
    let stop = false;
    async function check() {
      if (stop) return;
      try {
        const r = await commands.telegramAnswer(asked!.id, request.action, request);
        if (stop) return;
        if (r.status === "approved") return done.current(r.approval);
        if (r.status !== "pending") {
          setAsked(undefined);
          return setNote(r.status === "rejected" ? `Ditolak oleh ${r.by}.` : "Tidak dijawab dalam 5 menit. Minta lagi atau pakai PIN.");
        }
      } catch {
        // A dropped connection only delays the answer; keep checking until the request expires.
      }
      setTimeout(check, 2000);
    }
    void check();
    return () => {
      stop = true;
    };
  }, [asked, commands, request]);
  if (!telegramBot || user.demo) return null;
  async function ask() {
    setBusy(true);
    setNote("");
    try {
      const r = await commands.askTelegram(request.action, request.what, request);
      if (!r.sent) return setNote("Belum ada pemilik atau manajer yang menautkan Telegram. Pakai PIN.");
      setAsked(r);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Permintaan gagal dikirim");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button variant="secondary" className="telegram-ask" loading={busy || Boolean(asked)} disabled={busy || Boolean(asked)} onClick={() => ask()}>
        <Send size={17} /> {asked ? `Menunggu jawaban di Telegram (${asked.sent} manajer)` : "Minta lewat Telegram"}
      </Button>
      {note && (
        <p className="small muted telegram-note" role="status">
          {note}
        </p>
      )}
    </>
  );
}
