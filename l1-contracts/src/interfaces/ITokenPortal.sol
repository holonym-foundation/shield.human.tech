// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

interface ITokenPortal {
function depositToAztecPublic(bytes32 _to, uint256 _amount, bytes32 _secretHash)
external
returns (bytes32, uint256);
}
