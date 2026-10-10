import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
export function exportAuthorized(request: IncomingMessage, password: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Basic ")) return false;
  let decoded: string;
  try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); }
  catch { return false; }
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  const actual = decoded.slice(colon + 1);
  return timingSafeEqual(digest(actual), digest(password));
}
export function challenge(response: ServerResponse): void {
  response.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Paperclip Support Exports", charset="UTF-8"',
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end("Authentication required");
}
