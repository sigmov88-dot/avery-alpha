/**
 * Avi — маскот Avery (Avery ≈ aviary, «птичник»): маленькая птичка с клювом.
 * Показывается в баннере и анимирует «думает…». Свой, не из Claude Code.
 */
export const MASCOT_NAME = "Avi";

export type MascotMood = "idle" | "blink" | "happy" | "think" | "work" | "error";

/** Личико Avi для настроения. */
export function mascotFace(mood: MascotMood = "idle"): string {
  switch (mood) {
    case "blink":
      return "(-v-)";
    case "happy":
      return "(^v^)";
    case "error":
      return "(×v×)";
    case "think":
      return "( 'v')~";
    case "work":
      return "('v')⚡";
    default:
      return "('v')";
  }
}

/** Многострочный Avi для баннера. */
export function mascotLines(mood: MascotMood = "idle"): string[] {
  return [
    "   ___",
    "  " + mascotFace(mood),
    " ((   ))",
    '  "~""~"',
  ];
}

/** Кадры анимации «думает…»: в основном спокойный, иногда моргает и косится. */
export const THINK_FRAMES = [
  "('v')",
  "('v')",
  "('v')",
  "( 'v')",
  "('v')",
  "('v' )",
  "( 'v')",
  "(-v-)",
  "('v')",
];
