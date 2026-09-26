export const motionSpring = {
  press: { type: "spring", stiffness: 700, damping: 45, mass: 0.35 },
  control: { type: "spring", stiffness: 500, damping: 40, mass: 0.50 },
  panel: { type: "spring", stiffness: 380, damping: 36, mass: 0.75 },
  layout: { type: "spring", stiffness: 320, damping: 32, mass: 0.85 },
} as const;
export type MotionCategory = keyof typeof motionSpring;
export function transitionFor(category: MotionCategory, reduced: boolean) {
  return reduced ? { duration: 0 } : motionSpring[category];
}
