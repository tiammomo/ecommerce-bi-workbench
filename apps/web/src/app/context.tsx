import { createContext, useContext } from "react";
import type { Meta } from "@/api/types";
export type Context = {
  meta: Meta;
  params: URLSearchParams;
  setFilter: (key: string, value: string) => void;
  setFilters: (changes: Record<string, string>) => void;
  query: string;
  go: (path: string, filters?: Record<string, string>) => void;
  openDetail: (row: any, kind?: string) => void;
  openTargets: () => void;
};
export const WorkspaceContext = createContext<Context>(null!);
export const useWorkspace = () => useContext(WorkspaceContext);
export const defaultStart = "2026-08-30";
export const defaultEnd = "2026-09-28";
