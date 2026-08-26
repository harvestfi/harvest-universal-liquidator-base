import { BigNumber } from "ethers";
import fs from "fs";
import { ethers } from "hardhat";

import { utils } from "ethers";

import {
    Call, DexEntry, IDEX, IREGISTRY, Manifest, PROPOSALS, ProposalFile, Route, ZERO,
    buildQuote, decode, lc, loadManifest, multicall, provider, readQuote, saveManifest,
} from "./utils/registry";

const IAERO_DEFAULT = new utils.Interface(["function defaultFactory() view returns (address)"]);

// APPLY_EXECUTE=1   send the transactions (dry run otherwise)
// APPLY_ONLY        comma separated indices or "SELL>BUY" symbols; default all
// APPLY_MIN_BPS     re-check threshold; defaults to the file's own minBps
// APPLY_SKIP_RECHECK=1  apply without re-quoting (not recommended)
const EXECUTE = process.env.APPLY_EXECUTE === "1";
const ONLY = process.env.APPLY_ONLY?.split(",").map((x) => x.trim()).filter(Boolean);
const SKIP_RECHECK = process.env.APPLY_SKIP_RECHECK === "1";

interface Op { kind: string; to: string; data: string; what: string }

async function main() {
    const file: ProposalFile = JSON.parse(fs.readFileSync(process.env.APPLY_IN ?? PROPOSALS, "utf8"));
    const m: Manifest = loadManifest();
    const p = EXECUTE ? ethers.provider : provider();
    const sym = (t: string) => m.tokens[lc(t)] ?? t.slice(0, 8);
    const byName = new Map(m.dexes.map((d) => [d.name, d]));
    const minBps = Number(process.env.APPLY_MIN_BPS ?? file.minBps);

    if (lc(file.registry) !== lc(m.registry))
        throw new Error(`proposals target ${file.registry}, manifest is ${m.registry}`);

    let chosen = file.proposals.map((pr, i) => ({ pr, i }));
    if (ONLY) chosen = chosen.filter(({ pr, i }) =>
        ONLY.includes(String(i)) || ONLY.includes(`${sym(pr.sellToken)}>${sym(pr.buyToken)}`));

    const age = (await p.getBlockNumber()) - file.generatedAtBlock;
    console.log(`${file.proposals.length} proposal(s) from block ${file.generatedAtBlock} (${age} blocks ago), $${file.usd} swaps`);
    console.log(`applying ${chosen.length}\n`);

    // ---------- re-quote before writing anything ----------
    // Prices move between proposing and applying, so a proposal is only worth
    // acting on if it still wins right now.
    const keep: typeof chosen = [];
    if (SKIP_RECHECK) {
        keep.push(...chosen);
        console.log("re-check skipped\n");
    } else {
        const calls: Call[] = [];
        const meta: { idx: number; which: "cur" | "new"; route: Route; size: BigNumber }[] = [];
        for (const { pr, i } of chosen) {
            const size = BigNumber.from(file.sizes[lc(pr.sellToken)] ?? "0");
            if (size.isZero()) continue;
            const cur = byName.get(pr.current.dex);
            const nxt = byName.get(pr.proposed.dex);
            if (!cur || !nxt) continue;
            const curRoute = await routeFromChain(p, cur, pr.current.path.map(lc));
            const newRoute: Route = {
                dex: nxt, tokens: pr.proposed.path.map(lc), label: pr.proposed.symbols,
                tiers: pr.proposed.hops.map((h) => h.fee ?? h.tickSpacing ?? 0),
                stable: pr.proposed.hops.map((h) => !!h.stable),
                factories: pr.proposed.hops.map((h) => h.factory ?? ZERO),
            };
            for (const [which, route] of [["cur", curRoute], ["new", newRoute]] as const) {
                const c = buildQuote(route, size);
                if (!c) continue;
                meta.push({ idx: i, which, route, size });
                calls.push(c);
            }
        }
        const res = await multicall(p, calls, 8);
        const now = new Map<number, { cur?: BigNumber; nxt?: BigNumber }>();
        meta.forEach((q, k) => {
            const amt = readQuote(q.route, res[k]);
            const e = now.get(q.idx) ?? {};
            if (q.which === "cur") e.cur = amt; else e.nxt = amt;
            now.set(q.idx, e);
        });
        for (const c of chosen) {
            const e = now.get(c.i);
            if (!e?.cur || !e.nxt || e.cur.isZero()) {
                console.log(`  skip ${sym(c.pr.sellToken)} > ${sym(c.pr.buyToken)}: could not re-quote`);
                continue;
            }
            const gain = e.nxt.sub(e.cur).mul(10_000).div(e.cur).toNumber();
            if (gain < minBps) {
                console.log(`  skip ${sym(c.pr.sellToken)} > ${sym(c.pr.buyToken)}: gain is now ${(gain / 100).toFixed(2)}%, below ${(minBps / 100).toFixed(2)}%`);
                continue;
            }
            console.log(`  ok   ${sym(c.pr.sellToken)} > ${sym(c.pr.buyToken)}: ${(gain / 100).toFixed(2)}% (proposed ${(c.pr.gainBps / 100).toFixed(2)}%)`);
            keep.push(c);
        }
        console.log("");
    }
    if (!keep.length) { console.log("nothing left to apply"); return; }

    // ---------- build ops: dex params first, then the path ----------
    // A dex's pair config is global: pairFee/tickSpacing/stable are keyed only by
    // the token pair, so changing one silently re-routes every other registered
    // path that crosses the same hop.
    const usesHop = (dexName: string, a: string, b: string) => m.paths.filter((x) => {
        if (x.dex !== dexName) return false;
        for (let i = 0; i < x.path.length - 1; i++) {
            const [f, t] = [lc(x.path[i]), lc(x.path[i + 1])];
            if ((f === lc(a) && t === lc(b)) || (f === lc(b) && t === lc(a))) return true;
        }
        return false;
    });
    const beingApplied = new Set(keep.map(({ pr }) => `${lc(pr.sellToken)}|${lc(pr.buyToken)}`));
    const shared: string[] = [];

    // factory(0) and the router's defaultFactory select the same pool, so treat
    // them as equal rather than writing a pointless change.
    let defaultFactory = ZERO;
    const aero = m.dexes.find((d) => d.kind === "solidly");
    if (aero?.router) {
        const r = await multicall(p, [{ target: aero.router, data: IAERO_DEFAULT.encodeFunctionData("defaultFactory") }]);
        defaultFactory = lc(decode<string>(IAERO_DEFAULT, "defaultFactory", r[0]) ?? ZERO);
    }
    const normFactory = (f: string) => (lc(f) === ZERO ? defaultFactory : lc(f));

    const ops: Op[] = [];
    for (const { pr } of keep) {
        const dex = byName.get(pr.proposed.dex)!;
        const reads: Call[] = [];
        for (const h of pr.proposed.hops) {
            if (dex.kind === "uniV3") reads.push({ target: dex.address, data: IDEX.encodeFunctionData("pairFee", [h.from, h.to]) });
            else if (dex.kind === "cl") reads.push({ target: dex.address, data: IDEX.encodeFunctionData("tickSpacing", [h.from, h.to]) });
            else if (dex.kind === "solidly") {
                reads.push({ target: dex.address, data: IDEX.encodeFunctionData("stable", [h.from, h.to]) });
                reads.push({ target: dex.address, data: IDEX.encodeFunctionData("factory", [h.from, h.to]) });
            }
        }
        const cur = await multicall(p, reads);
        let k = 0;
        for (const h of pr.proposed.hops) {
            const label = `${dex.name} ${sym(h.from)}/${sym(h.to)}`;
            const others = usesHop(dex.name, h.from, h.to)
                .filter((x) => !beingApplied.has(`${lc(x.sellToken)}|${lc(x.buyToken)}`));
            if (dex.kind === "uniV3") {
                const have = Number(decode<any>(IDEX, "pairFee", cur[k++]) ?? 0);
                if (have !== h.fee) {
                    ops.push({ kind: "setFee", to: dex.address, what: `${label} ${have} -> ${h.fee}`,
                        data: IDEX.encodeFunctionData("setFee", [h.from, h.to, h.fee]) });
                    if (others.length) shared.push(`${label} ${have} -> ${h.fee} also affects: ${others.map((x) => x.symbols).join("; ")}`);
                }
            } else if (dex.kind === "cl") {
                const have = Number(decode<any>(IDEX, "tickSpacing", cur[k++]) ?? 0);
                if (have !== h.tickSpacing) {
                    ops.push({ kind: "setTickSpacing", to: dex.address, what: `${label} ${have} -> ${h.tickSpacing}`,
                        data: IDEX.encodeFunctionData("setTickSpacing", [h.from, h.to, h.tickSpacing]) });
                    if (others.length) shared.push(`${label} ${have} -> ${h.tickSpacing} also affects: ${others.map((x) => x.symbols).join("; ")}`);
                }
            } else if (dex.kind === "solidly") {
                const haveStable = decode<boolean>(IDEX, "stable", cur[k++]) ?? false;
                const haveFactory = lc(decode<string>(IDEX, "factory", cur[k++]) ?? ZERO);
                if (haveStable !== !!h.stable || normFactory(haveFactory) !== normFactory(h.factory ?? ZERO)) {
                    // keep whatever factory the dex already names when it resolves the same
                    const factory = normFactory(haveFactory) === normFactory(h.factory ?? ZERO) ? haveFactory : (h.factory ?? ZERO);
                    ops.push({ kind: "pairSetup", to: dex.address, what: `${label} stable ${haveStable} -> ${!!h.stable}`,
                        data: IDEX.encodeFunctionData("pairSetup", [h.from, h.to, !!h.stable, factory]) });
                    if (others.length) shared.push(`${label} stable ${haveStable} -> ${!!h.stable} also affects: ${others.map((x) => x.symbols).join("; ")}`);
                }
            }
        }
        ops.push({
            kind: "setPath", to: m.registry, what: `${pr.proposed.symbols} [${dex.name}]`,
            data: IREGISTRY.encodeFunctionData("setPath", [dex.hex, pr.proposed.path]),
        });
    }

    if (shared.length) {
        console.log(`WARNING: ${shared.length} pair-config change(s) affect paths not being applied:`);
        for (const w of shared) console.log(`  - ${w}`);
        console.log("  re-run the proposer afterwards to check those did not regress.\n");
    }

    console.log(`${ops.length} transaction(s):\n`);
    ops.forEach((o, i) => {
        console.log(`${String(i + 1).padStart(3)}. ${o.kind}  ${o.what}`);
        console.log(`     to   ${o.to}`);
        console.log(`     data ${o.data}`);
    });

    if (!EXECUTE) { console.log("\ndry run — set APPLY_EXECUTE=1 to send"); return; }

    const signers = await ethers.getSigners();
    if (!signers.length) throw new Error("no signer available; set MNEMONIC in .env");
    const signer = signers[0];
    const owners = await multicall(p, [...new Set(ops.map((o) => o.to))].map((t) => ({ target: t, data: IDEX.encodeFunctionData("owner") })));
    for (const [i, t] of [...new Set(ops.map((o) => o.to))].entries()) {
        const owner = lc(decode<string>(IDEX, "owner", owners[i]) ?? ZERO);
        if (owner !== lc(signer.address)) throw new Error(`signer ${signer.address} does not own ${t} (owner ${owner})`);
    }

    console.log(`\nsending as ${signer.address}`);
    for (const [i, o] of ops.entries()) {
        const tx = await signer.sendTransaction({ to: o.to, data: o.data });
        const rcpt = await tx.wait();
        console.log(`  ${i + 1}/${ops.length} ${o.kind} ${o.what} -> ${rcpt.transactionHash}`);
    }

    // the manifest is the record of intent, so move it with the chain
    for (const { pr } of keep) {
        const entry = m.paths.find((x) => lc(x.sellToken) === lc(pr.sellToken) && lc(x.buyToken) === lc(pr.buyToken));
        if (!entry) continue;
        entry.dex = pr.proposed.dex;
        entry.path = pr.proposed.path;
        entry.symbols = pr.proposed.path.map(sym).join(" > ");
    }
    saveManifest(m);
    console.log("\nmanifest updated — run `yarn registry:audit` to confirm");
}

