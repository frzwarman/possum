import { lazy,Suspense,useState,type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { createRootRoute,createRoute,createRouter,RouterProvider,Navigate } from '@tanstack/react-router'
import { AppProvider,useApp } from './app/context'
import { can } from './domain/permissions'
import { Shell } from './app/Shell'
import { PageSkeleton } from './components/ui/loading'
import Login from './features/auth/Login'
import Pos from './features/pos/Pos'
import type { Identity } from './domain/types'
import '@fontsource-variable/plus-jakarta-sans'
import './styles.css'
import './styles/figma-pos.css'
import './styles/figma-orders.css'
import './styles/figma-approval.css'
import './styles/figma-stock.css'
import './styles/figma-counts.css'
import './styles/figma-audit.css'
import './styles/figma-reports.css'
import './styles/figma-purchases.css'
import './styles/figma-settings.css'
import './styles/figma-shell.css'
import './styles/figma-shift.css'
import './styles/figma-today.css'
const Orders=lazy(()=>import('./features/orders/Orders'))
const Discounts=lazy(()=>import('./features/discounts/Discounts'))
const Inventory=lazy(()=>import('./features/inventory/Inventory'))
const Reports=lazy(()=>import('./features/reports/Reports'))
const OpenShift=lazy(()=>import('./features/shift/OpenShift').then(m=>({default:m.OpenShift})))
const Settings=lazy(()=>import('./features/settings/Settings'))
const Admin=lazy(()=>import('./features/admin/Admin'))
const Sales=lazy(()=>import('./features/sales/Sales'))
const Purchases=lazy(()=>import('./features/purchases/Purchases'))
const Production=lazy(()=>import('./features/production/Production'))
const Catering=lazy(()=>import('./features/catering/Catering'))
const Transfers=lazy(()=>import('./features/transfers/Transfers'))
const Station=lazy(()=>import('./features/station/Station'))
const Counts=lazy(()=>import('./features/counts/Counts'))
const Today=lazy(()=>import('./features/today/Today'))
const Audit=lazy(()=>import('./features/audit/Audit'))
const Accounting=lazy(()=>import('./features/accounting/Accounting'))
const skeleton=<PageSkeleton/>
// A station tablet starts on its station; everyone else on the till.
// The cashier tablet never opens the manager screens while a shift is open (pilot rule).
function Office({children}:{children:ReactNode}){const {user,shift}=useApp();return user.primary&&shift?<Navigate to="/pos"/>:<>{children}</>}
// Tickets go to stations only when the store has bar and kitchen tablets on, or this device is one. Otherwise the
// crew works from Stok (waste, prep, counts) and the cashier tells them what to make, as in the Ziggy pilot.
function StationGate(){const {user,settings}=useApp();if(!can(user.role,'station'))return <Navigate to="/accounting"/>;if(settings&&!settings.stationTablets&&user.mode!=='station')return <Navigate to={can(user.role,'sell')?'/pos':'/inventory'}/>;return <Suspense fallback={skeleton}><Station/></Suspense>}
// A cashier starts on Sif, where the shift is seen and opened (OpenShift then goes on to Kasir).
function Home(){const {user}=useApp();return <Navigate to={user.mode==='station'?'/station':user.role==='cashier'?'/reports':can(user.role,'sell')?'/pos':can(user.role,'reports')?'/today':can(user.role,'backoffice')?'/menu':can(user.role,'accounting')?'/accounting':'/station'}/>}
const root=createRootRoute({component:Shell,notFoundComponent:Home})
const routes=[createRoute({getParentRoute:()=>root,path:'/',component:Home}),createRoute({getParentRoute:()=>root,path:'/station',component:StationGate}),createRoute({getParentRoute:()=>root,path:'/counts',component:()=> <Suspense fallback={skeleton}><Counts/></Suspense>}),createRoute({getParentRoute:()=>root,path:'/today',component:()=> <Office><Suspense fallback={skeleton}><Today/></Suspense></Office>}),createRoute({getParentRoute:()=>root,path:'/audit',component:()=> <Office><Suspense fallback={skeleton}><Audit/></Suspense></Office>}),createRoute({getParentRoute:()=>root,path:'/accounting',component:()=> <Office><Suspense fallback={skeleton}><Accounting/></Suspense></Office>}),createRoute({getParentRoute:()=>root,path:'/pos',component:Pos}),createRoute({getParentRoute:()=>root,path:'/orders',component:()=> <Suspense fallback={skeleton}><Orders/></Suspense>}),createRoute({getParentRoute:()=>root,path:'/inventory',component:()=> <Suspense fallback={skeleton}><Inventory/></Suspense>}),createRoute({getParentRoute:()=>root,path:'/reports',component:()=> <Suspense fallback={skeleton}><Reports/></Suspense>}),createRoute({getParentRoute:()=>root,path:'/sif/buka',component:()=> <Suspense fallback={skeleton}><OpenShift/></Suspense>}),createRoute({getParentRoute:()=>root,path:'/settings',component:()=> <Suspense fallback={skeleton}><Settings/></Suspense>}),createRoute({getParentRoute:()=>root,path:'/menu',component:()=> <Suspense fallback={skeleton}><Settings only="menu"/></Suspense>}),createRoute({getParentRoute:()=>root,path:'/discounts',component:()=> <Suspense fallback={skeleton}><Discounts/></Suspense>}),createRoute({getParentRoute:()=>root,path:'/team',component:()=> <Suspense fallback={skeleton}><Settings only="team"/></Suspense>}),createRoute({getParentRoute:()=>root,path:'/sales',component:()=> <Office><Suspense fallback={skeleton}><Sales/></Suspense></Office>}),createRoute({getParentRoute:()=>root,path:'/purchases',component:()=> <Office><Suspense fallback={skeleton}><Purchases/></Suspense></Office>}),createRoute({getParentRoute:()=>root,path:'/production',component:()=> <Suspense fallback={skeleton}><Production/></Suspense>}),createRoute({getParentRoute:()=>root,path:'/catering',component:()=> <Office><Suspense fallback={skeleton}><Catering/></Suspense></Office>}),createRoute({getParentRoute:()=>root,path:'/transfers',component:()=> <Office><Suspense fallback={skeleton}><Transfers/></Suspense></Office>})]
const router=createRouter({routeTree:root.addChildren(routes),defaultPreload:'intent'})
declare module '@tanstack/react-router' {interface Register {router:typeof router}}
// Area pemilik punya pintu masuk sendiri: dipilih dari URL sebelum router kasir dipasang,
// sehingga staf tidak pernah melihatnya dan admin tidak ikut memuat shell kasir.
function App(){const [identity,setIdentity]=useState<Identity|null>(()=>{try{return JSON.parse(localStorage.getItem('meja-identity')||'null')}catch{return null}});function login(u:Identity){localStorage.setItem('meja-identity',JSON.stringify(u));setIdentity(u);if(!u.demo)void router.navigate({to:u.mode==='station'?'/station':can(u.role,'backoffice')?'/today':can(u.role,'sell')?'/reports':can(u.role,'accounting')?'/accounting':'/station'})}if(location.pathname.startsWith('/admin'))return <Suspense fallback={skeleton}><Admin/></Suspense>
 return identity?<AppProvider user={identity}><RouterProvider router={router}/></AppProvider>:<Login onLogin={login}/>}
createRoot(document.getElementById('root')!).render(<App/> )
