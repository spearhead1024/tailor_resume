// View state that lives in the URL query (?region=EU&page=2), so a refresh, Back /
// Forward and a copied link all reopen the same view. Use it for what the page is
// SHOWING (sub-tab, filters, search, page, selection); keep personal defaults that
// aren't part of a view (e.g. "last region I added a job for") in localStorage.
//
// Values equal to the default are left out of the URL, so untouched pages keep a
// clean address. Updates replace the history entry (no Back-button spam) and are
// batched: react-router's own setSearchParams drops all but the last of several
// calls made in one event (e.g. "set region" + "back to page 1"), so every setter
// here writes into one shared pending query that is committed once per tick.

import { useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

type Prim = string | number | boolean;
type SetUrlParams = ReturnType<typeof useSearchParams>[1];

let pending: URLSearchParams | null = null;
let commit: SetUrlParams | null = null;

function stage(apply: (p: URLSearchParams) => void, setParams: SetUrlParams) {
  if (!pending) {
    pending = new URLSearchParams(window.location.search);
    queueMicrotask(() => {
      const next = pending!;
      pending = null;
      commit?.(next, { replace: true });
    });
  }
  commit = setParams;
  apply(pending);
}

function decode<T extends Prim>(raw: string | null, def: T): T {
  if (raw === null) return def;
  if (typeof def === 'number') { const n = Number(raw); return (Number.isFinite(n) ? n : def) as T; }
  if (typeof def === 'boolean') return (raw === '1' || raw === 'true') as T;
  return raw as T;
}
const encode = (v: Prim) => (typeof v === 'boolean' ? (v ? '1' : '0') : String(v));

type Setter<T> = (v: T | ((prev: T) => T)) => void;

/** Like useState, but stored in the URL query under `key`. The type follows the
 *  default (string / number / boolean); pass a union explicitly to narrow a string:
 *  useUrlState<'day' | 'week'>('group', 'day'). */
export function useUrlState(key: string, def: boolean): [boolean, Setter<boolean>];
export function useUrlState(key: string, def: number): [number, Setter<number>];
export function useUrlState<T extends string = string>(key: string, def: NoInfer<T>): [T, Setter<T>];
export function useUrlState<T extends Prim>(key: string, def: T): [T, Setter<T>] {
  const [params, setParams] = useSearchParams();
  const value = decode(params.get(key), def);
  const defRef = useRef(def);
  defRef.current = def;
  const set = useCallback((v: T | ((prev: T) => T)) => {
    stage((p) => {
      const cur = decode(p.get(key), defRef.current);
      const next = typeof v === 'function' ? (v as (prev: T) => T)(cur) : v;
      if (next === defRef.current) p.delete(key); else p.set(key, encode(next));
    }, setParams);
  }, [key, setParams]);
  return [value, set];
}

/** useUrlState for objects/arrays (stored as JSON). */
export function useUrlJson<T>(key: string, def: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [params, setParams] = useSearchParams();
  const parse = (raw: string | null, fallback: T): T => {
    if (raw === null) return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  };
  const raw = params.get(key);
  // Keep the parsed object stable while the URL text is unchanged (safe in deps arrays).
  const memo = useRef<{ raw: string | null; value: T }>({ raw: undefined as unknown as null, value: def });
  if (memo.current.raw !== raw) memo.current = { raw, value: parse(raw, def) };
  const defJson = JSON.stringify(def);
  const set = useCallback((v: T | ((prev: T) => T)) => {
    stage((p) => {
      const cur = parse(p.get(key), JSON.parse(defJson));
      const next = typeof v === 'function' ? (v as (prev: T) => T)(cur) : v;
      const json = JSON.stringify(next);
      if (json === defJson) p.delete(key); else p.set(key, json);
    }, setParams);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, defJson, setParams]);
  return [memo.current.value, set];
}

/** Run fn when any of `deps` changes — never on mount. For "back to page 1 when a
 *  filter changes": a plain effect also fires on load and would wipe the page number
 *  just restored from the URL. Compares values, so it is StrictMode-safe. */
export function useOnChange(deps: unknown[], fn: () => void) {
  const key = JSON.stringify(deps);
  const prev = useRef(key);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (prev.current !== key) { prev.current = key; fnRef.current(); }
  }, [key]);
}
