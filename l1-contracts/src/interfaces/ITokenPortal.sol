// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

struct CleanHandsData {
    uint256 nonce;
    bytes signature;
}

struct PassportData {
    uint256 maxAmount;
    uint256 nonce;
    uint256 deadline;
    bytes signature;
}

interface ITokenPortal {
    function depositToAztecPublic(
        bytes32 _to,
        uint256 _amount,
        bytes32 _secretHash,
        CleanHandsData calldata _cleanHands,
        PassportData calldata _passport
    ) external returns (bytes32 key, uint256 index, uint256 amountAfterFee);

    function depositToAztecPublicFor(
        address _depositor,
        bytes32 _to,
        uint256 _amount,
        bytes32 _secretHash,
        CleanHandsData calldata _cleanHands,
        PassportData calldata _passport
    ) external returns (bytes32 key, uint256 index, uint256 amountAfterFee);
}
