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
    defaultFee?: number;
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
]);

export const IBVAULT = new utils.Interface([
    "function getPoolTokens(bytes32) view returns (address[], uint256[], uint256)",
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

export async function multicall(p: providers.Provider, calls: Call[]): Promise<Res[]> {
    const out: Res[] = [];
    for (let i = 0; i < calls.length; i += CHUNK) {
        const slice = calls.slice(i, i + CHUNK);
        const data = IMULTICALL.encodeFunctionData("aggregate3", [
            slice.map((c) => ({ target: c.target, allowFailure: true, callData: c.data })),
        ]);
        const raw = await p.call({ to: MULTICALL3, data });
        const [decoded] = IMULTICALL.decodeFunctionResult("aggregate3", raw);
        for (const r of decoded) out.push({ success: r.success, data: r.returnData });
    }
    return out;
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
