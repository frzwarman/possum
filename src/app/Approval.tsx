import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useApp } from "./context";
import { Dialog } from "../components/ui/dialog";
import { Select } from "../components/ui/select";
import { Button } from "../components/ui/button";
import { PinPad } from "../components/ui/pinpad";
import { DEMO_PIN } from "../lib/commands";
import type { Approval, ApprovalAction } from "../domain/types";
export interface ApprovalRequest {
  action: ApprovalAction;
  what: string;
  amount?: number;
  orderId?: string;
}
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
  return (
    <Dialog
      open={Boolean(request)}
      onOpenChange={(open) => !open && onClose()}
      title="Persetujuan manajer"
      description={request?.what}
    >
      <p className="callout">
        <ShieldCheck size={18} /> Manajer atau pemilik memasukkan PIN-nya di
        sini. Tindakan dicatat atas nama Anda dan yang menyetujui.
      </p>
      <Select
        label="Disetujui oleh"
        value={who}
        onChange={setWho}
        options={approvers.map((a) => ({ value: a.id, label: a.name }))}
        placeholder="Belum ada manajer"
      />
      <PinPad label="PIN persetujuan" value={pin} onChange={setPin} onSubmit={() => void approve()} autoFocus={false} />
      {user.demo && <p className="small muted">Demo: PIN {DEMO_PIN}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <Button
        className="full"
        variant={request && ["void", "refund"].includes(request.action) ? "destructive" : "default"}
        loading={busy}
        disabled={busy || !who || pin.length !== 6}
        onClick={() => void approve()}
      >
        Setujui
      </Button>
    </Dialog>
  );
}
