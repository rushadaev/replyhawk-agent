import { ElectronAPI } from '@electron-toolkit/preload';
import type { AgentApi } from './index';

declare global {
  interface Window {
    electron: ElectronAPI;
    api: AgentApi;
  }
}
