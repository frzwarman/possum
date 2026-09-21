import { Slot } from '@radix-ui/react-slot'
import { LoaderCircle } from 'lucide-react'
import { cva,type VariantProps } from 'class-variance-authority'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { ButtonHTMLAttributes } from 'react'
export const cn=(...args:Parameters<typeof clsx>)=>twMerge(clsx(...args))
const variants=cva('btn',{variants:{variant:{default:'btn-primary',secondary:'btn-secondary',ghost:'btn-ghost',destructive:'btn-danger'},size:{default:'',icon:'btn-icon',sm:'btn-sm'}},defaultVariants:{variant:'default',size:'default'}})
// loading: tombol tetap terbaca (label tidak diganti), hanya menambah spinner, aria-busy, dan
// mengunci klik ganda. asChild dilewati: Slot hanya menerima satu anak.
export function Button({className,variant,size,asChild=false,loading=false,disabled,children,...props}:ButtonHTMLAttributes<HTMLButtonElement>&VariantProps<typeof variants>&{asChild?:boolean;loading?:boolean}){const Comp=asChild?Slot:'button';return <Comp className={cn(variants({variant,size}),className)} aria-busy={loading||undefined} disabled={disabled||(loading&&!asChild)} {...props}>{loading&&!asChild&&<LoaderCircle size={17} className="spin" aria-hidden/>}{children}</Comp>}
