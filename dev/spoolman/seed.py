#!/usr/bin/env python3
"""Seed the local Spoolman dev instance with a known fixture.

Idempotent: re-running is a no-op when records already exist.
Matches by (vendor.name, filament.article_number, spool.lot_nr) triples
so subsequent runs don't pile up duplicates.

Usage:
    python dev/spoolman/seed.py
    SPOOLMAN_URL=http://localhost:7912 python dev/spoolman/seed.py
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request


SPOOLMAN_URL = os.environ.get("SPOOLMAN_URL", "http://localhost:7912").rstrip("/")
API = f"{SPOOLMAN_URL}/api/v1"


def _req(method: str, path: str, body: dict | None = None) -> dict | list:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{API}{path}",
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        # 30s: cold Spoolman boots run an external DB sync that briefly
        # starves request handling. 10s tripped on first run.
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise SystemExit(f"Spoolman {method} {path} failed: {e.code} {body}")
    except urllib.error.URLError as e:
        raise SystemExit(
            f"Cannot reach Spoolman at {SPOOLMAN_URL} — is the dev container up?\n"
            f"  docker compose -f dev/spoolman/docker-compose.yml up -d\n\n"
            f"Underlying error: {e}"
        )


def find_vendor(name: str) -> dict | None:
    for v in _req("GET", "/vendor"):
        if v.get("name") == name:
            return v
    return None


def find_filament(vendor_id: int, article_number: str) -> dict | None:
    for f in _req("GET", "/filament"):
        if (
            f.get("vendor", {}).get("id") == vendor_id
            and f.get("article_number") == article_number
        ):
            return f
    return None


def find_spool(filament_id: int, lot_nr: str) -> dict | None:
    for s in _req("GET", "/spool"):
        if (
            s.get("filament", {}).get("id") == filament_id
            and s.get("lot_nr") == lot_nr
        ):
            return s
    return None


def ensure_vendor(name: str, comment: str = "") -> dict:
    existing = find_vendor(name)
    if existing:
        return existing
    return _req("POST", "/vendor", {"name": name, "comment": comment})


def ensure_filament(
    *,
    vendor_id: int,
    name: str,
    material: str,
    article_number: str,
    color_hex: str,
    density: float,
    diameter: float,
    weight: float,
    settings_extruder_temp: int,
    settings_bed_temp: int,
) -> dict:
    existing = find_filament(vendor_id, article_number)
    if existing:
        return existing
    return _req(
        "POST",
        "/filament",
        {
            "name": name,
            "vendor_id": vendor_id,
            "material": material,
            "article_number": article_number,
            "color_hex": color_hex,
            "density": density,
            "diameter": diameter,
            "weight": weight,
            "settings_extruder_temp": settings_extruder_temp,
            "settings_bed_temp": settings_bed_temp,
        },
    )


def ensure_spool(
    *,
    filament_id: int,
    lot_nr: str,
    initial_weight: float,
    used_weight: float,
    location: str,
) -> dict:
    existing = find_spool(filament_id, lot_nr)
    if existing:
        return existing
    return _req(
        "POST",
        "/spool",
        {
            "filament_id": filament_id,
            "lot_nr": lot_nr,
            "initial_weight": initial_weight,
            "used_weight": used_weight,
            "location": location,
        },
    )


def main() -> int:
    print(f"Seeding Spoolman at {SPOOLMAN_URL} ...")

    bambu = ensure_vendor("Bambu Lab", comment="Seeded by STLVault dev seed.py")
    print(f"  vendor #{bambu['id']} Bambu Lab")

    pla_charcoal = ensure_filament(
        vendor_id=bambu["id"],
        name="PLA Matte Charcoal",
        material="PLA",
        article_number="GFA02-K0",
        color_hex="1a1a1a",
        density=1.24,
        diameter=1.75,
        weight=1000.0,
        settings_extruder_temp=220,
        settings_bed_temp=55,
    )
    print(f"  filament #{pla_charcoal['id']} PLA Matte Charcoal")

    petg_galaxy = ensure_filament(
        vendor_id=bambu["id"],
        name="PETG-HF Galaxy Black",
        material="PETG",
        article_number="GFG02-K1",
        color_hex="0d0d20",
        density=1.27,
        diameter=1.75,
        weight=1000.0,
        settings_extruder_temp=255,
        settings_bed_temp=70,
    )
    print(f"  filament #{petg_galaxy['id']} PETG-HF Galaxy Black")

    # Three spools, intentionally varied for picker UX testing.
    spools = [
        ensure_spool(
            filament_id=pla_charcoal["id"],
            lot_nr="LOT-PLA-CHARCOAL-A",
            initial_weight=1000.0,
            used_weight=51.0,            # near-full
            location="Dry box A",
        ),
        ensure_spool(
            filament_id=pla_charcoal["id"],
            lot_nr="LOT-PLA-CHARCOAL-B",
            initial_weight=1000.0,
            used_weight=520.0,           # half
            location="Shelf 2",
        ),
        ensure_spool(
            filament_id=petg_galaxy["id"],
            lot_nr="LOT-PETG-GALAXY-A",
            initial_weight=1000.0,
            used_weight=940.0,           # near-empty
            location="Dry box B",
        ),
    ]
    for s in spools:
        print(
            f"  spool #{s['id']} "
            f"filament_id={s['filament']['id']} "
            f"lot={s['lot_nr']} "
            f"used={s['used_weight']}g"
        )

    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
