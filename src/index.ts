// Entry point. The HTTP server is wired up in #15; until then this only
// confirms the build and runtime work.
export const SERVICE_NAME = "jarvis";

const isMain = import.meta.url === `file://${process.argv[1] ?? ""}`;

if (isMain) {
  console.log(`${SERVICE_NAME}: scaffold OK (server not implemented yet, see #15)`);
}
