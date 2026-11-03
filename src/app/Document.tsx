import { MessageCircle, Printer } from "lucide-react";
import { Dialog } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
// Indonesian numbers are written 08…; WhatsApp wants the country code without + or spaces.
export const whatsappNumber = (phone = "") => {
  const digits = phone.replace(/\D/g, "");
  return digits.startsWith("0") ? `62${digits.slice(1)}` : digits;
};
// A purchase or sales order to hand over: printed on the receipt printer, or sent as WhatsApp text.
export function DocumentDialog({ title, text, phone, onClose }: { title: string; text: string; phone?: string; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={onClose} title={title} description="Pratinjau. Cetak di printer struk atau kirim lewat WhatsApp.">
      <div id="print-area" className="receipt-paper">
        <pre>{text}</pre>
      </div>
      <div className="button-row mt">
        <Button onClick={() => window.print()}>
          <Printer size={17} /> Cetak
        </Button>
        <Button asChild variant="secondary">
          <a href={`https://wa.me/${whatsappNumber(phone)}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">
            <MessageCircle size={17} /> Kirim WhatsApp
          </a>
        </Button>
      </div>
      {!whatsappNumber(phone) && <p className="small muted">Belum ada nomor; WhatsApp akan meminta Anda memilih kontak.</p>}
    </Dialog>
  );
}
