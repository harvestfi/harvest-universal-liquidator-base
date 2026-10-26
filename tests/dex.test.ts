import addresses from "../helpers/addresses.json";
import fees from "../helpers/fees.json";
import pools from "../helpers/pools.json";

import * as types from "./types";
import * as utils from "./utils";

import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("Dexes: Functionality Tests", function () {
    async function setupAccounts() {
        const accounts = await ethers.getSigners();
        // impersonate accounts
        await utils.impersonates([addresses.Governance]);
        const governance = await ethers.getSigner(addresses.Governance);

        await accounts[9].sendTransaction({
            to: governance.address,
            value: ethers.utils.parseEther("5") // 5 ether
        })

        return { governance };
    }
    describe("Uniswap", function () {
        async function setupDex() {
            const { governance } = await loadFixture(setupAccounts);
            const UniswapDex = await ethers.getContractFactory("UniV3Dex", governance);
            const uniswapDex = await UniswapDex.deploy();
            await uniswapDex.deployed();

            const testFeeList = fees.list.find(dex => dex.name === "uniV3");
            const testFeePair = testFeeList?.pools[0];
            if (!testFeePair) throw new Error(`Could not find the pools`);
            const testSellToken = testFeePair.sellToken.address;
            const testBuyToken = testFeePair.buyToken.address;
            const testFee = testFeePair.fee;
            return { governance, uniswapDex, testSellToken, testBuyToken, testFee };
        }

        describe("Happy Path", function () {
            it("Set fee", async function () {
                const { governance, uniswapDex, testSellToken, testBuyToken, testFee } = await loadFixture(setupDex);
                await uniswapDex.connect(governance).setFee(testSellToken, testBuyToken, testFee);
                expect(await uniswapDex.pairFee(testBuyToken, testSellToken)).to.equal(500);
                expect(await uniswapDex.pairFee(testSellToken, testBuyToken)).to.equal(500);
            });
        });

        describe("Ownership", function () {
            it("Only owner can set fee", async function () {
                const { uniswapDex, testSellToken, testBuyToken, testFee } = await loadFixture(setupDex);
                const testSetFeeTx = uniswapDex.setFee(testSellToken, testBuyToken, testFee);
                expect(testSetFeeTx).to.be.revertedWith("Ownable: caller is not the owner");
            });
        });
    });
    describe("Aero", function () {
        // the new Aero deployment: stable and volatile pools come from separate
        // factories, and naming the factory is the whole pair config
        const VOLATILE_FACTORY = "0x8E6a9FCd1d638CC760Ffba397605Fe3355dE76D2";
        const STABLE_FACTORY = "0x78589E876edcEbdce72ee3436ab3c9AD3a7cEF2D";
        const WETH = "0x4200000000000000000000000000000000000006";
        const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

        async function setupDex() {
            const { governance } = await loadFixture(setupAccounts);
            const AeroDex = await ethers.getContractFactory("AeroDex", governance);
            const aeroDex = await AeroDex.deploy();
            await aeroDex.deployed();
            return { governance, aeroDex };
        }

        describe("Happy Path", function () {
            it("Set factory for a pair, both directions", async function () {
                const { governance, aeroDex } = await loadFixture(setupDex);
                await aeroDex.connect(governance).pairSetup(WETH, USDC, VOLATILE_FACTORY);
                expect(await aeroDex.factory(WETH, USDC)).to.equal(VOLATILE_FACTORY);
                expect(await aeroDex.factory(USDC, WETH)).to.equal(VOLATILE_FACTORY);
                await aeroDex.connect(governance).pairSetup(WETH, USDC, STABLE_FACTORY);
                expect(await aeroDex.factory(USDC, WETH)).to.equal(STABLE_FACTORY);
            });

            it("Swaps through the live volatile pool and pays the receiver", async function () {
                const { governance, aeroDex } = await loadFixture(setupDex);
                await aeroDex.connect(governance).pairSetup(WETH, USDC, VOLATILE_FACTORY);
                // borrow WETH from a different pool: draining the one under test
                // would desync its cached reserves and break the swap
                const pool = "0x4a7af46bc8abc00048c6c7920a1488daf568366c"; // new Aero CL WETH/USDC
                await utils.impersonates([pool]);
                const [faucet] = await ethers.getSigners();
                await ethers.provider.send("hardhat_setBalance", [pool, ethers.utils.hexValue(ethers.utils.parseEther("1"))]);
                const whale = await ethers.getSigner(pool);
                const weth = await ethers.getContractAt("IERC20", WETH);
                const usdc = await ethers.getContractAt("IERC20", USDC);
                const sellAmount = ethers.utils.parseEther("0.1");
                // the liquidator hands the dex the input before calling it
                await weth.connect(whale).transfer(aeroDex.address, sellAmount);
                const receiver = (await ethers.getSigners())[5];
                const before = await usdc.balanceOf(receiver.address);
                const tx = await aeroDex.doSwap(sellAmount, 1, receiver.address, [WETH, USDC]);
                await tx.wait();
                const got = (await usdc.balanceOf(receiver.address)).sub(before);
                // 0.1 WETH is a few hundred USDC; anything in that range proves the pool paid
                expect(got).to.be.gt(ethers.utils.parseUnits("100", 6));
                expect(await weth.balanceOf(aeroDex.address)).to.equal(0);
            });

            it("Reverts when the output is below the minimum", async function () {
                const { governance, aeroDex } = await loadFixture(setupDex);
                await aeroDex.connect(governance).pairSetup(WETH, USDC, VOLATILE_FACTORY);
                const pool = "0x4a7af46bc8abc00048c6c7920a1488daf568366c"; // new Aero CL WETH/USDC, not the pool under test
                await utils.impersonates([pool]);
                const [faucet] = await ethers.getSigners();
                await ethers.provider.send("hardhat_setBalance", [pool, ethers.utils.hexValue(ethers.utils.parseEther("1"))]);
                const whale = await ethers.getSigner(pool);
                const weth = await ethers.getContractAt("IERC20", WETH);
                await weth.connect(whale).transfer(aeroDex.address, ethers.utils.parseEther("0.1"));
                await expect(aeroDex.doSwap(ethers.utils.parseEther("0.1"), ethers.utils.parseUnits("1000000", 6), faucet.address, [WETH, USDC]))
                    .to.be.revertedWith("AeroDex: insufficient output");
            });
        });

        describe("Ownership", function () {
            it("Only owner can set the factory", async function () {
                const { aeroDex } = await loadFixture(setupDex);
                const stranger = (await ethers.getSigners())[7];
                await expect(aeroDex.connect(stranger).pairSetup(WETH, USDC, VOLATILE_FACTORY)).to.be.revertedWith("Ownable: caller is not the owner");
            });
        });
    });
    describe("AeroSlipstream", function () {
        const WETH = "0x4200000000000000000000000000000000000006";
        const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

        async function setupDex() {
            const { governance } = await loadFixture(setupAccounts);
            const Dex = await ethers.getContractFactory("AeroSlipstreamDex", governance);
            const dex = await Dex.deploy();
            await dex.deployed();
            return { governance, dex };
        }

        describe("Happy Path", function () {
            it("Set tick spacing, both directions", async function () {
                const { governance, dex } = await loadFixture(setupDex);
                await dex.connect(governance).setTickSpacing(WETH, USDC, 50);
                expect(await dex.tickSpacing(WETH, USDC)).to.equal(50);
                expect(await dex.tickSpacing(USDC, WETH)).to.equal(50);
            });
        });

        describe("Ownership", function () {
            it("Only owner can set tick spacing", async function () {
                const { dex } = await loadFixture(setupDex);
                const stranger = (await ethers.getSigners())[7];
                await expect(dex.connect(stranger).setTickSpacing(WETH, USDC, 50)).to.be.revertedWith("Ownable: caller is not the owner");
            });
        });
    });
    describe("Curve", function () {
        async function setupDex() {
            const { governance } = await loadFixture(setupAccounts);
            const CurveDex = await ethers.getContractFactory("CurveDex", governance);
            const curveDex = await CurveDex.deploy();
            await curveDex.deployed();

            const testSellToken = "0x417Ac0e078398C154EdFadD9Ef675d30Be60Af93";
            const testBuyToken = "0x4200000000000000000000000000000000000006";
            const testPool = "0x6e53131F68a034873b6bFA15502aF094Ef0c5854";
            const testNTokens = 3
            return { governance, curveDex, testSellToken, testBuyToken, testPool, testNTokens };
        }

        describe("Happy Path", function () {
            it("Set pool", async function () {
                const { governance, curveDex, testSellToken, testBuyToken, testPool, testNTokens } = await loadFixture(setupDex);
                await curveDex.connect(governance).setPool(testSellToken, testBuyToken, testPool, testNTokens);
                expect(await curveDex.pool(testBuyToken, testSellToken)).to.equal(testPool);
                expect(await curveDex.pool(testSellToken, testBuyToken)).to.equal(testPool);
            });
        });
    });
    // describe("Balancer", function () {
    //     async function setupDex() {
    //         const { governance } = await loadFixture(setupAccounts);
    //         const BalancerDex = await ethers.getContractFactory("BalancerDex", governance);
    //         const balancerDex = await BalancerDex.deploy();
    //         await balancerDex.deployed();

    //         const testPoolList = pools.test.find(dex => dex.name === "balancer");
    //         const testPoolPair = testPoolList?.pools[0] as types.IPool;
    //         if (!testPoolPair) throw new Error(`Could not find the pools`);
    //         const testSellToken = testPoolPair.sellToken.address;
    //         const testBuyToken = testPoolPair.buyToken.address;
    //         const testPools = testPoolPair.pools;
    //         if (!testPools) throw new Error(`Could not find the pools`);
    //         return { governance, balancerDex, testSellToken, testBuyToken, testPools };
    //     }

    //     describe("Happy Path", function () {
    //         it("Set poolId", async function () {
    //             const { governance, balancerDex, testSellToken, testBuyToken, testPools } = await loadFixture(setupDex);
    //             await balancerDex.connect(governance).setPool(testSellToken, testBuyToken, testPools[0]);
    //             expect(await balancerDex.pool(testBuyToken, testSellToken)).to.eql(testPools);
    //         });
    //     });

    //     describe("Ownership", function () {
    //         it("Only owner can set poolId", async function () {
    //             const { balancerDex, testSellToken, testBuyToken, testPools } = await loadFixture(setupDex);
    //             const testSetPoolTx = balancerDex.setPool(testSellToken, testBuyToken, testPools[0]);
    //             expect(testSetPoolTx).to.be.revertedWith("Ownable: caller is not the owner");
    //         });
    //     });
    // });
});