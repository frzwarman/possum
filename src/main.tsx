import { lazy,Suspense,useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createRootRoute,createRoute,createRouter,RouterProvider,Navigate } from '@tanstack/react-router'
import { AppProvider } from './app/context'
import { Shell } from './app/Shell'
import Login from './features/auth/Login'
import Pos from './features/pos/Pos'
import type { Identity } from './domain/types'
import './styles.css'
const Orders=lazy(()=>import('./features/orders/Orders'))
const Inventory=lazy(()=>import('./features/inventory/Inventory'))
const Reports=lazy(()=>import('./features/reports/Reports'))
const Settings=lazy(()=>import('./features/settings/Settings'))
const Admin=lazy(()=>import('./features/admin/Admin'))
const skeleton=<div className="page-content" role="status" aria-label="Memuat halaman"><div className="skeleton skeleton-line short"/><div className="skeleton skeleton-title"/><div className="panel">{[0,1,2,3].map(i=><div className="skeleton skeleton-row" key={i}/>)}</div></div>
const root=createRootRoute({component:Shell,notFoundComponent:()=> <Navigate to="/pos"/>})
const routes=[createRoute({getParentRoute:()=>root,path:'/',component:()=> <Navigate to="/pos"/>}),createRoute({getParentRoute:()=>root,path:'/pos',component:Pos}),createRoute({getParentRoute:()=>root,path:'/orders',component:()=> <Suspense fallback={skeleton}><Orders/></Suspense>}),createRoute({getParentRoute:()=>root,path:'/inventory',component:()=> <Suspense fallback={skeleton}><Inventory/></Suspense>}),createRoute({getParentRoute:()=>root,path:'/reports',component:()=> <Suspense fallback={skeleton}><Reports/></Suspense>}),createRoute({getParentRoute:()=>root,path:'/settings',component:()=> <Suspense fallback={skeleton}><Settings/></Suspense>})]
const router=createRouter({routeTree:root.addChildren(routes),defaultPreload:'intent'})
declare module '@tanstack/react-router' {interface Register {router:typeof router}}
// Area pemilik punya pintu masuk sendiri: dipilih dari URL sebelum router kasir dipasang,
// sehingga staf tidak pernah melihatnya dan admin tidak ikut memuat shell kasir.
function App(){const [identity,setIdentity]=useState<Identity|null>(()=>{try{return JSON.parse(localStorage.getItem('meja-identity')||'null')}catch{return null}});function login(u:Identity){localStorage.setItem('meja-identity',JSON.stringify(u));setIdentity(u);if(u.role!=='cashier'&&!u.demo)void router.navigate({to:'/reports'})}if(location.pathname.startsWith('/admin'))return <Suspense fallback={skeleton}><Admin/></Suspense>
 return identity?<AppProvider user={identity}><RouterProvider router={router}/></AppProvider>:<Login onLogin={login}/>}
createRoot(document.getElementById('root')!).render(<App/> )
