import { Slot } from '@radix-ui/react-slot'
import { LoaderCircle } from 'lucide-react'
import { cva,type VariantProps } from 'class-variance-authority'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { useState,type ButtonHTMLAttributes,type MouseEvent } from 'react'
export const cn=(...args:Parameters<typeof clsx>)=>twMerge(clsx(...args))
const variants=cva('btn',{variants:{variant:{default:'btn-primary',secondary:'btn-secondary',ghost:'btn-ghost',destructive:'btn-danger'},size:{default:'',icon:'btn-icon',sm:'btn-sm'}},defaultVariants:{variant:'default',size:'default'}})
// loading: tombol tetap terbaca (label tidak diganti), hanya menambah spinner, aria-busy, dan
// mengunci klik ganda. asChild dilewati: Slot hanya menerima satu anak.
// onClick yang mengembalikan promise (simpan, kirim ke server, cetak) memutar spinner tombol itu sendiri
// sampai selesai, jadi hanya tombol yang ditekan yang berputar.
export function Button({className,variant,size,asChild=false,loading=false,disabled,children,onClick,...props}:Omit<ButtonHTMLAttributes<HTMLButtonElement>,'onClick'>&VariantProps<typeof variants>&{asChild?:boolean;loading?:boolean;onClick?:(e:MouseEvent<HTMLButtonElement>)=>unknown}){
 const [pending,setPending]=useState(false);const busy=loading||pending;const Comp=asChild?Slot:'button'
 const click=onClick&&((e:MouseEvent<HTMLButtonElement>)=>{const r=onClick(e);if(r&&typeof (r as PromiseLike<unknown>).then==='function'){setPending(true);void Promise.resolve(r).finally(()=>setPending(false))}})
 return <Comp className={cn(variants({variant,size}),className)} aria-busy={busy||undefined} disabled={disabled||(busy&&!asChild)} onClick={click} {...props}>{asChild?children:<>{busy&&<LoaderCircle size={17} className="spin" aria-hidden/>}{children}</>}</Comp>}
