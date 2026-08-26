# Harvest Universal Liquidator Arbitrum

## Structure
- In helpers/token-pairs.json, helpers/pools.json, and helpers/intermediate-tokens.json, the list between test and production is separated.

## Get Started

```shell
yarn
yarn test
```

### Test locally
```shell
yarn  test
```

### Deploy locally
In **1st** terminal session
```shell
# start local node
yarn hardhat node 
```

In **2nd** terminal session

```shell
# deploy base contracts
yarn hardhat run scripts/deploy-ul-base.ts --network localhost
```

```shell
# deploy dex
yarn hardhat run scripts/deploy-dex.ts --network localhost
# input the following parameters
✔ Which dex do you want to deploy? (Ex: UniV3Dex, the contract name) … 
✔ Which name do you want to represent the dex? (Ex: uniV3) … 
```

```shell
# set fees
yarn hardhat run scripts/set-fees.ts --network localhost
```

```shell
# set pools
yarn hardhat run scripts/set-pools.ts --network localhost
```

```shell
# set token pairs
yarn hardhat run scripts/set-paths.ts --network localhost
```

## Registry maintenance

The `UniversalLiquidatorRegistry` emits no events and its `paths` mapping has no
enumerator, so the configured routes cannot be listed from the chain directly and
an explorer's transaction history is not a reliable substitute. `helpers/registry.json`
is the checked-in record of what the registry is *supposed* to contain; the audit
script diffs it against what is actually deployed.

```shell
# refresh the manifest from chain state
yarn registry:seed

# diff the manifest against the chain and health-check every hop
yarn registry:audit
```

Both accept `REGISTRY_RPC_URL` to override the RPC (the default Base endpoint
rate-limits aggressively). Reads are batched through Multicall3, so a full audit
is a few dozen `eth_call`s.

### Seeding

Paths are discovered by probing every ordered pair of the tokens the manifest
already knows about, so a token that appears in no existing path is invisible.
Extend the universe with either:

- `SEED_TOKENS=<file>` — a JSON array of addresses to add
- `SEED_FROM_BLOCK=<block>` — scan `UniversalLiquidator.Swap` logs for token pairs

New dexes are written with `"kind": "unknown"`; set the kind (and `poolFactory` /
`router` / `vault`) by hand or the audit cannot check that dex's hops.

### What the audit checks

Errors (exit code 1):

- `UniversalLiquidator.pathRegistry` and registry owner match the manifest
- every dex resolves to the manifest address, and none resolves to `address(0)`
- intermediate tokens match **in order** — `getPath` returns the first match, so
  order decides routing
- every manifest path exists on chain with the same dex and the same token array,
  and no path exists on chain that the manifest does not know about
- every hop resolves to a pool that is actually deployed

Warnings (exit code 1 only with `AUDIT_STRICT=1`):

- a hop's pool holds less of a token than the `minLiquidity` floor for it
- a pair has no reverse path
- a UniV3 hop uses fee 500, which is indistinguishable from never having been set

### Converging the chain to the manifest

`yarn registry:sync` diffs the manifest against the chain and prints the
transactions that would close the gap — `addDex`, `changeDexAddress`,
`setIntermediateToken`, `setPath` — each with its target and calldata, ordered so
that dexes are registered before any path references them.

```shell
yarn registry:sync                  # dry run, prints calldata
SYNC_EXECUTE=1 yarn registry:sync   # send them (signer must be the registry owner)
```

Paths that exist on chain but not in the manifest are reported and cannot be
fixed: the registry has no `removePath` and `setPath` rejects arrays shorter than
two, so such a path can only be repointed or adopted into the manifest.

### Proposing better routes

`yarn registry:routes` quotes every registered route against the alternatives and
reports the pairs where another dex or shape does better.

```shell
yarn registry:routes                 # $100 test swaps
PROPOSE_USD=1000 yarn registry:routes
```

For each pair it enumerates candidate routes — direct and via each intermediate
token, on every dex with a live pool — picks the deepest pool per hop, and quotes
them all with the same input through each dex's own quoter (`QuoterV2` for
UniV3/CL, `getAmountsOut` for Aerodrome/Baseswap).

Test swaps are sized in **dollars**, because that is the size a liquidation
actually is: a route that only looks good on a huge trade is not the one being
used. There is no price feed involved — each sell token is priced by quoting a
sliver of its deepest pool into `usdAnchor` (USDC), where price impact is
negligible, and reading the marginal rate off that. A sell token with no route to
the anchor is reported rather than guessed at.

- `PROPOSE_USD` value of the test swap (default `100`)
- `PROPOSE_MIN_BPS` report threshold (default `50`, i.e. 0.5%)
- `PROPOSE_LIMIT` only look at the first N paths
- `PROPOSE_VERBOSE=1` print the trade size and every quote

Curve, Balancer and ERC4626 routes are not quoted, so pairs registered on those
dexes are skipped rather than compared.

### Applying proposals

`yarn registry:routes` writes what it found to `helpers/proposals.json` (override
with `PROPOSE_OUT`). `yarn registry:apply` reads that file back and turns the
proposals into transactions.

```shell
yarn registry:routes                                  # write proposals.json
yarn registry:apply                                   # dry run, prints calldata
APPLY_ONLY="AERO>GB,AERO>SEAM" yarn registry:apply    # just those two
APPLY_EXECUTE=1 yarn registry:apply                   # send them
```

A proposal is more than a `setPath`: the target dex needs the same pair config
the quote was taken with, or the new route lands in a different pool than the one
that won. So each proposal records the pool and params per hop, and apply emits
the `setFee` / `setTickSpacing` / `pairSetup` calls needed to match before the
`setPath` that uses them.

Every proposal is **re-quoted before anything is sent**, because prices move
between proposing and applying; one that no longer clears the threshold is
skipped with a note. `APPLY_SKIP_RECHECK=1` disables that.

Two things worth knowing:

- A dex's pair config is global — `pairFee`, `tickSpacing` and `stable` are keyed
  only by the token pair. Changing one to suit a new route also changes every
  other registered path crossing that hop, so apply lists them as a warning
  before the transactions. Re-run the proposer afterwards to check none regressed.
- On success the manifest is updated to match, since it is the record of intent.
  Run `yarn registry:audit` afterwards to confirm chain and manifest agree.

- `APPLY_ONLY` comma separated indices or `SELL>BUY` symbols (default: all)
- `APPLY_MIN_BPS` re-check threshold (default: the file's own `minBps`)
- `APPLY_IN` read a different proposals file
