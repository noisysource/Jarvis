// Fixes as pull requests (#162), for the page: pure. fix.js draws it.

/** @typedef {{ kind: "file" | "hunk" | "add" | "del" | "ctx", text: string }} DiffLine */

/**
 * A unified diff as lines to colour. Text only: it's set as text, never HTML.
 * @param {string} diff @returns {DiffLine[]}
 */
export const diffLines = (diff) =>
  diff
    .split("\n")
    .filter((l, i, all) => !(i === all.length - 1 && l === ""))
    .map((text) => {
      if (text.startsWith("diff --git") || text.startsWith("+++ ") || text.startsWith("--- ") || text.startsWith("index ") || text.startsWith("new file") || text.startsWith("deleted file"))
        return { kind: "file", text };
      if (text.startsWith("@@")) return { kind: "hunk", text };
      if (text.startsWith("+")) return { kind: "add", text };
      if (text.startsWith("-")) return { kind: "del", text };
      return { kind: "ctx", text };
    });

/**
 * What the card says while the fix is being prepared, or when it ended without a diff.
 * @param {{ status: string, step?: string, summary?: string, message?: string }} view
 * @returns {{ done: boolean, ok: boolean, text: string }}
 */
export const fixStatusText = (view) => {
  switch (view.status) {
    case "working":
      return { done: false, ok: true, text: `Preparing the fix…${view.step ? ` ${view.step}` : ""}` };
    case "failed":
      return { done: true, ok: false, text: `The fix couldn't be prepared: ${view.message ?? "something went wrong"}. Nothing was pushed.` };
    case "nothing":
      return { done: true, ok: true, text: `The code agent didn't change anything${view.summary ? `: ${view.summary}` : "."}` };
    case "ready":
      return { done: true, ok: true, text: "Here's the change. Nothing has left your Mac yet." };
    default:
      return { done: true, ok: false, text: "That fix isn't waiting any more." };
  }
};
