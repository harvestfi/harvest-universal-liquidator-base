import { BigNumber, utils } from "ethers";

import {
    Call, DexEntry, IAERO_ROUTER, ICLFACTORY, IDEX, IERC20, IFACTORY, IQUOTER, IV2ROUTER,
    Manifest, QUOTE_CHUNK, Res, ZERO, decode, isZeroHex, lc, loadManifest, multicall, provider,
} from "./utils/registry";

// PROPOSE_NOTIONAL_BPS  trade size as bps of the deepest candidate pool (default 1%)
// PROPOSE_MIN_BPS       only report improvements above this (default 0.5%)
// PROPOSE_LIMIT         only look at the first N paths (for a quick run)
const NOTIONAL_BPS = Number(process.env.PROPOSE_NOTIONAL_BPS ?? 100);
const MIN_BPS = Number(process.env.PROPOSE_MIN_BPS ?? 50);
const LIMIT = process.env.PROPOSE_LIMIT ? Number(process.env.PROPOSE_LIMIT) : undefined;
// PROPOSE_VERBOSE=1 prints the trade size and every quote, so a proposal can be checked by hand
const VERBOSE = process.env.PROPOSE_VERBOSE === "1";

const IPOOL = new utils.Interface(["function factory() view returns (address)"]);
const alive = (r: Res) => r.success && r.data !== "0x";

/** One concrete way to get from a to b: a dex, a token route, and a tier per hop. */
interface Route {
    dex: DexEntry;
    tokens: string[];
    tiers: number[];      // fee / tickSpacing per hop; unused for univ2
    stable?: boolean[];   // solidly only
    label: string;
}

interface HopOption { pool: string; tier: number; stable?: boolean; depth?: BigNumber }

function encodePacked(tokens: string[], tiers: number[], type: "uint24" | "int24") {
    const types: string[] = ["address"];
    const values: any[] = [tokens[0]];
    for (let i = 1; i < tokens.length; i++) { types.push(type, "address"); values.push(tiers[i - 1], tokens[i]); }
    return utils.solidityPack(types, values);
}

