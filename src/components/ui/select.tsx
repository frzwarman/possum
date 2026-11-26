import { useEffect,useId,useRef,useState,type CSSProperties,type KeyboardEvent } from 'react'
import { Check,ChevronDown,Search } from 'lucide-react'
export interface Option { value:string; label:string; disabled?:boolean }
// Dropdown sendiri, bukan <select> bawaan: di ponsel daftar bawaan tidak bisa dibuat setinggi
// jari dan label panjang terpotong. Pola combobox: fokus tetap di tombol, opsi yang sedang
// disorot ditunjuk lewat aria-activedescendant, jadi pembaca layar tetap mengikuti.
// Daftar panjang (lebih dari 8 pilihan: bahan, menu, pemasok) membuka kolom cari di atasnya; fokus pindah ke kolom
// itu, ketikan menyaring daftar, dan setelah memilih fokus kembali ke tombol.
const SEARCH_FROM=9
export function Select({options,value,onChange,label,ariaLabel,disabled,placeholder='Pilih'}:{options:Option[];value:string;onChange:(value:string)=>void;label?:string;ariaLabel?:string;disabled?:boolean;placeholder?:string}){
 const id=useId();const box=useRef<HTMLDivElement>(null);const list=useRef<HTMLUListElement>(null);const trigger=useRef<HTMLButtonElement>(null)
 const [open,setOpen]=useState(false);const [place,setPlace]=useState<CSSProperties>()
 const [active,setActive]=useState(0);const [query,setQuery]=useState('')
 const searchable=options.length>=SEARCH_FROM
 const words=query.toLowerCase().split(/\s+/).filter(Boolean)
 // Typed words narrow the list (a "Pilih …" placeholder drops out); a label that starts with them comes first.
 const starts=(o:Option)=>Number(!o.label.toLowerCase().startsWith(words[0]))
 const shown=words.length?options.filter(o=>o.value!==''&&words.every(w=>o.label.toLowerCase().includes(w))).sort((a,b)=>starts(a)-starts(b)):options
 const index=Math.max(0,options.findIndex(o=>o.value===value));const selected=options.find(o=>o.value===value)
 useEffect(()=>{if(!open)return;const away=(e:PointerEvent)=>{if(!box.current?.contains(e.target as Node))setOpen(false)};document.addEventListener('pointerdown',away);return()=>document.removeEventListener('pointerdown',away)},[open])
 useEffect(()=>{if(open)list.current?.children[active]?.scrollIntoView({block:'nearest'})},[open,active])
 // Above 700px the list drops from the trigger (the phone's sheet sits at the bottom of the screen). It opens on whichever side
 // of the trigger has room, inside the dialog's own box when there is one, and shrinks to fit when neither side has (LB-10).
 function show(){
  let at:CSSProperties|undefined
  if(window.matchMedia('(min-width:701px)').matches&&trigger.current&&box.current){
   const t=trigger.current.getBoundingClientRect(),f=box.current.getBoundingClientRect(),d=trigger.current.closest('.dialog-content')?.getBoundingClientRect()
   const below=Math.min(innerHeight,d?d.bottom:innerHeight)-t.bottom-12,above=t.top-Math.max(0,d?d.top:0)-12,want=searchable?340:262,up=below<want&&above>below
   at=up?{top:'auto',bottom:f.bottom-t.top+6,maxHeight:Math.max(120,Math.min(want,above))}:{maxHeight:Math.max(120,Math.min(want,below))}}
  // Safari does not focus a button a tap or click lands on: without this, Escape and the arrows never reach the list (nor the dialog's own Escape rule).
  if(!searchable)trigger.current?.focus()
  setPlace(at);setQuery('');setActive(index);setOpen(true)}
 function close(refocus:boolean){setOpen(false);if(refocus&&searchable)trigger.current?.focus()}
 function commit(i:number){const option=shown[i];if(!option||option.disabled)return;onChange(option.value);close(true)}
 function keys(e:KeyboardEvent){
  if(!open){if(['Enter',' ','ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();show()}return}
  if(e.key==='Escape'){e.stopPropagation();close(true)}
  else if(e.key==='Tab')close(false)
  else if(e.key==='ArrowDown'){e.preventDefault();setActive(a=>Math.min(shown.length-1,a+1))}
  else if(e.key==='ArrowUp'){e.preventDefault();setActive(a=>Math.max(0,a-1))}
  else if(e.key==='Home'&&!searchable){e.preventDefault();setActive(0)}
  else if(e.key==='End'&&!searchable){e.preventDefault();setActive(shown.length-1)}
  else if(e.key==='Enter'||(e.key===' '&&!searchable)){e.preventDefault();commit(active)}
 }
 const items=<ul className={searchable?'select-list':'select-menu'} style={searchable?undefined:place} id={`${id}-list`} ref={list} role="listbox" aria-label={label??ariaLabel}>
  {shown.map((option,i)=><li key={option.value} id={`${id}-opt-${i}`} role="option" aria-selected={option.value===value} aria-disabled={option.disabled||undefined} className={`select-option${i===active?' active':''}`}
   onPointerDown={e=>e.preventDefault()} onPointerEnter={()=>setActive(i)} onClick={()=>commit(i)}>
   <span>{option.label}</span>{option.value===value&&<Check size={16} aria-hidden/>}</li>)}</ul>
 return <div className="field" ref={box}>
  {label&&<span className="field-label" id={`${id}-label`}>{label}</span>}
  <button type="button" ref={trigger} id={id} className="select-trigger" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`} aria-labelledby={label?`${id}-label ${id}`:undefined} aria-label={label?undefined:ariaLabel} aria-activedescendant={open&&!searchable?`${id}-opt-${active}`:undefined} disabled={disabled} onClick={()=>open?close(false):show()} onKeyDown={keys}>
   <span className={selected?undefined:'muted'}>{selected?.label??placeholder}</span><ChevronDown size={17} aria-hidden/></button>
  {open&&<><div className="select-backdrop" aria-hidden/>
  {searchable?<div className="select-menu searchable" style={place}>
   <div className="select-search"><Search size={16} aria-hidden/><input autoFocus aria-label={`Cari ${(label??ariaLabel??'pilihan').toLowerCase()}`} aria-controls={`${id}-list`} aria-activedescendant={shown[active]?`${id}-opt-${active}`:undefined} placeholder="Cari…" value={query} onChange={e=>{setQuery(e.target.value);setActive(0)}} onKeyDown={keys}/></div>
   {items}{!shown.length&&<p className="select-empty">Tidak ada yang cocok</p>}
  </div>:items}</>}
 </div>
}
