#!/usr/bin/env python3
import argparse
import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path


def load_memory(root: Path):
    path = root / "scripts" / "ai-verse-memory" / "memory.py"
    spec = importlib.util.spec_from_file_location("j2_integrated_memory", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load installed AI-Verse Memory")
    mem = importlib.util.module_from_spec(spec)
    sys.modules["j2_integrated_memory"] = mem
    spec.loader.exec_module(mem)
    return mem


def canonical_fingerprint(root: Path) -> str:
    rows = []
    roots = [
        root / "operator" / "memory",
        root / "workspaces" / "alpha" / "memory",
        root / "workspaces" / "beta" / "memory",
    ]
    for base in roots:
        if not base.exists():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(root).as_posix()
            if ".ai-verse-memory-state" in rel:
                continue
            rows.append((rel, hashlib.sha256(path.read_bytes()).hexdigest()))
    return hashlib.sha256(
        json.dumps(rows, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def promote(root: Path, digest_id: str):
    mem = load_memory(root)
    admission = {
        "durable": True,
        "historical": True,
        "current_truth": False,
        "contains_secret": False,
        "strategic": False,
        "permission_expansion": False,
        "privacy_ambiguous": False,
        "external_authority": False,
    }
    result = mem.promote_session_digest(
        digest_id,
        [
            {
                "text": "J2-DURABLE checkpoint notes improve review reliability.",
                "type": "lesson",
                "importance": 4,
                "confidence": 0.97,
                "why": "Repeated durable review evidence.",
                "tags": "j2,checkpoint,reliability",
                "evidence_refs": [f"memory:session-digest:{digest_id}"],
                "admission": dict(admission),
            },
            {
                "text": "J2-NONDURABLE conversational aside must stay transient.",
                "type": "fact",
                "confidence": 0.99,
                "admission": {**admission, "durable": False},
            },
        ],
        workspace="alpha",
        root=root,
        mode=mem.MODE_NATIVE,
    )
    return result


def rebuild(root: Path):
    mem = load_memory(root)
    before_canonical = canonical_fingerprint(root)
    before_orientation = mem.get_orientation_map(
        workspace="alpha",
        max_bytes=8192,
        root=root,
        mode=mem.MODE_NATIVE,
    )
    before_rel = mem.rebuild_relationship_projection(root=root, mode=mem.MODE_NATIVE)

    conn, _ = mem.connect_db(root, mem.MODE_NATIVE)
    try:
        conn.execute("DROP TABLE IF EXISTS orientation_maps")
        conn.execute("DROP TABLE IF EXISTS memory_relationships")
        conn.commit()
    finally:
        conn.close()

    after_orientation = mem.get_orientation_map(
        workspace="alpha",
        max_bytes=8192,
        root=root,
        mode=mem.MODE_NATIVE,
    )
    after_rel = mem.rebuild_relationship_projection(root=root, mode=mem.MODE_NATIVE)
    after_canonical = canonical_fingerprint(root)

    return {
        "canonical_unchanged": before_canonical == after_canonical,
        "orientation_equivalent": (
            before_orientation.get("source_fingerprint")
            == after_orientation.get("source_fingerprint")
            and before_orientation.get("counts") == after_orientation.get("counts")
        ),
        "relationships_equivalent": (
            before_rel.get("projection_fingerprint")
            == after_rel.get("projection_fingerprint")
            and before_rel.get("edge_count") == after_rel.get("edge_count")
        ),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("promote", "rebuild"))
    parser.add_argument("--root", required=True)
    parser.add_argument("--digest-id")
    args = parser.parse_args()
    root = Path(args.root).resolve()

    if args.operation == "promote":
        if not args.digest_id:
            raise SystemExit("--digest-id is required for promote")
        result = promote(root, args.digest_id)
    else:
        result = rebuild(root)

    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
