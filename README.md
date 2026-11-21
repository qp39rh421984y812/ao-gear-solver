# AO Gear Solver

Finds the best Arcane Odyssey gear set for the stats you want, using the items,
stat maths and build codes of the [AO Gear Builder](https://ao-gear.pages.dev/).
If no gear set can meet every rule, it returns the one that gets closest.

## Layout

    public/index.html                 page + styles
    public/js/engine.js               port of the gear builder's stat maths and build-code format
    public/js/solver.js               the optimiser
    public/js/worker.js               runs solver attempts in Web Workers (in parallel)
    public/js/app.js                  form, rendering, data loading
    public/data/equipment.json        bundled snapshot of the builder's item data (fallback)
    netlify/functions/builds.mjs      POST saves a solved build, GET lists them
    tests/                            checks (see below)

## Item data

The page reads `https://ao-gear.pages.dev/data/equipment.json` live, so new items
show up as soon as the builder has them. If that fails (offline, site down, or a
format change the engine can't price), it falls back to the bundled snapshot and
says so under the title. To refresh the snapshot:

    curl -A "Mozilla/5.0" -o public/data/equipment.json https://ao-gear.pages.dev/data/equipment.json

## Build codes

Codes are the builder's own base64url format (version 6): level, Magic /
Strength / Weapons / Spirit points, the magics and fighting styles the class
carries, and per slot the item, level, enchant, modifier, faction modifier and
jewels (including fusions and tiers). When the solved gear includes magic- or
style-specific pieces (Arcanium, Arcmancer, Arcsphere, Fighting gear), the code
sets that magic / style, so the builder keeps those pieces instead of swapping
them for another variant. "Open in AO Gear Builder" loads `?build=<code>`.

## How the solver searches

1. Guided construction: for a set of per-stat weights the best build splits into
   the best piece per slot; weights start at EP x priority and are pushed up for
   stats short of a floor and down for stats over a cap (Lagrangian multipliers).
2. Exact local search: every single change of item, enchant, modifier, faction,
   jewel and level; jewels as a set; two slots' items at once; and one fitting in
   each of two slots at once (trades under a binding floor).
3. Kicks, restarts and strategic oscillation (rules briefly priced as penalties)
   until the time is up. Attempts run in parallel; the best one is kept.

Ranking: hard caps first, then summed shortfall on floors, then EP re-weighted by
priority. All reported numbers come from `engine.js`.

## Tests

    node tests/solver-matches-engine.cjs        # solver's fast maths == engine, 1600 random builds
    node tests/random-builds.cjs 60 7 > cases.json
    NODE_PATH=$(npm root -g) node tests/builder-parity.cjs cases.json
                                                # loads each code in the live builder (Playwright)
                                                # and compares every stat and EP

## Deploy

Netlify: publish directory `public`, functions `netlify/functions`, build
command `npm install` (pulls in `@netlify/blobs` for the build log).

    npx netlify dev       # local: page + /api/builds

## Endpoint

    POST /api/builds  {"code":"Bq8BYACOgaqAATOGqgAF6hqoACPoaqAAkAGq","ep":680.43}
    GET  /api/builds?limit=50
