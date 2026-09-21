import type { InputHTMLAttributes } from 'react'
const grouped=new Intl.NumberFormat('id-ID')
// Kolom rupiah: yang diketik tetap angka polos, yang terlihat sudah bertitik ribuan sesuai
// kebiasaan Indonesia. type=text, bukan number: kolom number menolak titik pemisah dan pada
// sebagian papan ketik Android mengosongkan nilai begitu koma ditekan.
// ponytail: kursor pindah ke akhir bila menyunting di tengah angka; cukup untuk entri kasir,
// ganti dengan pemetaan posisi kursor bila kasir mulai mengeluh.
export function Money({value,onChange,...props}:{value:string;onChange:(digits:string)=>void}&Omit<InputHTMLAttributes<HTMLInputElement>,'value'|'onChange'|'type'>){
 return <span className="money-field"><span className="money-prefix" aria-hidden>Rp</span>
  <input type="text" inputMode="numeric" autoComplete="off" value={value===''?'':grouped.format(Number(value))} onChange={e=>onChange(e.target.value.replace(/\D/g,''))} {...props}/></span>
}