async function main() {
    const p = provider();
    const m: Manifest = loadManifest();
    const sym = (t: string) => m.tokens[lc(t)] ?? t.slice(0, 8);
    const byName = new Map(m.dexes.map((d) => [d.name, d]));
    const paths = LIMIT ? m.paths.slice(0, LIMIT) : m.paths;

    // CL factories publish the tick spacings they support; uniV3 tiers come from the manifest.
    const clDexes = m.dexes.filter((d) => d.kind === "cl");
    const tsRes = await multicall(p, clDexes.map((d) => ({ target: d.poolFactory!, data: ICLFACTORY.encodeFunctionData("tickSpacings") })));
    clDexes.forEach((d, i) => { d.tiers = d.tiers ?? (decode<number[]>(ICLFACTORY, "tickSpacings", tsRes[i]) ?? []).map(Number); });

    const candidates = m.dexes.filter((d) => ["uniV3", "cl", "univ2", "solidly"].includes(d.kind));

    const tokenList = Object.keys(m.tokens).map(lc);
    const decRes = await multicall(p, tokenList.map((t) => ({ target: t, data: IERC20.encodeFunctionData("decimals") })));
    const DEC = new Map<string, number>();
    tokenList.forEach((t, i) => DEC.set(t, Number(decode<any>(IERC20, "decimals", decRes[i]) ?? 18)));
    const fmt = (v: BigNumber, t: string) => {
        const n = Number(utils.formatUnits(v, DEC.get(lc(t)) ?? 18));
        return n >= 1000 ? n.toFixed(0) : n >= 1 ? n.toFixed(3) : n.toPrecision(3);
    };

    // ---------- phase 1: which pools exist, and how deep ----------
    // Enumerating pools first keeps the expensive quoter calls down to routes
    // that can actually execute.
    const shapes = new Map<string, string[][]>();
    const hopSet = new Map<string, { a: string; b: string; dex: DexEntry }>();
    for (const x of paths) {
        const list: string[][] = [[lc(x.sellToken), lc(x.buyToken)]];
        for (const i of m.intermediateTokens.map(lc))
            if (i !== lc(x.sellToken) && i !== lc(x.buyToken)) list.push([lc(x.sellToken), i, lc(x.buyToken)]);
        shapes.set(`${lc(x.sellToken)}|${lc(x.buyToken)}`, list);
        for (const shape of list)
            for (let h = 0; h < shape.length - 1; h++)
                for (const d of candidates)
                    hopSet.set(`${d.name}|${shape[h]}|${shape[h + 1]}`, { a: shape[h], b: shape[h + 1], dex: d });
    }

    const hopKeys = [...hopSet.keys()];
    const probe: Call[] = [];
    const probeMap: { key: string; tier: number; stable?: boolean; idx: number }[] = [];
    for (const k of hopKeys) {
        const { a, b, dex } = hopSet.get(k)!;
        if (dex.kind === "uniV3" || dex.kind === "cl") {
            const fn = dex.kind === "uniV3" ? "getPool(address,address,uint24)" : "getPool(address,address,int24)";
            for (const tier of dex.tiers ?? []) {
                probeMap.push({ key: k, tier, idx: probe.length });
                probe.push({ target: dex.poolFactory!, data: IFACTORY.encodeFunctionData(fn, [a, b, tier]) });
            }
        } else if (dex.kind === "univ2") {
            probeMap.push({ key: k, tier: 0, idx: probe.length });
            probe.push({ target: dex.poolFactory!, data: IFACTORY.encodeFunctionData("getPair", [a, b]) });
        } else {
            for (const stable of [false, true]) {
                probeMap.push({ key: k, tier: 0, stable, idx: probe.length });
                probe.push({ target: dex.router!, data: IAERO_ROUTER.encodeFunctionData("poolFor", [a, b, stable, ZERO]) });
            }
        }
    }
    console.log(`probing ${probe.length} candidate pools across ${candidates.length} dexes...`);
    const probed = await multicall(p, probe);

    const found: { key: string; tier: number; stable?: boolean; pool: string }[] = [];
    for (const pm of probeMap) {
        const pool = decode<string>(IFACTORY, "getPair", probed[pm.idx]);
        if (!isZeroHex(pool)) found.push({ ...pm, pool: lc(pool!) });
    }

    // A solidly pool address is computed, not looked up, so it may not exist.
    const codeRes = await multicall(p, found.map((f) => ({ target: f.pool, data: IPOOL.encodeFunctionData("factory") })));
    const live = found.filter((_, i) => alive(codeRes[i]));

    const depthRes = await multicall(p, live.map((f) => ({
        target: hopSet.get(f.key)!.a, data: IERC20.encodeFunctionData("balanceOf", [f.pool]),
    })));
    const options = new Map<string, HopOption[]>();
    live.forEach((f, i) => {
        const depth = decode<BigNumber>(IERC20, "balanceOf", depthRes[i]) ?? BigNumber.from(0);
        if (depth.isZero()) return;
        const arr = options.get(f.key) ?? [];
        arr.push({ pool: f.pool, tier: f.tier, stable: f.stable, depth });
        options.set(f.key, arr);
    });
    for (const arr of options.values()) arr.sort((x, y) => (y.depth!.gt(x.depth!) ? 1 : -1));
    console.log(`${options.size} of ${hopKeys.length} candidate hops have a live pool`);

    // ---------- phase 2: build routes and quote ----------
    const quotes: Call[] = [];
    const quoteMeta: { pair: string; route: Route; incumbent: boolean; idx: number }[] = [];
    const notionals = new Map<string, BigNumber>();

    for (const x of paths) {
        const pair = `${lc(x.sellToken)}|${lc(x.buyToken)}`;
        // Size the trade off the deepest first-hop pool anyone offers, so every
        // candidate is compared on the same, realistic amount.
        let deepest = BigNumber.from(0);
        const firstHops = new Set(shapes.get(pair)!.map((sh) => `${sh[0]}|${sh[1]}`));
        if (x.path.length > 1) firstHops.add(`${lc(x.sellToken)}|${lc(x.path[1])}`);
        for (const d of candidates) for (const fh of firstHops) {
            const o = options.get(`${d.name}|${fh}`);
            if (o?.[0]?.depth?.gt(deepest)) deepest = o[0].depth!;
        }
        const notional = deepest.mul(NOTIONAL_BPS).div(10_000);
        if (notional.isZero()) continue;
        notionals.set(pair, notional);

        const routes: Route[] = [];
        // the route as registered
        const inc = byName.get(x.dex);
        if (inc && ["uniV3", "cl", "univ2", "solidly"].includes(inc.kind))
            routes.push({ dex: inc, tokens: x.path.map(lc), tiers: [], label: `${x.dex} (registered)` });
        // alternatives: every candidate dex, every shape, deepest tier per hop
        for (const d of candidates) for (const shape of shapes.get(pair)!) {
            const picks: HopOption[] = [];
            for (let h = 0; h < shape.length - 1; h++) {
                const o = options.get(`${d.name}|${shape[h]}|${shape[h + 1]}`);
                if (!o?.length) { picks.length = 0; break; }
                picks.push(o[0]);
            }
            if (!picks.length) continue;
            const same = d.name === x.dex && shape.join(",") === x.path.map(lc).join(",");
            if (same) continue;
            routes.push({
                dex: d, tokens: shape, tiers: picks.map((o) => o.tier), stable: picks.map((o) => !!o.stable),
                label: `${d.name} ${shape.map(sym).join(">")}`,
            });
        }

        for (const r of routes) {
            const isInc = r.label.endsWith("(registered)");
            const call = await buildQuote(p, r, notional, isInc, x, options, sym);
            if (!call) continue;
            quoteMeta.push({ pair, route: r, incumbent: isInc, idx: quotes.length });
            quotes.push(call);
        }
    }

    console.log(`quoting ${quotes.length} routes for ${notionals.size} pairs...`);
    const quoted = await multicall(p, quotes, QUOTE_CHUNK);

    const out = new Map<string, { route: Route; incumbent: boolean; amount: BigNumber }[]>();
    quoteMeta.forEach((q) => {
        const r = quoted[q.idx];
        if (!alive(r)) return;
        let amount: BigNumber | undefined;
        if (q.route.dex.kind === "uniV3" || q.route.dex.kind === "cl")
            amount = decode<BigNumber>(IQUOTER, "quoteExactInput", r);
        else {
            const amts = decode<BigNumber[]>(q.route.dex.kind === "solidly" ? IAERO_ROUTER : IV2ROUTER, "getAmountsOut", r);
            amount = amts?.[amts.length - 1];
        }
        if (!amount || amount.isZero()) return;
        const arr = out.get(q.pair) ?? [];
        arr.push({ route: q.route, incumbent: q.incumbent, amount });
        out.set(q.pair, arr);
    });

    // ---------- report ----------
    const proposals: { pair: string; gain: number; inc: BigNumber; best: any }[] = [];
    const unquotable: string[] = [];
    for (const [pair, list] of out) {
        const inc = list.find((r) => r.incumbent);
        const best = list.reduce((a, b) => (b.amount.gt(a.amount) ? b : a));
        if (!inc) { unquotable.push(pair); continue; }
        if (best.incumbent) continue;
        const gain = best.amount.sub(inc.amount).mul(10_000).div(inc.amount.isZero() ? 1 : inc.amount).toNumber();
        if (gain >= MIN_BPS) proposals.push({ pair, gain, inc: inc.amount, best });
    }
    proposals.sort((a, b) => b.gain - a.gain);

    const [a0, b0] = ["", ""];
    console.log(`\n=== ${proposals.length} route(s) where an alternative beats the registered one by >= ${MIN_BPS} bps ===`);
    console.log(`trade size = ${NOTIONAL_BPS} bps of the deepest first-hop pool\n`);
    if (VERBOSE) {
        for (const [pair, list] of out) {
            const [s0, b0] = pair.split("|");
            console.log(`\n${sym(s0)} > ${sym(b0)}  size ${utils.formatUnits(notionals.get(pair)!, 0)} raw ${sym(s0)}`);
            for (const r of [...list].sort((a, b) => (b.amount.gt(a.amount) ? 1 : -1)))
                console.log(`   ${r.amount.toString().padStart(28)}  ${r.route.label}${r.incumbent ? "  <- registered" : ""}`);
        }
        console.log("");
    }

    for (const pr of proposals) {
        const [s, b] = pr.pair.split("|");
        const x = paths.find((q) => lc(q.sellToken) === s && lc(q.buyToken) === b)!;
        const size = notionals.get(pr.pair)!;
        console.log(`${sym(s)} > ${sym(b)}   +${(pr.gain / 100).toFixed(2)}%   on ${fmt(size, s)} ${sym(s)}`);
        console.log(`   now  ${x.symbols} [${x.dex}]  ->  ${fmt(pr.inc, b)} ${sym(b)}`);
        console.log(`   alt  ${pr.best.route.label}  ->  ${fmt(pr.best.amount, b)} ${sym(b)}`);
    }
    if (unquotable.length)
        console.log(`\n${unquotable.length} pair(s) had no quotable registered route (curve/balancer/erc4626 are not quoted here)`);
}

