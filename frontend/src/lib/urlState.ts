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

import { useCallback, useEffect, useRef, useState } from 'react';
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

/** The raw query value for `key`, but answering a set() IMMEDIATELY.
 *  The URL itself is committed a microtask later (see stage), so a controlled <input> bound to the
 *  URL value would snap back to the old text at the end of the keystroke and then jump to the new
 *  one — the cursor leapt to the end on every key, and IME composition broke. So a set() also
 *  records the new raw value as an override, shown until the URL moves (our own commit landing, or
 *  Back/Forward/navigation), after which the URL is the truth again. */
function useMirroredRaw(key: string): [string | null, (raw: string | null) => void, ReturnType<typeof useSearchParams>[1]] {
  const [params, setParams] = useSearchParams();
  const urlRaw = params.get(key);
  const urlRef = useRef(urlRaw);
  urlRef.current = urlRaw;
  const [ov, setOv] = useState<{ raw: string | null; base: string | null } | null>(null);
  useEffect(() => { if (ov && ov.base !== urlRaw) setOv(null); }, [urlRaw, ov]);
  const raw = ov && ov.base === urlRaw ? ov.raw : urlRaw;
  const remember = useCallback((next: string | null) => setOv({ raw: next, base: urlRef.current }), []);
  return [raw, remember, setParams];
}

type Setter<T> = (v: T | ((prev: T) => T)) => void;

/** Like useState, but stored in the URL query under `key`. The type follows the
 *  default (string / number / boolean); pass a union explicitly to narrow a string:
 *  useUrlState<'day' | 'week'>('group', 'day'). */
export function useUrlState(key: string, def: boolean): [boolean, Setter<boolean>];
export function useUrlState(key: string, def: number): [number, Setter<number>];
export function useUrlState<T extends string = string>(key: string, def: NoInfer<T>): [T, Setter<T>];
export function useUrlState<T extends Prim>(key: string, def: T): [T, Setter<T>] {
  const [raw, remember, setParams] = useMirroredRaw(key);
  const value = decode(raw, def);
  const defRef = useRef(def);
  defRef.current = def;
  const set = useCallback((v: T | ((prev: T) => T)) => {
    let nextRaw: string | null = null;
    stage((p) => {
      const cur = decode(p.get(key), defRef.current);
      const next = typeof v === 'function' ? (v as (prev: T) => T)(cur) : v;
      if (next === defRef.current) p.delete(key); else p.set(key, nextRaw = encode(next));
    }, setParams);
    remember(nextRaw);
  }, [key, setParams, remember]);
  return [value, set];
}

/** useUrlState for objects/arrays (stored as JSON). */
export function useUrlJson<T>(key: string, def: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [raw, remember, setParams] = useMirroredRaw(key);
  const parse = (r: string | null, fallback: T): T => {
    if (r === null) return fallback;
    try { return JSON.parse(r) as T; } catch { return fallback; }
  };
  // Keep the parsed object stable while the URL text is unchanged (safe in deps arrays).
  const memo = useRef<{ raw: string | null; value: T }>({ raw: undefined as unknown as null, value: def });
  if (memo.current.raw !== raw) memo.current = { raw, value: parse(raw, def) };
  const defJson = JSON.stringify(def);
  const set = useCallback((v: T | ((prev: T) => T)) => {
    let nextRaw: string | null = null;
    stage((p) => {
      const cur = parse(p.get(key), JSON.parse(defJson));
      const next = typeof v === 'function' ? (v as (prev: T) => T)(cur) : v;
      const json = JSON.stringify(next);
      if (json === defJson) p.delete(key); else p.set(key, nextRaw = json);
    }, setParams);
    remember(nextRaw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, defJson, setParams, remember]);
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
