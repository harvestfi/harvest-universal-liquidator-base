// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/aero/IPool.sol";
import "../../interface/aero/IPoolFactory.sol";

// constants and types
import {AeroDexStorage} from "../storage/AeroDex.sol";

/// @notice Routes through Aero stable and volatile pools.
/// @dev Aero's Metarouter takes encoded commands rather than a route, so this
/// swaps against the pools themselves: the input is moved into the pool and
/// the pool pays out. A pair is configured by naming which factory holds it,
/// since stable and volatile pools come from different factories.
contract AeroDex is Ownable, ILiquidityDex, AeroDexStorage {
    using SafeERC20 for IERC20;

    function doSwap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver,
        address[] memory _path
    ) external override returns (uint256) {
        uint256 amount = _sellAmount;
        uint256 last = _path.length - 1;

        for (uint256 idx = 0; idx < last; ) {
            address tokenIn = _path[idx];
            address tokenOut = _path[idx + 1];
            IPool pool = IPool(
                IPoolFactory(factory(tokenIn, tokenOut)).getPool(
                    tokenIn,
                    tokenOut
                )
            );

            // the fee depends on who is swapping, and that is this contract
            uint256 amountOut = pool.getAmountOutWithTotalFee(amount, tokenIn);
            IERC20(tokenIn).safeTransfer(address(pool), amount);

            address to = idx == last - 1 ? _receiver : address(this);
            if (tokenIn == pool.token0()) {
                pool.swap(0, amountOut, to, new bytes(0));
            } else {
                pool.swap(amountOut, 0, to, new bytes(0));
            }

            amount = amountOut;
            unchecked {
                ++idx;
            }
        }

        require(amount >= _minBuyAmount, "AeroDex: insufficient output");
        return amount;
    }

    function pairSetup(
        address _token0,
        address _token1,
        address _factory
    ) external onlyOwner {
        _pairFactory[_token0][_token1] = _factory;
        _pairFactory[_token1][_token0] = _factory;
    }

    function factory(
        address _token0,
        address _token1
    ) public view returns (address) {
        return _pairFactory[_token0][_token1];
    }

    receive() external payable {}
}
