import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';

// Safe bridge exposing only the IPC methods we want the renderer to call.
const api = {
  auth: {
    getToken: () => ipcRenderer.invoke('auth:get-token') as Promise<{ hasToken: boolean; preview?: string }>,
    setToken: (token: string) => ipcRenderer.invoke('auth:set-token', token) as Promise<void>,
    clearToken: () => ipcRenderer.invoke('auth:clear-token') as Promise<void>,
    verifyToken: (token: string) => ipcRenderer.invoke('auth:verify-token', token) as Promise<
      { ok: true; preview: unknown } | { ok: false; error: string }
    >,
  },
  cloud: {
    heartbeat: () => ipcRenderer.invoke('cloud:heartbeat') as Promise<
      | { ok: true; ts: number }
      | { ok: false; reason: 'no_token' | 'unauthorized' | 'unreachable'; detail?: string }
    >,
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI);
    contextBridge.exposeInMainWorld('api', api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI;
  // @ts-ignore (define in dts)
  window.api = api;
}

export type AgentApi = typeof api;
