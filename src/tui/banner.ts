import { VERSION } from "../config/index.ts";
import { bold, cyan, dim, gradientLines, rule, sleep } from "./ansi.ts";

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

/** Animated gradient banner with a line-by-line reveal. */
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
  process.stdout.write(
    [
      "",
      "  " + bold(`Avery ${VERSION}`) + dim(" — AI coding agent в терминале"),
      "  " +
        dim(`провайдер: ${info.provider} · модель: ${info.model || "— (выбери через /model)"}`),
      "  " + dim(`каталог: ${info.cwd}`),
      "  " +
        dim("/help — команды · /model — модели (↑↓) · /provider — сменить провайдера"),
      rule(),
      "",
    ].join("\n") + "\n",
  );
}
