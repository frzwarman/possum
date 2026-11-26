import { useEffect, useState } from "react";
import { Check, LockKeyhole, TriangleAlert } from "lucide-react";
import { useApp } from "./context";
import { Dialog } from "../components/ui/dialog";
import { Select } from "../components/ui/select";
import { Button } from "../components/ui/button";
import { PinPad } from "../components/ui/pinpad";
import { TelegramApproval } from "./TelegramApproval";
import { DEMO_PIN } from "../lib/commands";
import type { Approval, ApprovalAction } from "../domain/types";
export interface ApprovalRequest {
  action: ApprovalAction;
  what: string;
  amount?: number;
  orderId?: string;
  lineId?: string;
}
// Corrections say what happens to stock where the manager approves them: made food is used, not restocked.
const corrections: Partial<Record<ApprovalAction, { label: string; note: string }>> = {
  void: { label: "Setujui pembatalan", note: "Yang sudah dibuat tetap tercatat terpakai, bahannya tidak kembali ke stok." },
  voidline: { label: "Setujui pembatalan", note: "Yang sudah dibuat tetap tercatat terpakai, bahannya tidak kembali ke stok." },
  refund: { label: "Setujui refund", note: "Refund tidak mengembalikan bahan ke stok." },
};
// Supervisor override at the till: the cashier stays signed in, a manager or the owner picks their
// name and types their PIN, and the action is recorded under both.
export function ApprovalDialog({
  request,
  onApproved,
  onClose,
}: {
  request?: ApprovalRequest;
  onApproved: (approval: Approval) => void;
  onClose: () => void;
}) {
  const { commands, user } = useApp();
  const [approvers, setApprovers] = useState<{ id: string; name: string }[]>([]);
  const [who, setWho] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!request) return;
    setPin("");
    setError("");
    commands.approvers().then(
      (list) => {
        setApprovers(list);
        setWho((w) => (list.some((a) => a.id === w) ? w : list[0]?.id || ""));
      },
      (e) => setError(e instanceof Error ? e.message : "Daftar manajer gagal dimuat"),
    );
  }, [request, commands]);
  async function approve() {
    if (!request) return;
    setBusy(true);
    setError("");
    try {
      onApproved(await commands.approve(who, pin, request.action, request));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Persetujuan gagal");
      setPin("");
    } finally {
      setBusy(false);
    }
  }
  // Callers put the typed reason last ("Batalkan 1× Es teh di Meja 4 · Salah menu"); it shows under Alasan.
  const parts = request?.what.split(" · ") ?? [];
  const reason = request && ["void", "voidline", "refund", "discount", "cashout"].includes(request.action) && parts.length > 1 ? parts.pop() : undefined;
  const kind = request && corrections[request.action];
  // A correction reads as on C6 ("Kinoy ingin membatalkan 2× Seasalt Latte (Rp84.000) di pesanan #A-1043"); other requests stay "meminta: …".
  const ask = parts.join(" · ").replace(/^Batalkan /, "ingin membatalkan ").replace(/^Kembalikan dana /, "ingin mengembalikan dana ");
  return (
    <Dialog
      open={Boolean(request)}
      onOpenChange={(open) => !open && onClose()}
      title="Perlu persetujuan manajer"
      description={request && `${user.name} ${ask.startsWith("ingin ") ? ask : `meminta: ${ask}`}.`}
      className="approval-dialog"
      media={<span className="approval-icon"><LockKeyhole size={22} strokeWidth={1.75} /></span>}
    >
      <div className="approval-detail">
        {kind && <p className="approval-note"><TriangleAlert size={18} />{kind.note}</p>}
        {reason && <p className="approval-reason">Alasan<b>{reason}</b></p>}
      </div>
      <div className="approval-pin">
        <div className="approval-who">
          <Select
            ariaLabel="Disetujui oleh"
            value={who}
            onChange={setWho}
            options={approvers.map((a) => ({ value: a.id, label: a.name }))}
            placeholder="Belum ada manajer"
          />
          {who && <span>, masukkan PIN</span>}
        </div>
        <PinPad label="PIN persetujuan" value={pin} onChange={setPin} onSubmit={() => void approve()} autoFocus={false} hint={user.demo ? `Demo: PIN ${DEMO_PIN}` : undefined} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="approval-actions">
          <Button variant="ghost" onClick={onClose}>
            Batal
          </Button>
          <Button
            variant={kind ? "destructive" : "default"}
            className={kind ? undefined : "btn-accent"}
            loading={busy}
            disabled={busy || !who || pin.length !== 6}
            onClick={() => approve()}
          >
            {!busy && <Check size={18} />}
            {kind?.label ?? "Setujui"}
          </Button>
        </div>
        {request && <TelegramApproval request={request} onApproved={onApproved} />}
      </div>
    </Dialog>
  );
}
