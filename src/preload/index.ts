import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';

type Source = 'yelp' | 'thumbtack' | 'craigslist' | 'facebook';

export interface CraigslistConfig { city: string; keywords: string[]; category: string }
export interface FacebookConfig { groupUrls: string[]; keywords: string[] }

type WatchStart = { ok: true; hidden?: boolean } | { ok: false; error: string };
type PollNow = { ok: true; ingested: number; total: number } | { ok: false; error: string };
type WatchLog = Array<{ at: number; ingested: number; total: number; note?: string }>;
type Shot = { at: number; b64: string } | null;

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
    snapshot: () => ipcRenderer.invoke('cloud:snapshot') as Promise<
      | { ok: true; counts: Record<string, number>; total: number; callQueue: Array<{ id: string; name: string; source: string; status: string }> }
      | { ok: false; error: string }
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
    yelpStart: () => ipcRenderer.invoke('watcher:yelp:start') as Promise<{ ok: true; bizEncid: string | null; hidden?: boolean } | { ok: false; error: string }>,
    yelpStop: () => ipcRenderer.invoke('watcher:yelp:stop') as Promise<void>,
    yelpPollNow: () => ipcRenderer.invoke('watcher:yelp:poll-now') as Promise<{ ok: true; ingested: number; total: number } | { ok: false; error: string }>,
    yelpLog: () => ipcRenderer.invoke('watcher:yelp:log') as Promise<Array<{ at: number; ingested: number; total: number; note?: string }>>,
    yelpScreenshot: () => ipcRenderer.invoke('watcher:yelp:screenshot') as Promise<{ at: number; b64: string } | null>,
    thumbtackStart: () => ipcRenderer.invoke('watcher:thumbtack:start') as Promise<{ ok: true; hidden?: boolean } | { ok: false; error: string }>,
    thumbtackStop: () => ipcRenderer.invoke('watcher:thumbtack:stop') as Promise<void>,
    thumbtackPollNow: () => ipcRenderer.invoke('watcher:thumbtack:poll-now') as Promise<{ ok: true; ingested: number; total: number } | { ok: false; error: string }>,
    thumbtackLog: () => ipcRenderer.invoke('watcher:thumbtack:log') as Promise<Array<{ at: number; ingested: number; total: number; note?: string }>>,
    thumbtackScreenshot: () => ipcRenderer.invoke('watcher:thumbtack:screenshot') as Promise<{ at: number; b64: string } | null>,
    craigslistGetConfig: () => ipcRenderer.invoke('watcher:craigslist:get-config') as Promise<CraigslistConfig | null>,
    craigslistStart: (cfg: CraigslistConfig) => ipcRenderer.invoke('watcher:craigslist:start', cfg) as Promise<WatchStart>,
    craigslistStop: () => ipcRenderer.invoke('watcher:craigslist:stop') as Promise<void>,
    craigslistPollNow: () => ipcRenderer.invoke('watcher:craigslist:poll-now') as Promise<PollNow>,
    craigslistLog: () => ipcRenderer.invoke('watcher:craigslist:log') as Promise<WatchLog>,
    craigslistScreenshot: () => ipcRenderer.invoke('watcher:craigslist:screenshot') as Promise<Shot>,
    facebookGetConfig: () => ipcRenderer.invoke('watcher:facebook:get-config') as Promise<FacebookConfig | null>,
    facebookStart: (cfg: FacebookConfig) => ipcRenderer.invoke('watcher:facebook:start', cfg) as Promise<WatchStart>,
    facebookStop: () => ipcRenderer.invoke('watcher:facebook:stop') as Promise<void>,
    facebookPollNow: () => ipcRenderer.invoke('watcher:facebook:poll-now') as Promise<PollNow>,
    facebookLog: () => ipcRenderer.invoke('watcher:facebook:log') as Promise<WatchLog>,
    facebookScreenshot: () => ipcRenderer.invoke('watcher:facebook:screenshot') as Promise<Shot>,
    status: () => ipcRenderer.invoke('watcher:status') as Promise<{
      yelp: { status: string; lastTick?: number; lastError?: string };
      thumbtack: { status: string; lastTick?: number; lastError?: string };
      craigslist: { status: string; lastTick?: number; lastError?: string };
      facebook: { status: string; lastTick?: number; lastError?: string };
      poller: { status: string; lastTick?: number; lastError?: string; sentCount: number; failedCount: number; pendingCount: number };
    }>,
  },
  poller: {
    log: () => ipcRenderer.invoke('poller:log') as Promise<Array<{
      at: number; leadId: string; source: string; status: 'sent' | 'failed'; text: string; error?: string;
    }>>,
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
