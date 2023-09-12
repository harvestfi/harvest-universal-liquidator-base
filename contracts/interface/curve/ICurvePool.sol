// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

interface ICurvePool {
    function exchange(
        uint256 i,
        uint256 j,
        uint256 dx,
        uint256 min_dy,
        address receiver
    ) external payable returns (uint256);

    function exchange(
        uint256 i,
        uint256 j,
        uint256 dx,
        uint256 min_dy,
        bool use_eth,
        address receiver
    ) external payable returns (uint256);

    function exchange_underlying(
        uint256 i,
        uint256 j,
        uint256 dx,
        uint256 min_dy,
        address receiver
    ) external payable returns (uint256);

    function coins(uint256) external view returns (address);
}
