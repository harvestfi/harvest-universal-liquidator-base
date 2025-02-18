// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/aerodrome/ISwapRouter.sol";

// libraries
import "../../libraries/Addresses.sol";

// constants and types
import {AeroCLDexStorage} from "../storage/AeroCLDex.sol";

contract AeroCLDex is Ownable, ILiquidityDex, AeroCLDexStorage {
    using SafeERC20 for IERC20;

    function doSwap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver,
        address[] memory _path
    ) external override returns (uint256) {
        address sellToken = _path[0];

        IERC20(sellToken).safeIncreaseAllowance(
            Addresses.aeroCLRouter,
            _sellAmount
        );

        bytes memory encodedPath = abi.encodePacked(sellToken);
        for (uint256 idx = 1; idx < _path.length; ) {
            encodedPath = abi.encodePacked(
                encodedPath,
                tickSpacing(_path[idx - 1], _path[idx]),
                _path[idx]
            );
            unchecked {
                ++idx;
            }
        }

        ISwapRouter.ExactInputParams memory param = ISwapRouter
            .ExactInputParams({
                path: encodedPath,
                recipient: _receiver,
                amountIn: _sellAmount,
                amountOutMinimum: _minBuyAmount,
                deadline: block.timestamp
            });

        return ISwapRouter(Addresses.aeroCLRouter).exactInput(param);
    }

    function tickSpacing(
        address _sellToken,
        address _buyToken
    ) public view returns (int24) {
        return _tickSpacing[_sellToken][_buyToken];
    }

    function setTickSpacing(
        address _token0,
        address _token1,
        int24 _spacing
    ) external onlyOwner {
        _tickSpacing[_token0][_token1] = _spacing;
        _tickSpacing[_token1][_token0] = _spacing;
    }

    receive() external payable {}
}
