"use client";
import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { motionSpring, transitionFor, type MotionCategory } from "../lib/motion";
import { Button } from "./primitives";
export function MotionSample() {
  const [moved, setMoved] = useState(false);
  const reduced = useReducedMotion();
  return <div><Button onClick={() => setMoved(!moved)}>Preview motion</Button><p className="muted">User-triggered demonstration. Reduced motion removes movement.</p><div className="motion-samples">{(Object.keys(motionSpring) as MotionCategory[]).map(category => <div key={category}><span className="mono">{category}</span><div className="motion-track"><motion.span data-motion={category} className="motion-block" initial={false} animate={{ x: reduced ? 0 : moved ? 48 : 0 }} transition={transitionFor(category, Boolean(reduced))} /></div></div>)}</div></div>;
}
