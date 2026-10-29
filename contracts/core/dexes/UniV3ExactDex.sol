// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/uniswap/ISwapRouter02.sol";

// libraries
import "../../libraries/Addresses.sol";

// constants and types
import {UniswapV3DexStorage} from "../storage/UniswapV3Dex.sol";

/**
 * Uniswap V3 dex that swaps one hop at a time and reverts unless every pool takes the whole input.
 *
 * UniV3Dex hands the full path to SwapRouter02.exactInput. When a pool runs out of liquidity the
 * router stops that hop at the price limit, keeps the unspent input and still returns success, so a
 * minimum output of 1 lets the swap through and anyone can sweepToken the remainder. Here every
 * intermediate output comes back to this contract, the next hop spends exactly that amount, and a
 * hop that leaves any input behind reverts with PartialFill. There is no default fee tier: a pair
 * without one reverts instead of routing into a pool that may not exist yet.
 */
contract UniV3ExactDex is Ownable, ILiquidityDex, UniswapV3DexStorage {
    using SafeERC20 for IERC20;

    error PartialFill(address token, uint256 consumed, uint256 amountIn);
    error FeeNotSet(address token0, address token1);

    function doSwap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver,
        address[] memory _path
    ) external override returns (uint256) {
        uint256 amount = _sellAmount;
        uint256 lastHop = _path.length - 1;
        for (uint256 idx; idx < lastHop; ) {
            bool isLast = idx + 1 == lastHop;
            amount = _swapHop(
                _path[idx],
                _path[idx + 1],
                amount,
                isLast ? _minBuyAmount : 1,
                isLast ? _receiver : address(this)
            );
            unchecked {
                ++idx;
            }
        }
        return amount;
    }

    function _swapHop(
        address _tokenIn,
        address _tokenOut,
        uint256 _amountIn,
        uint256 _minAmountOut,
        address _recipient
    ) internal returns (uint256 amountOut) {
        uint24 fee = _pairFee[_tokenIn][_tokenOut];
        if (fee == 0) revert FeeNotSet(_tokenIn, _tokenOut);

        uint256 balanceBefore = IERC20(_tokenIn).balanceOf(address(this));
        IERC20(_tokenIn).safeIncreaseAllowance(
            Addresses.uniswapV3Router,
            _amountIn
        );
        amountOut = ISwapRouter02(Addresses.uniswapV3Router).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: _tokenIn,
                tokenOut: _tokenOut,
                fee: fee,
                recipient: _recipient,
                amountIn: _amountIn,
                amountOutMinimum: _minAmountOut,
                sqrtPriceLimitX96: 0
            })
        );

        uint256 consumed = balanceBefore -
            IERC20(_tokenIn).balanceOf(address(this));
        if (consumed != _amountIn)
            revert PartialFill(_tokenIn, consumed, _amountIn);
    }

    function pairFee(
        address _sellToken,
        address _buyToken
    ) public view returns (uint24 fee) {
        return _pairFee[_sellToken][_buyToken];
    }

    function setFee(
        address _token0,
        address _token1,
        uint24 _fee
    ) external onlyOwner {
        _pairFee[_token0][_token1] = _fee;
        _pairFee[_token1][_token0] = _fee;
    }

    receive() external payable {}
}
