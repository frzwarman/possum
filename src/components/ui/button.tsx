import { Slot } from '@radix-ui/react-slot'
import { cva,type VariantProps } from 'class-variance-authority'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { ButtonHTMLAttributes } from 'react'
export const cn=(...args:Parameters<typeof clsx>)=>twMerge(clsx(...args))
const variants=cva('btn',{variants:{variant:{default:'btn-primary',secondary:'btn-secondary',ghost:'btn-ghost',destructive:'btn-danger'},size:{default:'',icon:'btn-icon',sm:'btn-sm'}},defaultVariants:{variant:'default',size:'default'}})
export function Button({className,variant,size,asChild=false,...props}:ButtonHTMLAttributes<HTMLButtonElement>&VariantProps<typeof variants>&{asChild?:boolean}){const Comp=asChild?Slot:'button';return <Comp className={cn(variants({variant,size}),className)} {...props}/>}
