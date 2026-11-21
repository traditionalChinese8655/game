/**
 * Home.tsx — the page that hosts the game canvas.
 * React only owns the shell; all game UI (HUD, title, console) is built by src/game/boot.ts.
 */

import { useEffect, useRef } from 'react'
import { startGame, stopGame } from '@/game/boot'

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    startGame(canvas)
    return () => stopGame()
  }, [])

  return (
    <div id="game-root">
      <canvas id="game-canvas" ref={canvasRef} />
      <div id="ui-overlay" />
    </div>
  )
}
