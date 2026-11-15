import { randomUUID, createHash } from "node:crypto";

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export const nowIso = (): string => new Date().toISOString();
