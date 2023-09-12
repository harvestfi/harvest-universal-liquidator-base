// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

abstract contract CurveDexStorage {
    mapping(address => mapping(address => address)) internal _pool;
    mapping(address => uint256) internal _nTokens;
    mapping(address => bool) internal _useUnderlying;
    mapping(address => bool) internal _ethPool;
}
