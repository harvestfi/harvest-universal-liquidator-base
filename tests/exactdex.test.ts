// UniV3ExactDex against the live Base pools at the block before the RewardForwarder fee distribution
// 0x8b33f163... (2026-10-23). That transaction sold 0.304461543030811641 WETH along
// WETH -> FARM -> iFARM through UniV3Dex: the FARM/iFARM pool ran dry after 55.53 FARM, SwapRouter02
// kept the other 29.18 FARM, and a bot swept it in the next transaction. The control test replays that
// with the live UniV3Dex; the rest show the exact dex reverting instead and behaving identically otherwise.
//
// Run with ALCHEMEY_KEY set (the worktree has no .env).

import addresses from "../helpers/addresses.json";

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { BigNumber, Contract } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

const FORK_BLOCK = 52987864;

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FARM = "0xD08a2917653d4E460893203471f0000826fb4034";
const IFARM = "0xE7798f023fC62146e8Aa1b36Da45fb70855a77Ea";
const ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
// holds the 1037.8 USDC of fees that the incident distributed
const REWARD_FORWARDER = "0x1695A1BE5E2D67554baaeC18d97F2d1f92271718";

const INCIDENT_WETH = BigNumber.from("304461543030811641");
const INCIDENT_FARM_OUT = BigNumber.from("84707748345404809283");
const INCIDENT_FARM_INTO_POOL = BigNumber.from("55532382968625015932");
const INCIDENT_IFARM_OUT = BigNumber.from("30234170614579381197");
const INCIDENT_USDC = BigNumber.from("726458067");
const SMALL_WETH = ethers.utils.parseEther("0.02");

const UNIV3_ID = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("uniV3"));
const EXACT_ID = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("uniV3Exact"));

