// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

abstract contract AeroDexStorage {
    mapping(address => mapping(address => address)) internal _pairFactory;
}
