// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/// @notice An Aero pool factory. Stable and volatile pools each have their own.
interface IPoolFactory {
    function getPool(
        address tokenA,
        address tokenB
    ) external view returns (address);
}
