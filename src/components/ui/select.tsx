import { useEffect,useId,useRef,useState,type KeyboardEvent } from 'react'
import { Check,ChevronDown } from 'lucide-react'
export interface Option { value:string; label:string; disabled?:boolean }
// Dropdown sendiri, bukan <select> bawaan: di ponsel daftar bawaan tidak bisa dibuat setinggi
// jari dan label panjang terpotong. Pola combobox: fokus tetap di tombol, opsi yang sedang
// disorot ditunjuk lewat aria-activedescendant, jadi pembaca layar tetap mengikuti.
export function Select({options,value,onChange,label,ariaLabel,disabled,placeholder='Pilih'}:{options:Option[];value:string;onChange:(value:string)=>void;label?:string;ariaLabel?:string;disabled?:boolean;placeholder?:string}){
 const id=useId();const box=useRef<HTMLDivElement>(null);const list=useRef<HTMLUListElement>(null)
 const [open,setOpen]=useState(false);const [active,setActive]=useState(0)
 const index=Math.max(0,options.findIndex(o=>o.value===value));const selected=options.find(o=>o.value===value)
 useEffect(()=>{if(!open)return;const away=(e:PointerEvent)=>{if(!box.current?.contains(e.target as Node))setOpen(false)};document.addEventListener('pointerdown',away);return()=>document.removeEventListener('pointerdown',away)},[open])
 useEffect(()=>{if(open)list.current?.children[active]?.scrollIntoView({block:'nearest'})},[open,active])
 function commit(i:number){const option=options[i];if(!option||option.disabled)return;onChange(option.value);setOpen(false)}
 function keys(e:KeyboardEvent){
  if(!open){if(['Enter',' ','ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();setActive(index);setOpen(true)}return}
  if(e.key==='Escape'){e.stopPropagation();setOpen(false)}
  else if(e.key==='Tab')setOpen(false)
  else if(e.key==='ArrowDown'){e.preventDefault();setActive(a=>Math.min(options.length-1,a+1))}
  else if(e.key==='ArrowUp'){e.preventDefault();setActive(a=>Math.max(0,a-1))}
  else if(e.key==='Home'){e.preventDefault();setActive(0)}
  else if(e.key==='End'){e.preventDefault();setActive(options.length-1)}
  else if(e.key==='Enter'||e.key===' '){e.preventDefault();commit(active)}
 }
 return <div className="field" ref={box}>
  {label&&<span className="field-label" id={`${id}-label`}>{label}</span>}
  <button type="button" id={id} className="select-trigger" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`} aria-labelledby={label?`${id}-label ${id}`:undefined} aria-label={label?undefined:ariaLabel} aria-activedescendant={open?`${id}-opt-${active}`:undefined} disabled={disabled} onClick={()=>{setActive(index);setOpen(o=>!o)}} onKeyDown={keys}>
   <span className={selected?undefined:'muted'}>{selected?.label??placeholder}</span><ChevronDown size={17} aria-hidden/></button>
  {open&&<><div className="select-backdrop" aria-hidden/>
  <ul className="select-menu" id={`${id}-list`} ref={list} role="listbox" aria-label={label??ariaLabel}>
   {options.map((option,i)=><li key={option.value} id={`${id}-opt-${i}`} role="option" aria-selected={option.value===value} aria-disabled={option.disabled||undefined} className={`select-option${i===active?' active':''}`}
    onPointerDown={e=>e.preventDefault()} onPointerEnter={()=>setActive(i)} onClick={()=>commit(i)}>
    <span>{option.label}</span>{option.value===value&&<Check size={16} aria-hidden/>}</li>)}</ul></>}
 </div>
}
