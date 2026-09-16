import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installComponent, uninstallComponent } from "../src/lifecycle.mjs";

async function temp(prefix) {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

test("install refuses to claim an unrelated non-empty directory", async () => {
  const home = await temp("aiverse-gateway-unrelated-");
  const sentinel = path.join(home, "keep.txt");
  await writeFile(sentinel, "keep", "utf8");
  try {
    await rejectsCode(installComponent({ home }), "GATEWAY_HOME_NOT_EMPTY");
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("purge fails closed without persistent ownership evidence", async () => {
  const home = await temp("aiverse-gateway-no-owner-");
  const sentinel = path.join(home, "keep.txt");
  await writeFile(sentinel, "keep", "utf8");
  try {
    await rejectsCode(uninstallComponent({ home, purge: true }), "GATEWAY_HOME_NOT_OWNED");
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("purge rejects a foreign or malformed ownership marker", async () => {
  const home = await temp("aiverse-gateway-wrong-owner-");
  const sentinel = path.join(home, "keep.txt");
  await writeFile(path.join(home, "ownership.json"), JSON.stringify({ schema_version:"1.0", component_id:"another-component", root_realpath:home }), "utf8");
  await writeFile(sentinel, "keep", "utf8");
  try {
    await rejectsCode(uninstallComponent({ home, purge: true }), "GATEWAY_OWNERSHIP_INVALID");
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("copied ownership evidence cannot authorize a different root", async () => {
  const source = await temp("aiverse-gateway-owner-source-");
  const target = await temp("aiverse-gateway-owner-target-");
  const sentinel = path.join(target, "keep.txt");
  try {
    await installComponent({ home: source });
    await copyFile(path.join(source, "ownership.json"), path.join(target, "ownership.json"));
    await writeFile(sentinel, "keep", "utf8");
    await rejectsCode(uninstallComponent({ home: target, purge: true }), "GATEWAY_OWNERSHIP_INVALID");
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("purge refuses filesystem root and user home before touching contents", async () => {
  await rejectsCode(uninstallComponent({ home: path.parse(process.cwd()).root, purge: true }), "GATEWAY_HOME_UNSAFE");
  await rejectsCode(uninstallComponent({ home: os.homedir(), purge: true }), "GATEWAY_HOME_UNSAFE");
});

test("purge rejects an exact home symlink or junction", async () => {
  const target = await temp("aiverse-gateway-link-target-");
  const parent = await temp("aiverse-gateway-link-parent-");
  const link = path.join(parent, "gateway-link");
  try {
    await installComponent({ home: target });
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    await rejectsCode(uninstallComponent({ home: link, purge: true }), "GATEWAY_HOME_UNSAFE");
    assert.equal((await lstat(path.join(target, "ownership.json"))).isFile(), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("safe custom home purge removes only Gateway-owned entries and preserves unknown files", async () => {
  const home = await temp("aiverse-gateway-bounded-purge-");
  const sentinel = path.join(home, "keep.txt");
  try {
    await installComponent({ home });
    await writeFile(path.join(home, "state", "owned.txt"), "owned", "utf8");
    await writeFile(sentinel, "keep", "utf8");
    const result = await uninstallComponent({ home, purge: true });
    assert.equal(result.purged, true);
    assert.equal(result.home_removed, false);
    assert.equal(result.unowned_entries_preserved, true);
    assert.equal(await readFile(sentinel, "utf8"), "keep");
    await assert.rejects(lstat(path.join(home, "state")), { code:"ENOENT" });
    await assert.rejects(lstat(path.join(home, "ownership.json")), { code:"ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("normal uninstall preserves ownership and state so reinstall is safe", async () => {
  const home = await temp("aiverse-gateway-reinstall-");
  try {
    await installComponent({ home });
    await writeFile(path.join(home, "state", "preserved.txt"), "state", "utf8");
    const uninstalled = await uninstallComponent({ home });
    assert.equal(uninstalled.canonical_state_preserved, true);
    assert.equal((await lstat(path.join(home, "ownership.json"))).isFile(), true);
    assert.equal(await readFile(path.join(home, "state", "preserved.txt"), "utf8"), "state");
    const reinstalled = await installComponent({ home });
    assert.equal(reinstalled.state, "installed");
    assert.equal(await readFile(path.join(home, "state", "preserved.txt"), "utf8"), "state");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
