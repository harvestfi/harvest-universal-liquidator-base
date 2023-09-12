// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/curve/ICurvePool.sol";

// libraries
import "../../libraries/Addresses.sol";

// constants and types
import {CurveDexStorage} from "../storage/CurveDex.sol";

contract CurveDex is Ownable, ILiquidityDex, CurveDexStorage {
    using SafeERC20 for IERC20;

    function doSwap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver,
        address[] memory _path
    ) external override returns (uint256) {
        uint256 sellAmount = _sellAmount;
        uint256 minBuyAmount;
        address receiver;

        for (uint256 idx; idx < _path.length - 1; ) {
            if (idx != _path.length - 2) {
                minBuyAmount = 1;
                receiver = address(this);
            } else {
                minBuyAmount = _minBuyAmount;
                receiver = _receiver;
            }

            address sellToken = _path[idx];
            address buyToken = _path[idx + 1];
            address pool_ = pool(sellToken, buyToken);
            uint256 nTokens_ = nTokens(pool_);

            uint256 sellIdx;
            uint256 buyIdx;
            for (uint256 i = 0; i < nTokens_; i++) {
                address token = ICurvePool(pool_).coins(i);
                if (token == sellToken) {
                    sellIdx = i;
                } else if (token == buyToken) {
                    buyIdx = i;
                }
            }

            IERC20(sellToken).safeIncreaseAllowance(
                pool_,
                sellAmount
            );

            if (useUnderlying(pool_)) {
                ICurvePool(pool_).exchange_underlying(
                    sellIdx,
                    buyIdx,
                    sellAmount,
                    minBuyAmount,
                    receiver
                );
            } else if (ethPool(pool_)) {
                ICurvePool(pool_).exchange(
                    sellIdx,
                    buyIdx,
                    sellAmount,
                    minBuyAmount,
                    false,
                    receiver
                );
            } else {
                ICurvePool(pool_).exchange(
                    sellIdx,
                    buyIdx,
                    sellAmount,
                    minBuyAmount,
                    receiver
                );
            }

            sellAmount = IERC20(buyToken).balanceOf(address(this));
            unchecked {
                ++idx;
            }
        }
    }

    function setPool(
        address _token0,
        address _token1,
        address _poolAddr,
        uint256 __nTokens,
        bool __useUnderlying,
        bool __ethPool
    ) external onlyOwner {
        _pool[_token0][_token1] = _poolAddr;
        _pool[_token1][_token0] = _poolAddr;
        _nTokens[_poolAddr] = __nTokens;
        _useUnderlying[_poolAddr] = __useUnderlying;
        _ethPool[_poolAddr] = __ethPool;
    }

    function pool(
        address _token0,
        address _token1
    ) public view returns (address) {
        return _pool[_token0][_token1];
    }

    function nTokens(address _pool) public view returns (uint256) {
        return _nTokens[_pool];
    }

    function useUnderlying(address _pool) public view returns (bool) {
        return _useUnderlying[_pool];
    }

    function ethPool(address _pool) public view returns (bool) {
        return _ethPool[_pool];
    }

    receive() external payable {}
}
