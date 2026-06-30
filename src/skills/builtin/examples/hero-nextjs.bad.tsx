/** ❌ BAD: 6 Fatal violations in a single Hero component.
 *
 *  Fatal violations:
 *    1. useEffect instead of useGSAP — no cleanup, re-runs on every render
 *    2. Bare z-index: 999 — should be --z-raised
 *    3. transition: all — performance killer
 *    4. ease: "linear" — mechanical, no physics
 *    5. Two from() on same element without immediateRender: false — second one skipped
 *    6. No prefers-reduced-motion handling
 *  Warning: AI 紫粉渐变 (#8B5CF6 → #EC4899)
 */

import { useEffect } from "react"
import gsap from "gsap"

export default function Hero() {
  useEffect(() => {
    gsap.from(".hero-title", { y: 80, opacity: 0, duration: 0.9, ease: "linear" })
    gsap.from(".hero-title", { x: -20, duration: 0.5 }) // BUG: skipped! second from() on same prop needs immediateRender: false
    gsap.from(".hero-sub", { y: 40, opacity: 0, duration: 0.6, transition: "all 0.6s" })

    document.querySelector(".hero")!.style.zIndex = "999"
  }, [])

  return (
    <section className="hero" style={{ background: "linear-gradient(135deg, #8B5CF6, #EC4899)" }}>
      <h1 className="hero-title">Build AI Agents</h1>
      <p className="hero-sub">The best platform.</p>
      <button className="hero-cta">Get Started</button>
    </section>
  )
}
