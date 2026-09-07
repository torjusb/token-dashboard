import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type AgentScope = 'all' | 'main' | 'sub';

export type Filters = {
  from: number | null;
  to: number | null;
  projects: string[];
  models: string[];
  agentScope: AgentScope;
};

export type FiltersApi = {
  filters: Filters;
  setFilters: (next: Filters) => void;
  patch: (part: Partial<Filters>) => void;
  reset: () => void;
  isDefault: boolean;
};

export const DEFAULT_FILTERS: Filters = {
  from: null,
  to: null,
  projects: [],
  models: [],
  agentScope: 'all',
};

const STORAGE_KEY = 'token-dashboard.filters';

function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function sanitize(value: unknown): Filters {
  if (value === null || typeof value !== 'object') return DEFAULT_FILTERS;
  const raw = value as Record<string, unknown>;
  const scope = raw['agentScope'];
  return {
    from: timestamp(raw['from']),
    to: timestamp(raw['to']),
    projects: names(raw['projects']),
    models: names(raw['models']),
    agentScope: scope === 'main' || scope === 'sub' ? scope : 'all',
  };
}

function load(): Filters {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? DEFAULT_FILTERS : sanitize(JSON.parse(stored));
  } catch {
    return DEFAULT_FILTERS;
  }
}

function isDefault(filters: Filters): boolean {
  return (
    filters.from === null &&
    filters.to === null &&
    filters.projects.length === 0 &&
    filters.models.length === 0 &&
    filters.agentScope === 'all'
  );
}

const FiltersContext = createContext<FiltersApi | null>(null);

export function FiltersProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<Filters>(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
    } catch {
      return;
    }
  }, [filters]);

  const api = useMemo<FiltersApi>(
    () => ({
      filters,
      setFilters,
      patch: (part) => setFilters((prev) => ({ ...prev, ...part })),
      reset: () => setFilters(DEFAULT_FILTERS),
      isDefault: isDefault(filters),
    }),
    [filters],
  );

  return <FiltersContext.Provider value={api}>{children}</FiltersContext.Provider>;
}

export function useFilters(): FiltersApi {
  const api = useContext(FiltersContext);
  if (api === null) throw new Error('useFilters must be used inside a FiltersProvider');
  return api;
}
