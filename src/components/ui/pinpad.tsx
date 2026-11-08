import { Delete } from 'lucide-react'
// Six dots and a 3×4 pad, big enough for a thumb on the till. The real value lives in a visually
// hidden input so a keyboard, a password manager and the tests can still type into it.
export function PinPad({label,value,onChange,onSubmit,hint,autoFocus=true}:{label:string;value:string;onChange:(pin:string)=>void;onSubmit?:()=>void;hint?:string;autoFocus?:boolean}){
 const press=(d:string)=>{if(value.length<6)onChange(value+d)}
 const back=()=>onChange(value.slice(0,-1))
 return <div className="pin-pad-wrap">
  <input className="pin-input" aria-label={label} type="password" inputMode="numeric" autoComplete="off" maxLength={6} autoFocus={autoFocus} value={value} onChange={e=>onChange(e.target.value.replace(/\D/g,''))} onKeyDown={e=>{if(e.key==='Enter'&&value.length===6&&onSubmit){e.preventDefault();onSubmit()}}}/>
  <div className="pin-dots" aria-hidden>{[0,1,2,3,4,5].map(i=><i key={i} className={i<value.length?'on':''}/>)}</div>
  <div className="pin-pad">
   {['1','2','3','4','5','6','7','8','9'].map(d=><button type="button" key={d} aria-label={`Angka ${d}`} onClick={()=>press(d)}>{d}</button>)}
   <span/>
   <button type="button" aria-label="Angka 0" onClick={()=>press('0')}>0</button>
   <button type="button" className="ghost" aria-label="Hapus satu angka" onClick={back}><Delete size={22}/></button>
  </div>
  {hint&&<p className="small">{hint}</p>}
 </div>
}
