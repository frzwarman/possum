import type { Role } from "./types";
// Who may do what, as the owner sees it on the staff page. The screens hide what a role cannot
// use; Commands and apply_operation refuse it again, so a hidden button is never the only guard.
export const roleLabel: Record<Role, string> = {
  owner: "Pemilik",
  manager: "Manajer",
  cashier: "Kasir",
};
export const roleTitle: Record<Role, string> = {
  owner: "Pemilik · super admin",
  manager: "Manajer · admin",
  cashier: "Kasir",
};
type Grant = "Ya" | "PIN manajer" | "Tidak";
// [what, owner, manager, cashier]
export const access: [string, Grant, Grant, Grant][] = [
  ["Menjual, kirim ke dapur, terima pembayaran, cetak ulang bertanda SALINAN", "Ya", "Ya", "Ya"],
  ["Diskon, pembatalan pesanan, refund, kas keluar", "Ya", "Ya", "PIN manajer"],
  ["Kas yang seharusnya dan selisih saat tutup sif", "Ya", "Ya", "Tidak"],
  ["Laporan penjualan, pesanan di luar sif sendiri, jejak koreksi", "Ya", "Ya", "Tidak"],
  ["Menu, stok, pembelian, produksi, katering, transfer antar-outlet, pengaturan", "Ya", "Ya", "Tidak"],
  ["Akun staf dan perangkat kasir utama", "Ya", "Tidak", "Tidak"],
];
