import { ethers } from "hardhat";
import { providers, utils } from "ethers";
import fs from "fs";
import path from "path";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const MANIFEST = path.resolve(__dirname, "../../helpers/registry.json");
export const ZERO = "0x0000000000000000000000000000000000000000";

// One multicall carries many staticcalls, so the whole audit fits in a handful
// of eth_call requests instead of thousands.
const CHUNK = 250;
// Quoter calls burn real gas inside eth_call, so they need far smaller batches.
export const QUOTE_CHUNK = 8;

export type DexKind =
    | "uniV3"     // uniswap v3 style, uint24 fee per pair
    | "cl"        // slipstream style, int24 tickSpacing per pair
    | "solidly"   // aerodrome style, (stable, factory) per pair
    | "univ2"     // constant product router, no per-pair config
    | "curve"
    | "balancer"
    | "erc4626"
    | "unknown";

export interface DexEntry {
    name: string;
    kind: DexKind;
    hex: string;
    address: string;
    poolFactory?: string;
    router?: string;
    vault?: string;
    quoter?: string;
    defaultFee?: number;
    /** uniV3 fee tiers / CL tick spacings worth probing for alternative routes */
    tiers?: number[];
}

export interface PathEntry {
    sellToken: string;
    buyToken: string;
    symbols: string;
    dex: string;
    path: string[];
}

export interface Manifest {
    network: string;
    registry: string;
    universalLiquidator: string;
    owner: string;
    generatedAtBlock: number;
    intermediateTokens: string[];
    tokens: Record<string, string>;
    minLiquidity: Record<string, string>;
    dexes: DexEntry[];
    paths: PathEntry[];
}

export const IREGISTRY = new utils.Interface([
    "function getAllDexes() view returns (bytes32[])",
    "function getAllIntermediateTokens() view returns (address[])",
    "function owner() view returns (address)",
    "function dexesInfo(bytes32) view returns (address)",
    "function paths(address,address) view returns (bytes32)",
    "function getPath(address,address) view returns (tuple(address dex, address[] paths)[])",
    "function addDex(bytes32,address)",
    "function changeDexAddress(bytes32,address)",
    "function setPath(bytes32,address[])",
    "function setIntermediateToken(address[])",
]);

export const IERC20 = new utils.Interface([
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
]);

export const IDEX = new utils.Interface([
    "function tickSpacing(address,address) view returns (int24)",
    "function pairFee(address,address) view returns (uint24)",
    "function pool(address,address) view returns (address)",
    "function factory(address,address) view returns (address)",
    "function stable(address,address) view returns (bool)",
    "function nTokens(address) view returns (uint256)",
    "function router() view returns (address)",
]);

// pool(address,address) returns bytes32 on BalancerDex and address on CurveDex.
// Same selector, so encode with IDEX and decode with whichever matches the kind.
export const IBALANCER_DEX = new utils.Interface([
    "function pool(address,address) view returns (bytes32)",
]);

export const IFACTORY = new utils.Interface([
    "function getPool(address,address,int24) view returns (address)",
    "function getPool(address,address,uint24) view returns (address)",
    "function getPair(address,address) view returns (address)",
]);

export const IAERO_ROUTER = new utils.Interface([
    "function poolFor(address,address,bool,address) view returns (address)",
    "function getAmountsOut(uint256,tuple(address from, address to, bool stable, address factory)[]) view returns (uint256[])",
]);

export const IBVAULT = new utils.Interface([
    "function getPoolTokens(bytes32) view returns (address[], uint256[], uint256)",
]);

export const IQUOTER = new utils.Interface([
    "function quoteExactInput(bytes,uint256) returns (uint256 amountOut, uint160[] sqrtPriceX96After, uint32[] initializedTicksCrossed, uint256 gasEstimate)",
]);

export const IV2ROUTER = new utils.Interface([
    "function getAmountsOut(uint256,address[]) view returns (uint256[])",
]);

export const ICLFACTORY = new utils.Interface([
    "function tickSpacings() view returns (int24[])",
]);

const IMULTICALL = new utils.Interface([
    "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[]) payable returns (tuple(bool success, bytes returnData)[])",
]);

export interface Call { target: string; data: string }
export interface Res { success: boolean; data: string }

export function provider(): providers.Provider {
    const url = process.env.REGISTRY_RPC_URL;
    return url ? new providers.JsonRpcProvider(url) : ethers.provider;
}

export async function multicall(p: providers.Provider, calls: Call[], chunk = CHUNK): Promise<Res[]> {
    const out: Res[] = [];
    for (let i = 0; i < calls.length; i += chunk) out.push(...await run(p, calls.slice(i, i + chunk)));
    return out;
}

