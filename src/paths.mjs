import os from "node:os";
import path from "node:path";

export function gatewayHome(explicit) {
  return path.resolve(explicit || process.env.AIVERSE_GATEWAY_HOME || path.join(os.homedir(), ".aiverse", "gateway"));
}
export function paths(home) {
  return {
    home,
    owner: path.join(home, "ownership.json"),
    install: path.join(home, "install.json"),
    config: path.join(home, "config.json"),
    host: path.join(home, "host.json"),
    goalOwner: path.join(home, "goal-owner.json"),
    state: path.join(home, "state"),
    sessions: path.join(home, "state", "sessions"),
    runs: path.join(home, "state", "runs"),
    events: path.join(home, "state", "events"),
    folds: path.join(home, "state", "folds"),
    foldCards: path.join(home, "state", "folds", "cards"),
    foldCatalog: path.join(home, "state", "folds", "catalog.json"),
    idempotency: path.join(home, "state", "idempotency.json"),
    audit: path.join(home, "state", "audit.ndjson")
  };
}
