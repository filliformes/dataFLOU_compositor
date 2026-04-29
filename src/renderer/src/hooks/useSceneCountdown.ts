// Shared countdown hook for scene-duration display.
//
// Any component that wants to show "N.Ns left" / a progress bar for the
// currently-playing scene can call this. Returns zero / null when the
// scene isn't active, and self-ticks a local 20 Hz interval ONLY while
// it IS active — so a palette of 100 scene pills spawns one interval per
// re-render of the active pill, not per pill.

import { useEffect, useState } from 'react'
import { useStore } from '../store'

export interface SceneCountdown {
  /** True when this scene is currently the engine's active scene. */
  active: boolean
  /** Elapsed ms since the scene started. 0 when inactive. */
  elapsedMs: number
  /** Remaining ms until the scene's duration ends. 0 when inactive or past-due. */
  remainingMs: number
  /** Progress in [0, 1]. 0 when inactive, 1 when past-due. */
  progress: number
}

export function useSceneCountdown(sceneId: string, durationSec: number): SceneCountdown {
  const activeSceneId = useStore((s) => s.engine.activeSceneId)
  const startedAt = useStore((s) => s.engine.activeSceneStartedAt)
  // Engine reports the wall-clock at which pause was entered, or null
  // when running. Using it as the "now" reference while paused makes
  // the visual countdown freeze at the moment of pause without the
  // hook's interval having to know about pause itself.
  const pausedAt = useStore((s) => s.engine.pausedAt)
  const active = activeSceneId === sceneId && startedAt !== null

  // Self-ticking local "now" — only runs while active AND not
  // paused. While paused we don't need to re-render; the pausedAt
  // freeze handles the math.
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!active || pausedAt !== null) return
    const id = setInterval(() => setNow(Date.now()), 50)
    return () => clearInterval(id)
  }, [active, pausedAt])

  const refNow = pausedAt !== null ? pausedAt : now
  const durationMs = Math.max(1, durationSec * 1000)
  const elapsedMs = active && startedAt !== null ? Math.max(0, refNow - startedAt) : 0
  const remainingMs = active ? Math.max(0, durationMs - elapsedMs) : 0
  const progress = active ? Math.min(1, elapsedMs / durationMs) : 0

  return { active, elapsedMs, remainingMs, progress }
}

/** Format a duration in ms as a live-show-friendly "Xs" or "X.Xs" string. */
export function formatRemaining(ms: number): string {
  if (ms >= 10_000) return `${Math.ceil(ms / 1000)}s`
  return `${(ms / 1000).toFixed(1)}s`
}
