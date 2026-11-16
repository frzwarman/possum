import { useState } from "react";
import { Send } from "lucide-react";
import { useApp } from "../../app/context";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { telegramBot } from "../../lib/supabase";
// An owner or manager links their own Telegram once: Hubungkan opens the bot with a code valid for
// 15 minutes, and Start in the bot finishes it. Approvals, the 07:00 report and alerts then arrive there.
export function TelegramLink() {
  const { commands } = useApp();
  const [open, setOpen] = useState(false);
  const [linked, setLinked] = useState<boolean>();
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!telegramBot) return null;
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Telegram gagal dihubungi");
    } finally {
      setBusy(false);
    }
  }
  const refresh = () => run(async () => setLinked(await commands.telegramLinked()));
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setOpen(true);
          setLink("");
          void refresh();
        }}
      >
        <Send size={16} /> Telegram
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Telegram"
        description="Terima permintaan persetujuan, laporan pukul 07.00 dan peringatan selisih kas di Telegram."
      >
        {linked === undefined ? (
          <p className="muted">Memeriksa…</p>
        ) : linked ? (
          <>
            <p className="callout">Akun Anda sudah terhubung ke @{telegramBot}.</p>
            <Button variant="secondary" className="full" loading={busy} onClick={() => void run(async () => (await commands.telegramUnlink(), setLinked(false)))}>
              Putuskan
            </Button>
          </>
        ) : link ? (
          <>
            <p>Ketuk tombol di bawah, lalu tekan Start di Telegram. Tautan berlaku 15 menit dan hanya sekali.</p>
            <Button asChild className="full">
              <a href={link} target="_blank" rel="noreferrer">
                <Send size={17} /> Buka @{telegramBot}
              </a>
            </Button>
            <Button variant="ghost" className="full" loading={busy} onClick={() => void refresh()}>
              Saya sudah menekan Start
            </Button>
          </>
        ) : (
          <Button className="full" loading={busy} onClick={() => void run(async () => setLink(await commands.telegramLink()))}>
            Hubungkan
          </Button>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}
