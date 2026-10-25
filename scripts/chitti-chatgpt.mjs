#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { loadStore, saveStore } from "./chitti/oauth.mjs";
import { createCompanion, PORT } from "./chitti/server.mjs";

const directory =
  process.env.CHITTI_CONFIG_DIR || join(homedir(), ".config", "chitti");
// Bind before reading credentials: a second process must not race rotating tokens.
let store;
const { createServer } = await import("node:http");
let handler,
  saving = Promise.resolve();
const listener = createServer((req, res) => {
  if (handler) handler.emit("request", req, res);
  else {
    res.writeHead(503);
    res.end("Starting Chitti");
  }
});
listener.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? `Chitti’s companion is already using port ${PORT}.`
      : "Unable to start Chitti’s companion.",
  );
  process.exitCode = 1;
});
listener.listen(PORT, "127.0.0.1", async () => {
  try {
    store = await loadStore(directory);
    await saveStore(directory, store);
    handler = createCompanion({
      store,
      persist: () => {
        const snapshot = structuredClone(store);
        saving = saving
          .catch(() => {})
          .then(() => saveStore(directory, snapshot));
        return saving;
      },
    });
    console.log(
      `Chitti companion ready on 127.0.0.1:${PORT}.\nOpen Chitti → Settings → ChatGPT subscription → Continue with ChatGPT.\nCredentials stay in ${directory} (owner-only). Keep this terminal running.`,
    );
  } catch {
    console.error("Unable to read or save Chitti’s protected account store.");
    listener.close();
    process.exitCode = 1;
  }
});
