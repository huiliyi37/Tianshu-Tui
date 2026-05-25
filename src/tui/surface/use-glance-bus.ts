import { useState, useEffect, useRef } from 'react'
import { createGlanceBus, type GlanceBus } from './glance-bus.js'
import type { GlancePulse } from './types.js'

export function useGlanceBus(): { bus: GlanceBus; pulses: readonly GlancePulse[] } {
  const busRef = useRef(createGlanceBus())
  const [pulses, setPulses] = useState(busRef.current.snapshot())
  useEffect(() => busRef.current.subscribe(() => setPulses(busRef.current.snapshot())), [])
  return { bus: busRef.current, pulses }
}
