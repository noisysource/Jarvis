// The personal profile: a markdown file of facts about you that the
// `personal` answerer puts in its system prompt. It's personal data, so its
// text never goes into logs or error messages.
//
// Loading sits behind `ProfileSource` so the cloud can later read it from
// Secret Manager or a private bucket instead of a file.

import { promises as fs } from "node:fs";
import type { ProfileSourceRef } from "./config.js";
import { err, ok, type Result } from "./result.js";

export type Profile = {
  readonly text: string;
  readonly loadedAt: Date;
};

export type ProfileError = {
  readonly code: "missing" | "too_large" | "empty" | "unreadable";
  /** Safe to log: names the path, never the content. */
  readonly message: string;
};

export type ProfileSource = () => Promise<Result<Profile, ProfileError>>;

export type ProfileFileSystem = {
  readonly stat: (path: string) => Promise<{ readonly mtimeMs: number; readonly size: number }>;
  readonly readFile: (path: string) => Promise<string>;
};

/** Bounds the prompt size. */
export const MAX_PROFILE_BYTES = 50_000;

export const EXAMPLE_PROFILE_PATH = "data/profile.example.md";

export const nodeProfileFileSystem: ProfileFileSystem = {
  stat: (path) => fs.stat(path),
  readFile: (path) => fs.readFile(path, "utf8"),
};

const isNotFound = (e: unknown): boolean =>
  typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "ENOENT";

const errorCode = (e: unknown): string =>
  typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "error";

/**
 * Reads the profile file, and re-reads it only when its modification time or
 * size changes, so edits apply without restarting.
 */
export const makeFileProfileSource = (deps: {
  readonly path: string;
  readonly fs?: ProfileFileSystem;
  readonly now?: () => Date;
  readonly maxBytes?: number;
}): ProfileSource => {
  const files = deps.fs ?? nodeProfileFileSystem;
  const now = deps.now ?? (() => new Date());
  const maxBytes = deps.maxBytes ?? MAX_PROFILE_BYTES;
  let cached: { mtimeMs: number; size: number; profile: Profile } | undefined;

  return async () => {
    let stats: { mtimeMs: number; size: number };
    try {
      stats = await files.stat(deps.path);
    } catch (e) {
      cached = undefined;
      return err(
        isNotFound(e)
          ? {
              code: "missing",
              message: `No profile at ${deps.path}. Copy ${EXAMPLE_PROFILE_PATH} to ${deps.path} and fill it in.`,
            }
          : { code: "unreadable", message: `Couldn't read the profile at ${deps.path} (${errorCode(e)})` },
      );
    }

    if (stats.size > maxBytes) {
      return err({
        code: "too_large",
        message: `The profile at ${deps.path} is ${stats.size} bytes; the limit is ${maxBytes}`,
      });
    }

    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return ok(cached.profile);
    }

    let raw: string;
    try {
      raw = await files.readFile(deps.path);
    } catch (e) {
      cached = undefined;
      return err({ code: "unreadable", message: `Couldn't read the profile at ${deps.path} (${errorCode(e)})` });
    }

    const text = raw.replace(/^\uFEFF/, "").trim();
    if (text === "") {
      cached = undefined;
      return err({ code: "empty", message: `The profile at ${deps.path} is empty` });
    }

    const profile: Profile = { text, loadedAt: now() };
    cached = { mtimeMs: stats.mtimeMs, size: stats.size, profile };
    return ok(profile);
  };
};

/** Builds the source named in config (`PROFILE_SOURCE`). Only files exist for now. */
export const makeProfileSource = (
  ref: ProfileSourceRef,
  deps: { readonly fs?: ProfileFileSystem; readonly now?: () => Date } = {},
): ProfileSource => {
  switch (ref.kind) {
    case "file":
      return makeFileProfileSource({ path: ref.path, ...deps });
  }
};
