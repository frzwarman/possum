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
const root=createRootRoute({component:Shell,notFoundComponent:()=> <Navigate to="/pos"/>})
const routes=[createRoute({getParentRoute:()=>root,path:'/',component:()=> <Navigate to="/pos"/>}),createRoute({getParentRoute:()=>root,path:'/pos',component:Pos}),createRoute({getParentRoute:()=>root,path:'/orders',component:()=> <Suspense fallback={<p className="loading">Chargement…</p>}><Orders/></Suspense>}),createRoute({getParentRoute:()=>root,path:'/inventory',component:()=> <Suspense fallback={<p className="loading">Memuat stok…</p>}><Inventory/></Suspense>}),createRoute({getParentRoute:()=>root,path:'/reports',component:()=> <Suspense fallback={<p className="loading">Memuat laporan…</p>}><Reports/></Suspense>}),createRoute({getParentRoute:()=>root,path:'/settings',component:()=> <Suspense fallback={<p className="loading">Memuat pengaturan…</p>}><Settings/></Suspense>})]
const router=createRouter({routeTree:root.addChildren(routes),defaultPreload:'intent'})
declare module '@tanstack/react-router' {interface Register {router:typeof router}}
function App(){const [identity,setIdentity]=useState<Identity|null>(()=>{try{return JSON.parse(localStorage.getItem('meja-identity')||'null')}catch{return null}});function login(u:Identity){localStorage.setItem('meja-identity',JSON.stringify(u));setIdentity(u);if(u.role!=='cashier'&&!u.demo)void router.navigate({to:'/reports'})}return identity?<AppProvider user={identity}><RouterProvider router={router}/></AppProvider>:<Login onLogin={login}/>}
createRoot(document.getElementById('root')!).render(<App/> )
