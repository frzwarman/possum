// The Takar mark, "the pour": a T whose stem pours, and a lime drop for the measured amount.
// Drawn on the brand sheet's 64 grid (stem width = 1 unit = 14). Holds at 16 px.
export function Mark({size=32,className,mono=false}:{size?:number;className?:string;mono?:boolean}){
 return <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden focusable="false">
  {!mono&&<rect width="64" height="64" rx="16" fill="#1B1D21"/>}
  <path d="M10 13h35a7 7 0 0 1 0 14H38v20a7 7 0 0 1-14 0V27H10z" fill={mono?'currentColor':'#FFFFFF'}/>
  <circle cx="48.5" cy="40" r="5.5" fill={mono?'currentColor':'#D3F26A'}/>
 </svg>
}
