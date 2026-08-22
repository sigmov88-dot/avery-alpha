import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sessionsDir } from "../config/index.ts";
import type { ChatMessage } from "../provider/types.ts";

export interface Session {
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** Провайдер сессии: "zen" | "ollama" */
  provider?: string;
  title?: string;
  messages: ChatMessage[];
}

export function createSession(
  cwd: string,
  model: string,
  provider?: string,
): Session {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    cwd,
    model,
    createdAt: now,
    updatedAt: now,
    provider,
    messages: [],
  };
}

/** Derive a short title from the first user message. */
export function deriveTitle(session: Session): void {
  if (session.title) return;
  const first = session.messages.find(
    (m) => m.role === "user" && typeof m.content === "string",
  );
  if (first && typeof first.content === "string") {
    session.title = first.content.replace(/\s+/g, " ").trim().slice(0, 60);
  }
}

export function saveSession(s: Session): void {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  deriveTitle(s);
  s.updatedAt = new Date().toISOString();
  // Session history may contain sensitive code — keep it user-private.
  fs.writeFileSync(sessionPath(s.id), JSON.stringify(s, null, 2), {
    mode: 0o600,
  });
}

export function sessionPath(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

export function loadSession(id: string): Session | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionPath(id), "utf8")) as Session;
    if (parsed && typeof parsed.id === "string" && Array.isArray(parsed.messages)) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** List sessions, newest first. Filter by cwd when provided. */
export function listSessions(cwd?: string): Session[] {
  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const sessions: Session[] = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(sessionsDir(), f), "utf8"),
      ) as Session;
      if (parsed && typeof parsed.id === "string") sessions.push(parsed);
    } catch {
      // skip corrupted session files
    }
  }
  const filtered = cwd
    ? sessions.filter((s) => normalizeCwd(s.cwd) === normalizeCwd(cwd))
    : sessions;
  return filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** "/proj" и "/proj/" — один и тот же проект. */
function normalizeCwd(p: string): string {
  return p.replace(/[/\\]+$/, "");
}

export function latestSession(cwd: string): Session | undefined {
  return listSessions(cwd)[0];
}
