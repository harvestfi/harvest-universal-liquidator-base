// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/// @notice The parts of an Aero stable or volatile pool a swap needs.
interface IPool {
    function token0() external view returns (address);

    /// @notice Output for an input, net of the fee this caller would be charged.
    function getAmountOutWithTotalFee(
        uint256 amountIn,
        address tokenIn
    ) external view returns (uint256);

    /// @notice Pays out optimistically; the input must already sit in the pool.
    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        bytes calldata data
    ) external;
}
