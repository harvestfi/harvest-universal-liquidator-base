// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/aerodrome/IRouter.sol";

// libraries
import "../../libraries/Addresses.sol";

// constants and types
import {AerodromeDexStorage} from "../storage/AerodromeDex.sol";

contract AerodromeDex is Ownable, ILiquidityDex, AerodromeDexStorage {
    using SafeERC20 for IERC20;

    function doSwap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver,
        address[] memory _path
    ) external override returns (uint256) {
        address sellToken = _path[0];

        IERC20(sellToken).safeIncreaseAllowance(Addresses.aerodromeRouter, _sellAmount);

        IRouter.Route[] memory routes = new IRouter.Route[](_path.length-1);
        for (uint256 idx = 0; idx < _path.length-1; idx++) {
            routes[idx].from = _path[idx];
            routes[idx].to = _path[idx+1];
            routes[idx].stable = stable(_path[idx], _path[idx+1]);
            routes[idx].factory = factory(_path[idx], _path[idx+1]);
        }

        uint256[] memory returned = IRouter(Addresses.aerodromeRouter)
            .swapExactTokensForTokens(
                _sellAmount,
                _minBuyAmount,
                routes,
                _receiver,
                block.timestamp
            );

        return returned[returned.length - 1];
    }

    function pairSetup(
        address _token0,
        address _token1,
        bool _stable,
        address _factory
    ) external onlyOwner {
        _pairStable[_token0][_token1] = _stable;
        _pairFactory[_token0][_token1] = _factory;
        _pairStable[_token1][_token0] = _stable;
        _pairFactory[_token1][_token0] = _factory;
    }

    function stable(
        address _token0,
        address _token1
    ) public view returns (bool) {
        return _pairStable[_token0][_token1];
    }

    function factory(
        address _token0,
        address _token1
    ) public view returns (address) {
        return _pairFactory[_token0][_token1];
    }

    receive() external payable {}
}
