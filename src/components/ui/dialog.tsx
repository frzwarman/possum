import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useRef,type ReactNode } from 'react'
export function Dialog({open,onOpenChange,title,description,children,wide=false,media,className=''}:{open:boolean;onOpenChange:(open:boolean)=>void;title:string;description?:string;children:ReactNode;wide?:boolean;media?:ReactNode;className?:string}){
 // These dialogs open from state, not from a Radix trigger, so Radix has nothing to give focus back to on close.
 // Remember what had focus as the dialog opened (before an autoFocus field inside takes it) and return there.
 const opener=useRef<HTMLElement|null>(null);if(open&&!opener.current)opener.current=document.activeElement as HTMLElement|null
 return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}><DialogPrimitive.Portal><DialogPrimitive.Overlay className="dialog-overlay"/><DialogPrimitive.Content className={`dialog-content ${wide?'dialog-wide':''} ${className}`} onCloseAutoFocus={e=>{const el=opener.current;opener.current=null;if(el?.isConnected){e.preventDefault();el.focus()}}}><div className="dialog-heading">{media}<div><DialogPrimitive.Title>{title}</DialogPrimitive.Title>{description&&<DialogPrimitive.Description>{description}</DialogPrimitive.Description>}</div><DialogPrimitive.Close className="btn btn-icon btn-ghost" aria-label="Tutup"><X size={21}/></DialogPrimitive.Close></div>{children}</DialogPrimitive.Content></DialogPrimitive.Portal></DialogPrimitive.Root>}
