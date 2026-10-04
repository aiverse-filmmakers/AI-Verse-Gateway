import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { GatewayStore } from "../src/store.mjs";
import { sha256 } from "../src/util.mjs";

const samples = Number(process.env.IDEMPOTENCY_SAMPLES ?? 25);

async function measure(recordCount) {
  const home = await mkdtemp(path.join(os.tmpdir(), `gateway-idem-${recordCount}-`));
  try {
    const store = new GatewayStore(home);
    await store.init();
    for (let i = 0; i < recordCount; i += 1) {
      const mapKey = `seed:${i}`;
      const file = store.idempotency.recordFile(mapKey);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({
        schema_version: "1.0",
        map_key: mapKey,
        record: { digest: sha256(mapKey), result: { run_id: `run-${i}` }, created_at: new Date(0).toISOString() }
      }), { flag: "wx", mode: 0o600 });
    }
    const timings = [];
    for (let i = 0; i < samples; i += 1) {
      const key = `measured:${recordCount}:${i}`;
      const started = performance.now();
      const claim = await store.claimIdempotency("benchmark", key, { payload: key });
      await store.commitIdempotency(claim.mapKey, { run_id: `run-${i}` });
      timings.push(performance.now() - started);
    }
    timings.sort((a, b) => a - b);
    return timings[Math.floor(timings.length / 2)];
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const smallMs = await measure(1_000);
const largeMs = await measure(100_000);
const ratio = largeMs / Math.max(smallMs, 0.1);
console.log(JSON.stringify({ records: [1_000, 100_000], samples, median_claim_commit_ms: [smallMs, largeMs], scale_ratio: ratio }, null, 2));
assert.ok(ratio < 8, `100k idempotency history scaled claim/commit by ${ratio.toFixed(2)}x (limit 8x)`);