/** Rebuild a registered route with whatever params the dex currently holds. */
async function routeFromChain(p: any, dex: DexEntry, tokens: string[]): Promise<Route> {
    const r: Route = { dex, tokens, tiers: [], stable: [], factories: [], label: dex.name };
    if (dex.kind === "univ2") return r;
    const calls: Call[] = [];
    for (let i = 0; i < tokens.length - 1; i++) {
        const a = tokens[i], b = tokens[i + 1];
        if (dex.kind === "uniV3") calls.push({ target: dex.address, data: IDEX.encodeFunctionData("pairFee", [a, b]) });
        else if (dex.kind === "cl") calls.push({ target: dex.address, data: IDEX.encodeFunctionData("tickSpacing", [a, b]) });
        else {
            calls.push({ target: dex.address, data: IDEX.encodeFunctionData("stable", [a, b]) });
            calls.push({ target: dex.address, data: IDEX.encodeFunctionData("factory", [a, b]) });
        }
    }
    const res = await multicall(p, calls);
    let k = 0;
    for (let i = 0; i < tokens.length - 1; i++) {
        if (dex.kind === "uniV3") r.tiers[i] = Number(decode<any>(IDEX, "pairFee", res[k++]) ?? dex.defaultFee ?? 0);
        else if (dex.kind === "cl") r.tiers[i] = Number(decode<any>(IDEX, "tickSpacing", res[k++]) ?? 0);
        else {
            r.stable![i] = decode<boolean>(IDEX, "stable", res[k++]) ?? false;
            r.factories![i] = decode<string>(IDEX, "factory", res[k++]) ?? ZERO;
        }
    }
    return r;
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
