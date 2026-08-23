import { VERSION } from "../config/index.ts";
import { bold, cyan, dim, gradientLines, rule, sleep } from "./ansi.ts";
import { mascotLines } from "./mascot.ts";

const ART = [
  " █████╗ ██╗   ██╗███████╗██████╗ ██╗   ██╗",
  "██╔══██╗██║   ██║██╔════╝██╔══██╗╚██╗ ██╔╝",
  "███████║██║   ██║█████╗  ██████╔╝ ╚████╔╝ ",
  "██╔══██║╚██╗ ██╔╝██╔══╝  ██╔══██╗  ╚██╔╝  ",
  "██║  ██║ ╚████╔╝ ███████╗██║  ██║   ██║   ",
  "╚═╝  ╚═╝  ╚═══╝  ╚══════╝╚═╝  ╚═╝   ╚═╝   ",
];

const GRADIENT_FROM: [number, number, number] = [39, 131, 222]; // #2783DE
const GRADIENT_TO: [number, number, number] = [191, 142, 218]; // #BF8EDA

export interface BannerInfo {
  provider: string;
  model: string;
  cwd: string;
}

/** Animated gradient banner with a line-by-line reveal, mascot Avi aside. */
export async function printBanner(info: BannerInfo): Promise<void> {
  const wide = (process.stdout.columns ?? 80) >= 50;
  process.stdout.write("\n");
  if (wide && process.stdout.isTTY) {
    const colored = gradientLines(ART, GRADIENT_FROM, GRADIENT_TO);
    for (const line of colored) {
      process.stdout.write("  " + line + "\n");
      await sleep(26);
    }
  } else {
    process.stdout.write("  " + cyan(bold("⚡ AVERY")) + "\n");
  }
  // Маскот Avi рядом с метаданными сессии
  const meta = [
    bold(`Avery ${VERSION}`) + dim(" — AI coding agent в терминале"),
    dim(`провайдер: ${info.provider} · модель: ${info.model || "— (выбери через /model)"}`),
    dim(`каталог: ${info.cwd}`),
    dim("/help — команды · /model — модели (↑↓) · Shift+Tab — режимы"),
  ];
  const bird = mascotLines("idle");
  const lines = bird.map(
    (l, i) => "  " + cyan(l) + (meta[i] !== undefined ? "  " + meta[i]! : ""),
  );
  process.stdout.write("\n" + lines.join("\n") + "\n" + rule() + "\n\n");
}