/**
 * Quoter calls burn real gas inside eth_call and their cost varies wildly, so a
 * fixed batch size either wastes round trips or blows the node's gas cap. Halve
 * the batch on failure instead and let it find its own size.
 */
async function run(p: providers.Provider, slice: Call[]): Promise<Res[]> {
    if (!slice.length) return [];
    const data = IMULTICALL.encodeFunctionData("aggregate3", [
        slice.map((c) => ({ target: c.target, allowFailure: true, callData: c.data })),
    ]);
    try {
        const raw = await p.call({ to: MULTICALL3, data });
        const [decoded] = IMULTICALL.decodeFunctionResult("aggregate3", raw);
        return decoded.map((r: any) => ({ success: r.success, data: r.returnData }));
    } catch (e: any) {
        if (slice.length === 1) return [{ success: false, data: "0x" }];
        const half = Math.ceil(slice.length / 2);
        return [...await run(p, slice.slice(0, half)), ...await run(p, slice.slice(half))];
    }
}

/** Decode a result, returning undefined when the call reverted or produced nothing. */
export function decode<T>(iface: utils.Interface, fn: string, r: Res): T | undefined {
    if (!r.success || r.data === "0x") return undefined;
    try {
        return iface.decodeFunctionResult(fn, r.data)[0] as T;
    } catch {
        return undefined;
    }
}

export function loadManifest(): Manifest {
    return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
}

export function saveManifest(m: Manifest) {
    fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 4) + "\n");
}

export const lc = (a: string) => a.toLowerCase();
export const key = (a: string, b: string) => `${lc(a)}|${lc(b)}`;
export const isZeroHex = (v?: string) => !v || /^0x0+$/.test(v);

export type PathStatus = "ok" | "missing" | "dexMismatch" | "routeMismatch";

export interface PathDiff {
    entry: PathEntry;
    status: PathStatus;
    chainDexHex?: string;
    chainRoute?: string[];
}

export interface ChainPaths {
    /** every ordered pair in the manifest token universe that has a direct path */
    configured: Map<string, string>;
    /** manifest paths classified against the chain */
    diffs: PathDiff[];
    /** pairs configured on chain that the manifest does not list */
    extra: { sellToken: string; buyToken: string; dexHex: string }[];
}

/**
 * Reconcile the manifest against the registry. Shared by the audit and the sync
 * script so the two can never disagree about what "drifted" means.
 */
export async function readChainPaths(p: providers.Provider, m: Manifest): Promise<ChainPaths> {
    const tokens = Object.keys(m.tokens).map(lc);
    const probes: Call[] = [];
    const pairs: [string, string][] = [];
    for (const a of tokens) for (const b of tokens) {
        if (a === b) continue;
        pairs.push([a, b]);
        probes.push({ target: m.registry, data: IREGISTRY.encodeFunctionData("paths", [a, b]) });
    }
    const probed = await multicall(p, probes);
    const configured = new Map<string, string>();
    probed.forEach((r, i) => {
        const dex = decode<string>(IREGISTRY, "paths", r);
        if (!isZeroHex(dex)) configured.set(key(...pairs[i]), lc(dex!));
    });

    const listed = new Set(m.paths.map((x) => key(x.sellToken, x.buyToken)));
    const extra = [...configured.entries()]
        .filter(([k]) => !listed.has(k))
        .map(([k, dexHex]) => {
            const [sellToken, buyToken] = k.split("|");
            return { sellToken, buyToken, dexHex };
        });

    const full = await multicall(p, m.paths.map((x) => ({
        target: m.registry, data: IREGISTRY.encodeFunctionData("getPath", [x.sellToken, x.buyToken]),
    })));
    const byName = new Map(m.dexes.map((d) => [d.name, d]));
    const diffs: PathDiff[] = m.paths.map((entry, i) => {
        const chainDexHex = configured.get(key(entry.sellToken, entry.buyToken));
        if (!chainDexHex) return { entry, status: "missing" };
        const want = byName.get(entry.dex);
        if (want && chainDexHex !== lc(want.hex)) return { entry, status: "dexMismatch", chainDexHex };
        const legs = decode<any[]>(IREGISTRY, "getPath", full[i]);
        const chainRoute = legs && legs.length === 1 ? (legs[0].paths as string[]).map(lc) : undefined;
        if (!chainRoute || chainRoute.join(",") !== entry.path.map(lc).join(","))
            return { entry, status: "routeMismatch", chainDexHex, chainRoute };
        return { entry, status: "ok", chainDexHex, chainRoute };
    });

    return { configured, diffs, extra };
}