describe("UniV3ExactDex: partial fills revert (fork at block 52987864)", function () {
    let deployer: SignerWithAddress;
    let receiver: SignerWithAddress;
    let ulOwner: SignerWithAddress;
    let weth: Contract, farm: Contract, ifarm: Contract, usdc: Contract;
    let registry: Contract, liquidator: Contract;
    let liveDex: Contract, exactDex: Contract;
    let snapshotId: string;

    before(async function () {
        if (!process.env.ALCHEMEY_KEY) throw new Error("ALCHEMEY_KEY is not set");
        await network.provider.request({
            method: "hardhat_reset",
            params: [{
                forking: {
                    jsonRpcUrl: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMEY_KEY}`,
                    blockNumber: FORK_BLOCK,
                },
            }],
        });
        // this config has no hardfork history for chain 8453, so calls cannot run on the fork block itself
        await network.provider.send("hardhat_mine", ["0x1"]);

        // impersonated throwaway accounts, so the test needs no mnemonic
        const signer = async (addr: string) => {
            await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
            await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]); // 100 ETH
            return ethers.getSigner(addr);
        };
        deployer = await signer("0x00000000000000000000000000000000000de901");
        receiver = await signer("0x00000000000000000000000000000000000de902");
        ulOwner = await signer(addresses.Governance);

        const erc20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20";
        weth = await ethers.getContractAt(["function deposit() payable", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], WETH);
        farm = await ethers.getContractAt(erc20, FARM);
        ifarm = await ethers.getContractAt(erc20, IFARM);
        usdc = await ethers.getContractAt(erc20, USDC);
        registry = await ethers.getContractAt("UniversalLiquidatorRegistry", addresses.UniversalLiquidatorRegistryAddr);
        liquidator = await ethers.getContractAt("UniversalLiquidator", addresses.UniversalLiquidatorAddr);
        liveDex = await ethers.getContractAt("UniV3Dex", await registry.dexesInfo(UNIV3_ID));

        exactDex = await (await ethers.getContractFactory("UniV3ExactDex", deployer)).deploy();
        await exactDex.deployed();
        await exactDex.setFee(WETH, FARM, 3000);
        await exactDex.setFee(FARM, IFARM, 3000);
        await exactDex.setFee(USDC, WETH, 100);

        await weth.connect(deployer).deposit({ value: ethers.utils.parseEther("2") });
        snapshotId = await network.provider.send("evm_snapshot", []);
    });

    afterEach(async function () {
        await network.provider.send("evm_revert", [snapshotId]);
        snapshotId = await network.provider.send("evm_snapshot", []);
    });

    it("control: UniV3Dex leaves the unspent FARM in SwapRouter02", async function () {
        expect(await liveDex.pairFee(WETH, FARM)).to.equal(3000);
        expect(await liveDex.pairFee(FARM, IFARM)).to.equal(3000);
        const routerFarmBefore = await farm.balanceOf(ROUTER);

        await weth.connect(deployer).transfer(liveDex.address, INCIDENT_WETH);
        await liveDex.connect(deployer).doSwap(INCIDENT_WETH, 1, receiver.address, [WETH, FARM, IFARM]);

        // exactly the incident: 84.71 FARM bought, 55.53 FARM taken by the pool, the rest stranded
        expect(await ifarm.balanceOf(receiver.address)).to.equal(INCIDENT_IFARM_OUT);
        expect((await farm.balanceOf(ROUTER)).sub(routerFarmBefore)).to.equal(INCIDENT_FARM_OUT.sub(INCIDENT_FARM_INTO_POOL));
    });

    it("reverts with PartialFill at the incident size", async function () {
        const routerFarmBefore = await farm.balanceOf(ROUTER);
        await weth.connect(deployer).transfer(exactDex.address, INCIDENT_WETH);

        await expect(exactDex.doSwap(INCIDENT_WETH, 1, receiver.address, [WETH, FARM, IFARM]))
            .to.be.revertedWithCustomError(exactDex, "PartialFill")
            .withArgs(FARM, INCIDENT_FARM_INTO_POOL, INCIDENT_FARM_OUT);

        expect(await farm.balanceOf(ROUTER)).to.equal(routerFarmBefore);
        expect(await ifarm.balanceOf(receiver.address)).to.equal(0);
    });

    it("reverts with PartialFill on an intermediate hop too, keeping the input in the dex", async function () {
        // the incident's FARM, bought into the dex itself
        await weth.connect(deployer).transfer(exactDex.address, INCIDENT_WETH);
        await exactDex.doSwap(INCIDENT_WETH, 1, exactDex.address, [WETH, FARM]);
        expect(await farm.balanceOf(exactDex.address)).to.equal(INCIDENT_FARM_OUT);

        // hop 1 of 2 pays the dex itself; the FARM/iFARM pool still takes only 55.53 FARM
        await expect(exactDex.doSwap(INCIDENT_FARM_OUT, 1, receiver.address, [FARM, IFARM, FARM]))
            .to.be.revertedWithCustomError(exactDex, "PartialFill")
            .withArgs(FARM, INCIDENT_FARM_INTO_POOL, INCIDENT_FARM_OUT);
        expect(await farm.balanceOf(exactDex.address)).to.equal(INCIDENT_FARM_OUT);
        expect(await ifarm.balanceOf(exactDex.address)).to.equal(0);
    });

    it("gives the same output as UniV3Dex when every hop fills, and keeps nothing", async function () {
        await weth.connect(deployer).transfer(exactDex.address, SMALL_WETH);
        await exactDex.doSwap(SMALL_WETH, 1, receiver.address, [WETH, FARM, IFARM]);
        const exactOut = await ifarm.balanceOf(receiver.address);
        expect(exactOut).to.be.gt(0);
        expect(await weth.balanceOf(exactDex.address)).to.equal(0);
        expect(await farm.balanceOf(exactDex.address)).to.equal(0);

        await network.provider.send("evm_revert", [snapshotId]);
        snapshotId = await network.provider.send("evm_snapshot", []);

        const routerFarmBefore = await farm.balanceOf(ROUTER);
        await weth.connect(deployer).transfer(liveDex.address, SMALL_WETH);
        await liveDex.connect(deployer).doSwap(SMALL_WETH, 1, receiver.address, [WETH, FARM, IFARM]);
        expect(await ifarm.balanceOf(receiver.address)).to.equal(exactOut);
        expect(await farm.balanceOf(ROUTER)).to.equal(routerFarmBefore);
    });

    it("enforces the minimum output on the last hop", async function () {
        await weth.connect(deployer).transfer(exactDex.address, SMALL_WETH);
        const quote = await exactDex.callStatic.doSwap(SMALL_WETH, 1, receiver.address, [WETH, FARM, IFARM]);

        await expect(exactDex.doSwap(SMALL_WETH, quote.add(1), receiver.address, [WETH, FARM, IFARM]))
            .to.be.revertedWith("Too little received");
        await exactDex.doSwap(SMALL_WETH, quote, receiver.address, [WETH, FARM, IFARM]);
        expect(await ifarm.balanceOf(receiver.address)).to.equal(quote);
    });

    it("reverts with FeeNotSet for a pair without a fee tier", async function () {
        await weth.connect(deployer).transfer(exactDex.address, SMALL_WETH);
        await expect(exactDex.doSwap(SMALL_WETH, 1, receiver.address, [WETH, IFARM]))
            .to.be.revertedWithCustomError(exactDex, "FeeNotSet")
            .withArgs(WETH, IFARM);
    });

    it("only the owner can set fees", async function () {
        await expect(exactDex.connect(receiver).setFee(WETH, IFARM, 500))
            .to.be.revertedWith("Ownable: caller is not the owner");
        expect(await exactDex.pairFee(WETH, IFARM)).to.equal(0);
    });

    it("through the UniversalLiquidator: the incident USDC sale reverts, a small one goes through", async function () {
        await registry.connect(ulOwner).addDex(EXACT_ID, exactDex.address);
        await registry.connect(ulOwner).setPath(EXACT_ID, [WETH, FARM, IFARM]);

        // at this block USDC -> iFARM has no direct entry, so it composes [USDC, WETH] on uniV3
        // with the [WETH, FARM, iFARM] entry that now points at the exact dex (see the last test for the
        // direct entry the live registry has had since block 53155748)
        const route = await registry.getPath(USDC, IFARM);
        expect(route.length).to.equal(2);
        expect(route[1].dex).to.equal(exactDex.address);

        await network.provider.request({ method: "hardhat_impersonateAccount", params: [REWARD_FORWARDER] });
        await network.provider.send("hardhat_setBalance", [REWARD_FORWARDER, "0x8AC7230489E80000"]);
        const forwarder = await ethers.getSigner(REWARD_FORWARDER);
        await usdc.connect(forwarder).approve(liquidator.address, INCIDENT_USDC);
        const routerFarmBefore = await farm.balanceOf(ROUTER);

        await expect(liquidator.connect(forwarder).swap(USDC, IFARM, INCIDENT_USDC, 1, receiver.address))
            .to.be.revertedWithCustomError(exactDex, "PartialFill");
        expect(await farm.balanceOf(ROUTER)).to.equal(routerFarmBefore);

        const small = BigNumber.from("50000000"); // 50 USDC
        await usdc.connect(forwarder).approve(liquidator.address, small);
        await liquidator.connect(forwarder).swap(USDC, IFARM, small, 1, receiver.address);
        expect(await ifarm.balanceOf(receiver.address)).to.be.gt(0);
        expect(await farm.balanceOf(ROUTER)).to.equal(routerFarmBefore);
        expect(await weth.balanceOf(exactDex.address)).to.equal(0);
        expect(await farm.balanceOf(exactDex.address)).to.equal(0);
    });

    it("a direct USDC -> iFARM entry wins over the WETH one, so it must move to the exact dex as well", async function () {
        // since block 53155748 the live registry holds this entry on the old uniV3 dex; a direct entry is
        // returned before any intermediate route, so moving only [WETH, FARM, iFARM] leaves USDC exposed
        await registry.connect(ulOwner).setPath(UNIV3_ID, [USDC, WETH, FARM, IFARM]);
        let route = await registry.getPath(USDC, IFARM);
        expect(route.length).to.equal(1);
        expect(route[0].dex).to.equal(liveDex.address);

        await registry.connect(ulOwner).addDex(EXACT_ID, exactDex.address);
        await registry.connect(ulOwner).setPath(EXACT_ID, [USDC, WETH, FARM, IFARM]);
        route = await registry.getPath(USDC, IFARM);
        expect(route.length).to.equal(1);
        expect(route[0].dex).to.equal(exactDex.address);

        await network.provider.request({ method: "hardhat_impersonateAccount", params: [REWARD_FORWARDER] });
        await network.provider.send("hardhat_setBalance", [REWARD_FORWARDER, "0x8AC7230489E80000"]);
        const forwarder = await ethers.getSigner(REWARD_FORWARDER);
        await usdc.connect(forwarder).approve(liquidator.address, INCIDENT_USDC);
        const routerFarmBefore = await farm.balanceOf(ROUTER);
        await expect(liquidator.connect(forwarder).swap(USDC, IFARM, INCIDENT_USDC, 1, receiver.address))
            .to.be.revertedWithCustomError(exactDex, "PartialFill");
        expect(await farm.balanceOf(ROUTER)).to.equal(routerFarmBefore);
    });
});
