import { LoaderCircle } from 'lucide-react'
// Waiting, shown from one place: a turning circle with what is happening (a short wait inside a panel),
// skeleton rows (a list on its way from the server), and the page skeleton (a screen whose data is still
// being read). Buttons spin by themselves (components/ui/button).
export const Spinner=({label}:{label:string})=><span className="spinner-note" role="status"><LoaderCircle size={16} className="spin" aria-hidden/>{label}</span>
export const SkeletonRows=({label,count=3}:{label:string;count?:number})=><div role="status" aria-label={label}>{Array.from({length:count},(_,i)=><div className="skeleton skeleton-row" key={i}/>)}</div>
export const PageSkeleton=()=><div className="page-content" role="status" aria-label="Memuat halaman"><div className="skeleton skeleton-line short"/><div className="skeleton skeleton-title"/><div className="panel">{[0,1,2,3].map(i=><div className="skeleton skeleton-row" key={i}/>)}</div></div>
