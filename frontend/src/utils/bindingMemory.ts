import { versionScopedKey } from '@/config'

/**
 * Device-local (localStorage) memory of L1↔L2 bindings the SERVER has CONFIRMED.
 *
 * CRITICAL — confirmed pairs ONLY. A prior localStorage cache stored unconfirmed
 * guesses (a user's *selection*, or a pair we hadn't yet checked) and could then
 * CONTRADICT the server-side 1:1 binding table, producing a stuck loop. That bug
 * was removed. This store re-introduces persistence but writes ONLY from an
 * authoritative getAttestationStatus() disclosure — the same 'bound'/'conflict'
 * responses that feed the in-memory session store (see useBindingStatus). Never
 * call rememberConfirmedBinding() on a selection, a guess, or an unconfirmed
 * state, and never store anything but the confirmed L1↔L2 pair (no secrets).
 *
 * Live server truth always wins: rememberConfirmedBinding() overwrites on every
 * fresh disclosure and prunes any stale counterpart, so a server-side rebinding
 * heals the persisted value the moment the new status is known. The persisted
 * value is only a fallback marker for a fresh reload before the live query has
 * resolved; once it resolves, the live/session value takes precedence.
 */

const STORAGE_KEY = versionScopedKey('shield-human-tech-binding-memory-v1')

/** lowercased EVM (L1) address → lowercased Aztec (L2) address, a confirmed 1:1 pair. */
type PairMap = Record<string, string>

function isBrowser(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

/** Defensive read — any malformed/tampered payload degrades to an empty map, never throws. */
function readAll(): PairMap {
  if (!isBrowser()) return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: PairMap = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string' && k && v) {
        out[k.toLowerCase()] = v.toLowerCase()
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeAll(map: PairMap): void {
  if (!isBrowser()) return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // storage disabled / quota exceeded — persistence is best-effort, the
    // in-memory session store still carries the pair for this session.
  }
}

/**
 * Persist a SERVER-CONFIRMED L1↔L2 pair. Call this ONLY where the server has
 * disclosed the pair (a 'bound'/'conflict' getAttestationStatus response — i.e.
 * exactly where useLinkedPairStore.recordPair is called). Enforces the server's
 * 1:1 invariant: binding this L2 to a new L1 (or re-binding an L1) drops any
 * other entry that claimed either side, so the persisted map can never
 * contradict the latest server truth. No-op on a missing side.
 */
export function rememberConfirmedBinding(l1?: string | null, l2?: string | null): void {
  if (!l1 || !l2) return
  const kl1 = l1.toLowerCase()
  const kl2 = l2.toLowerCase()
  const map = readAll()
  if (map[kl1] === kl2) return
  // 1:1 both ways — drop any stale entry sharing either address (server rebinding).
  for (const key of Object.keys(map)) {
    if (key === kl1 || map[key] === kl2) delete map[key]
  }
  map[kl1] = kl2
  writeAll(map)
}

/** The confirmed L2 (Aztec) account for an L1 (EVM) wallet, or null. Lowercased. */
export function getKnownL2ForL1(l1?: string | null): string | null {
  if (!l1) return null
  return readAll()[l1.toLowerCase()] ?? null
}

/** The confirmed L1 (EVM) wallet for an L2 (Aztec) account, or null. Lowercased. */
export function getKnownL1ForL2(l2?: string | null): string | null {
  if (!l2) return null
  const target = l2.toLowerCase()
  for (const [k, v] of Object.entries(readAll())) {
    if (v === target) return k
  }
  return null
}
