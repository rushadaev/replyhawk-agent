import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';

type Source = 'yelp' | 'thumbtack';

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
  chrome: {
    start: (source: Source) => ipcRenderer.invoke('chrome:start', source) as Promise<{ ok: true; port: number } | { ok: false; error: string }>,
    stop: (source: Source) => ipcRenderer.invoke('chrome:stop', source) as Promise<void>,
    list: () => ipcRenderer.invoke('chrome:list') as Promise<Array<{ platform: Source; port: number; running: boolean; hidden: boolean }>>,
    hide: (source: Source) => ipcRenderer.invoke('chrome:hide', source) as Promise<{ ok: true } | { ok: false; error: string }>,
    show: (source: Source) => ipcRenderer.invoke('chrome:show', source) as Promise<{ ok: true } | { ok: false; error: string }>,
  },
  watcher: {
    yelpSetBiz: (encid: string) => ipcRenderer.invoke('watcher:yelp:set-biz', encid) as Promise<void>,
    yelpDetect: () => ipcRenderer.invoke('watcher:yelp:detect') as Promise<string | null>,
    yelpGetBiz: () => ipcRenderer.invoke('watcher:yelp:get-biz') as Promise<string | null>,
    yelpStart: () => ipcRenderer.invoke('watcher:yelp:start') as Promise<{ ok: true; bizEncid: string | null } | { ok: false; error: string }>,
    yelpStop: () => ipcRenderer.invoke('watcher:yelp:stop') as Promise<void>,
    thumbtackStart: () => ipcRenderer.invoke('watcher:thumbtack:start') as Promise<{ ok: true } | { ok: false; error: string }>,
    thumbtackStop: () => ipcRenderer.invoke('watcher:thumbtack:stop') as Promise<void>,
    status: () => ipcRenderer.invoke('watcher:status') as Promise<{
      yelp: { status: string; lastTick?: number; lastError?: string };
      thumbtack: { status: string; lastTick?: number; lastError?: string };
    }>,
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
