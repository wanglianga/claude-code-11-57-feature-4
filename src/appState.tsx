import { createContext, useContext, useState, type ReactNode } from 'react';
import type { ID } from './types';

interface AppState {
  selectedRunId: ID | null;
  setSelectedRunId: (id: ID | null) => void;
  /** 数据变更计数器，供各页面刷新 */
  dataVersion: number;
  bumpData: () => void;
}

const AppCtx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [selectedRunId, setSelectedRunId] = useState<ID | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  return (
    <AppCtx.Provider
      value={{
        selectedRunId,
        setSelectedRunId,
        dataVersion,
        bumpData: () => setDataVersion((v) => v + 1),
      }}
    >
      {children}
    </AppCtx.Provider>
  );
}

export function useAppState(): AppState {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error('useAppState 必须在 AppProvider 内使用');
  return ctx;
}
