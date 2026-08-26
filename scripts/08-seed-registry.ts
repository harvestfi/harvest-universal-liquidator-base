import fs from "fs";
import { utils } from "ethers";

import deployments from "../deployments.json";
import {
    Call, DexEntry, IERC20, IREGISTRY, Manifest, PathEntry,
    ZERO, decode, key, lc, loadManifest, multicall, provider, saveManifest, MANIFEST,
} from "./utils/registry";

const REGISTRY = deployments.UniversalLiquidatorRegistry;
const UL = deployments.UniversalLiquidator;

// Options come from the environment because `hardhat run` rejects unknown CLI
// flags: SEED_TOKENS=<json array file>, SEED_FROM_BLOCK=<block>.
//
// `paths` is a bare nested mapping with no enumerator and the registry emits no
// events, so the configured set can only be found by probing candidate pairs.
// The candidate universe is the manifest's own token list, optionally extended
// from the UniversalLiquidator's Swap logs.
async function tokenUniverse(existing: Manifest | undefined, intermediates: string[]) {
    const set = new Set<string>(intermediates.map(lc));
    if (existing) Object.keys(existing.tokens).forEach((t) => set.add(lc(t)));

    const file = process.env.SEED_TOKENS;
    if (file) (JSON.parse(fs.readFileSync(file, "utf8")) as string[]).forEach((t) => set.add(lc(t)));

    const from = process.env.SEED_FROM_BLOCK;
    if (from) {
        const p = provider();
        const latest = await p.getBlockNumber();
        const topic = utils.id("Swap(address,address,address,address,uint256,uint256)");
        const STEP = 50_000;
        for (let b = Number(from); b <= latest; b += STEP) {
            const logs = await p.getLogs({
                address: UL, fromBlock: b, toBlock: Math.min(b + STEP - 1, latest), topics: [topic],
            });
            for (const l of logs) {
                set.add(lc("0x" + l.topics[1].slice(26)));
                set.add(lc("0x" + l.topics[2].slice(26)));
            }
        }
        console.log(`scanned Swap logs from block ${from}`);
    }
    return [...set].sort();
}

async function main() {
    const p = provider();
    const existing = fs.existsSync(MANIFEST) ? loadManifest() : undefined;

    const head = await multicall(p, [
        { target: REGISTRY, data: IREGISTRY.encodeFunctionData("getAllDexes") },
        { target: REGISTRY, data: IREGISTRY.encodeFunctionData("getAllIntermediateTokens") },
        { target: REGISTRY, data: IREGISTRY.encodeFunctionData("owner") },
    ]);
    const dexHexes = decode<string[]>(IREGISTRY, "getAllDexes", head[0])!;
    const intermediates = decode<string[]>(IREGISTRY, "getAllIntermediateTokens", head[1])!.map(lc);
    const owner = decode<string>(IREGISTRY, "owner", head[2])!;

    const addrs = await multicall(p, dexHexes.map((h) => ({
        target: REGISTRY, data: IREGISTRY.encodeFunctionData("dexesInfo", [h]),
    })));

    const knownByHex = new Map<string, string>();
    for (const [name, d] of Object.entries(deployments.Dexes)) knownByHex.set(lc(d.hex), name);
    const prevByHex = new Map<string, DexEntry>();
    existing?.dexes.forEach((d) => prevByHex.set(lc(d.hex), d));

    const dexes: DexEntry[] = dexHexes.map((hex, i) => {
        const prev = prevByHex.get(lc(hex));
        const address = lc(decode<string>(IREGISTRY, "dexesInfo", addrs[i]) ?? ZERO);
        return { ...(prev ?? { name: knownByHex.get(lc(hex)) ?? hex, kind: "unknown" as const, hex: lc(hex) }), address };
    });

    const tokens = await tokenUniverse(existing, intermediates);
    console.log(`probing ${tokens.length} tokens -> ${tokens.length * (tokens.length - 1)} ordered pairs`);

    const probes: Call[] = [];
    const pairs: [string, string][] = [];
    for (const a of tokens) for (const b of tokens) {
        if (a === b) continue;
        pairs.push([a, b]);
        probes.push({ target: REGISTRY, data: IREGISTRY.encodeFunctionData("paths", [a, b]) });
    }
    const probed = await multicall(p, probes);

    const hits: [string, string][] = [];
    const dexOf = new Map<string, string>();
    probed.forEach((r, i) => {
        const dex = decode<string>(IREGISTRY, "paths", r);
        if (dex && !/^0x0+$/.test(dex)) { hits.push(pairs[i]); dexOf.set(key(...pairs[i]), lc(dex)); }
    });
    console.log(`found ${hits.length} configured paths`);

    const full = await multicall(p, hits.map(([a, b]) => ({
        target: REGISTRY, data: IREGISTRY.encodeFunctionData("getPath", [a, b]),
    })));

    const nameOf = new Map(dexes.map((d) => [lc(d.hex), d.name]));
    const paths: PathEntry[] = [];
    const involved = new Set<string>(tokens);
    hits.forEach(([a, b], i) => {
        const legs = decode<any[]>(IREGISTRY, "getPath", full[i]);
        // A configured direct path always resolves as a single leg.
        if (!legs || legs.length !== 1) return;
        const route = (legs[0].paths as string[]).map(lc);
        route.forEach((t) => involved.add(t));
        paths.push({
            sellToken: a, buyToken: b, symbols: "",
            dex: nameOf.get(dexOf.get(key(a, b))!) ?? dexOf.get(key(a, b))!, path: route,
        });
    });

    const list = [...involved].sort();
    const meta = await multicall(p, list.map((t) => ({ target: t, data: IERC20.encodeFunctionData("symbol") })));
    const symbols: Record<string, string> = {};
    list.forEach((t, i) => { symbols[t] = decode<string>(IERC20, "symbol", meta[i]) ?? t.slice(0, 8); });
    paths.forEach((p_) => { p_.symbols = p_.path.map((t) => symbols[t] ?? t.slice(0, 8)).join(" > "); });
    paths.sort((x, y) => x.symbols.localeCompare(y.symbols));

    const manifest: Manifest = {
        network: "base",
        registry: REGISTRY,
        universalLiquidator: UL,
        owner,
        generatedAtBlock: await p.getBlockNumber(),
        intermediateTokens: intermediates,
        tokens: symbols,
        minLiquidity: existing?.minLiquidity ?? {},
        dexes,
        paths,
    };
    saveManifest(manifest);
    console.log(`wrote ${MANIFEST}`);
    console.log(`  dexes ${dexes.length} | paths ${paths.length} | tokens ${list.length}`);
    const unknown = dexes.filter((d) => d.kind === "unknown").map((d) => d.name);
    if (unknown.length) console.log(`  set "kind" for: ${unknown.join(", ")}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
