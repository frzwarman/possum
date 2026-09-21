import 'fake-indexeddb/auto'
import '@testing-library/jest-dom/vitest'
// jsdom lacks the APIs the cashier shell relies on; keep them predictable per test.
if(!globalThis.crypto?.randomUUID){const {webcrypto}=await import('node:crypto');Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true})}
if(!navigator.locks)Object.defineProperty(navigator,'locks',{value:{request:(_n:string,_o:unknown,fn:(l:unknown)=>unknown)=>fn({})},configurable:true})
