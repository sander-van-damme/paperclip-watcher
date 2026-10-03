type Level = "info" | "warn" | "error";

export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
