# Local Spoolman for STLVault dev

A throwaway [Spoolman](https://github.com/Donkie/Spoolman) instance with seeded fixtures so the STLVault backend has something real to talk to during local development. Standalone — does not touch the production `docker-compose.yml` at the repo root.

## Bring up

```bash
docker compose -f dev/spoolman/docker-compose.yml up -d
python dev/spoolman/seed.py
open http://localhost:7912        # Spoolman's own UI — sanity check
```

The container exposes Spoolman on **`http://localhost:7912`** (REST base: `http://localhost:7912/api/v1`). The SQLite database persists under `dev/spoolman/data/` (gitignored).

## Configure STLVault

In the running STLVault dev frontend → **Settings → Spoolman**:

- Base URL: `http://localhost:7912/api/v1`
- Leave the API key blank (the dev container has no auth in front of it)
- Toggle **Enable** on
- Click **Test connection** — should show green with a Spoolman version string

The spool picker (in PR 2's "Log a print" dialog) will then show the three seeded spools.

## Seeded data

Re-running `seed.py` is a no-op when records already exist (matched by `vendor.name`, `filament.article_number`, `spool.lot_nr`).

| Vendor | Filament | Article # | Spool lot | Remaining |
|---|---|---|---|---|
| Bambu Lab | PLA Matte Charcoal (`#1a1a1a`) | GFA02-K0 | LOT-PLA-CHARCOAL-A | 949g (near-full) |
| Bambu Lab | PLA Matte Charcoal (`#1a1a1a`) | GFA02-K0 | LOT-PLA-CHARCOAL-B | 480g (half) |
| Bambu Lab | PETG-HF Galaxy Black (`#0d0d20`) | GFG02-K1 | LOT-PETG-GALAXY-A | 60g (near-empty) |

The three remaining-weight levels exercise the picker UX at different inventory states.

## Tear down / reset

```bash
docker compose -f dev/spoolman/docker-compose.yml down               # keep data
docker compose -f dev/spoolman/docker-compose.yml down && rm -rf dev/spoolman/data    # wipe
```

## Pointing at a different Spoolman

`seed.py` honors `SPOOLMAN_URL`:

```bash
SPOOLMAN_URL=http://192.168.1.42:7912 python dev/spoolman/seed.py
```

Useful when you already host Spoolman on the LAN and just want the fixture inside it.
