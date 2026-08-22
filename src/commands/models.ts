import type { Provider } from "../provider/types.ts";
import { ProviderError } from "../provider/types.ts";
import { dim, green, red } from "../tui/ansi.ts";

/** Print the FULL model catalog of the active provider (no truncation). */
export async function listModelsCmd(
  provider: Provider,
  currentModel: string,
  kindLabel: string,
): Promise<number> {
  try {
    const models = await provider.listModels();
    for (const m of models) {
      const mark = m.id === currentModel ? green(" *") : "";
      const ctx =
        m.contextWindow !== undefined
          ? dim(` (${Math.round(m.contextWindow / 1000)}k ctx)`)
          : "";
      process.stdout.write(`${m.id}${ctx}${mark}\n`);
    }
    process.stdout.write(
      dim(
        `\n${models.length} моделей · провайдер: ${kindLabel} · * — текущая (${currentModel || "—"})\n`,
      ),
    );
    return 0;
  } catch (e) {
    const err = e as Error;
    process.stderr.write(red(`ошибка: ${err.message}\n`));
    if (err instanceof ProviderError && err.hint) {
      process.stderr.write(dim(err.hint + "\n"));
    }
    return 1;
  }
}