async function buildQuote(
    p: any, r: Route, amountIn: BigNumber, incumbent: boolean, entry: any,
    options: Map<string, HopOption[]>, sym: (t: string) => string,
): Promise<Call | undefined> {
    const d = r.dex;
    if (d.kind === "uniV3" || d.kind === "cl") {
        if (!d.quoter) return undefined;
        let tiers = r.tiers;
        if (incumbent) {
            // reuse whatever the dex contract has configured for this pair
            const fn = d.kind === "uniV3" ? "pairFee" : "tickSpacing";
            const res = await multicall(p, r.tokens.slice(0, -1).map((t, i) => ({
                target: d.address, data: IDEX.encodeFunctionData(fn, [t, r.tokens[i + 1]]),
            })));
            tiers = res.map((x, i) => Number(decode<any>(IDEX, fn, x) ?? d.defaultFee ?? 0));
            if (tiers.some((t) => !t)) return undefined;
        }
        const path = encodePacked(r.tokens, tiers, d.kind === "uniV3" ? "uint24" : "int24");
        return { target: d.quoter, data: IQUOTER.encodeFunctionData("quoteExactInput", [path, amountIn]) };
    }
    if (d.kind === "univ2") {
        if (!d.router) return undefined;
        return { target: d.router, data: IV2ROUTER.encodeFunctionData("getAmountsOut", [amountIn, r.tokens]) };
    }
    if (d.kind === "solidly") {
        if (!d.router) return undefined;
        const legs = [];
        for (let i = 0; i < r.tokens.length - 1; i++) {
            let stable = r.stable?.[i] ?? false;
            let factory = ZERO;
            if (incumbent) {
                const res = await multicall(p, [
                    { target: d.address, data: IDEX.encodeFunctionData("stable", [r.tokens[i], r.tokens[i + 1]]) },
                    { target: d.address, data: IDEX.encodeFunctionData("factory", [r.tokens[i], r.tokens[i + 1]]) },
                ]);
                stable = decode<boolean>(IDEX, "stable", res[0]) ?? false;
                factory = decode<string>(IDEX, "factory", res[1]) ?? ZERO;
            }
            legs.push({ from: r.tokens[i], to: r.tokens[i + 1], stable, factory });
        }
        return { target: d.router, data: IAERO_ROUTER.encodeFunctionData("getAmountsOut", [amountIn, legs]) };
    }
    return undefined;
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
