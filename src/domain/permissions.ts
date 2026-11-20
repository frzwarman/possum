import type { Role } from './types'
// Who may do what, as the owner sees it on the staff page. The screens hide what a role cannot
// use; Commands and apply_operation refuse it again, so a hidden button is never the only guard.
export const roleLabel:Record<Role,string>={owner:'Pemilik',manager:'Manajer',admin:'Admin stok',chef:'Kepala dapur',cashier:'Kasir',barista:'Barista',kitchen:'Dapur',accountant:'Akuntan'}
export const roleTitle:Record<Role,string>={owner:'Pemilik · super admin',manager:'Manajer · menyetujui',admin:'Admin stok · bahan, hitung & persetujuan',chef:'Kepala dapur · resep',cashier:'Kasir',barista:'Barista · stasiun bar',kitchen:'Dapur · stasiun dapur',accountant:'Akuntan · pembukuan'}
export const roles=Object.keys(roleLabel) as Role[]
export type Action='sell'|'station'|'backoffice'|'approve'|'pin'|'catalog'|'inventory'|'documents'|'waste'|'prep'|'counts'|'reports'|'settings'|'team'|'audit'|'accounting'
const everyone:Role[]=roles.filter(r=>r!=='accountant'),office:Role[]=['owner','manager','admin','chef'],crew:Role[]=['owner','manager','admin','chef','cashier','barista','kitchen'],managers:Role[]=['owner','manager']
// accounting: the books and the cash book of costs (owner, manager and the accountant, who otherwise only reads the audit log).
// approve: acts without asking anyone (owner, manager). pin: may type a PIN at the till to approve someone else's void,
// discount or gap; an admin can too (reviewer, 17 Nov), while the admin's own actions still need someone's approval.
const grants:Record<Action,Role[]>={sell:['owner','manager','cashier'],station:everyone,backoffice:office,approve:managers,pin:[...managers,'admin'],catalog:office,inventory:['owner','manager','admin'],documents:['owner','manager','admin'],waste:crew,prep:crew,counts:crew,reports:managers,settings:managers,team:managers,audit:[...managers,'accountant'],accounting:[...managers,'accountant']}
export const can=(role:Role,action:Action)=>grants[action].includes(role)
type Grant='Ya'|'PIN manajer'|'Tidak'
// [what, ...one column per role in `roles` order]
export const access:[string,...Grant[]][]=[
 ['Menjual, kirim ke stasiun, terima pembayaran, buka & tutup sif','Ya','Ya','Tidak','Tidak','Ya','Tidak','Tidak','Tidak'],
 ['Diskon, pembatalan, refund, kas keluar, selisih kas di atas batas','Ya','Ya','Tidak','Tidak','PIN manajer','Tidak','Tidak','Tidak'],
 ['Menyetujui permintaan orang lain dengan PIN','Ya','Ya','Ya','Tidak','Tidak','Tidak','Tidak','Tidak'],
 ['Stok harian: catat buang, buat batch olahan, hitung stok (persetujuan perlu PIN manajer)','Ya','Ya','Ya','Ya','Ya','Ya','Ya','Tidak'],
 ['Menu & resep (terbit tanpa resep perlu PIN manajer)','Ya','Ya','PIN manajer','PIN manajer','Tidak','Tidak','Tidak','Tidak'],
 ['Bahan, terima kiriman, pembelian','Ya','Ya','Ya','Tidak','Tidak','Tidak','Tidak','Tidak'],
 ['Hari ini, laporan, pengaturan, perangkat','Ya','Ya','Tidak','Tidak','Tidak','Tidak','Tidak','Tidak'],
 ['Akuntansi: laporan, jurnal, buku besar, neraca, dan mencatat biaya; membaca log audit','Ya','Ya','Tidak','Tidak','Tidak','Tidak','Tidak','Ya'],
 ['Akun staf','Ya','Ya','Tidak','Tidak','Tidak','Tidak','Tidak','Tidak'],
]
