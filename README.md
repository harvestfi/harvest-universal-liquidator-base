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
