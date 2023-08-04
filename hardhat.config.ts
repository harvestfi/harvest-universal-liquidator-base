import "hardhat-gas-reporter"
import "solidity-coverage";
import "@nomicfoundation/hardhat-toolbox"
import { config as dotenvConfig } from "dotenv"
import { HardhatUserConfig } from "hardhat/config"
import { NetworksUserConfig } from "hardhat/types"
import { resolve } from "path"
import { config } from "./package.json"

dotenvConfig({ path: resolve(__dirname, "./.env") })

function getNetworks(): NetworksUserConfig {
  const accounts = process.env.MNEMONIC ? { mnemonic: process.env.MNEMONIC } : [];

  return {
    hardhat: {
      accounts: accounts,
      forking: {
        url: `https://developer-access-mainnet.base.org`,
        // blockNumber: 82350734, // <-- edit here
      },
    },
    mainnet: {
      url: `https://developer-access-mainnet.base.org`,
      accounts: accounts,
    },
  }
}

const hardhatConfig: HardhatUserConfig = {
  solidity: config.solidity,
  paths: {
    sources: config.paths.contracts,
    tests: config.paths.tests,
    cache: config.paths.cache,
    artifacts: config.paths.build.contracts,
  },
  networks: {
    ...getNetworks(),
  },
  typechain: {
    outDir: config.paths.build.typechain,
    target: "ethers-v5",
  },
  etherscan: {
    apiKey: {
      base: `${process.env.BASESCAN_API_KEY}`
    },
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.com"
        }
      }
    ]
  },
  gasReporter: {
    enabled: (process.env.REPORT_GAS) ? true : false
  },
  mocha: {
    timeout: 1200 * 1e3,
  },
}

export default hardhatConfig