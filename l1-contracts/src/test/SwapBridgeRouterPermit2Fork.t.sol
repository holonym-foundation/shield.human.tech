// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import "forge-std/Test.sol";
import {SwapBridgeRouter, IUniswapFuelSwap, CleanHandsData, PassportData} from "../SwapBridgeRouter.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {ERC20} from "@oz/token/ERC20/ERC20.sol";

contract ForkMintableToken is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract ForkFeeJuicePortal {
    IERC20 public immutable UNDERLYING;
    constructor(address underlying) { UNDERLYING = IERC20(underlying); }
    function depositToAztecPublic(bytes32, uint256 amount, bytes32) external returns (bytes32, uint256, uint256) {
        UNDERLYING.transferFrom(msg.sender, address(this), amount);
        return (bytes32(uint256(1)), 1, amount);
    }
}

contract ForkTokenPortal {
    IERC20 public immutable token;
    constructor(address underlying) { token = IERC20(underlying); }
    function depositToAztecPublic(bytes32, uint256 amount, bytes32) external returns (bytes32, uint256, uint256) {
        token.transferFrom(msg.sender, address(this), amount);
        return (bytes32(uint256(2)), 2, amount);
    }
}

contract ForkSwap {
    ForkMintableToken public feeJuice;
    constructor(address _feeJuice) { feeJuice = ForkMintableToken(_feeJuice); }
    function swap(address inputToken, uint256 inputAmount, uint256, IUniswapFuelSwap.PoolKey[] calldata, bool[] calldata)
        external
        returns (uint256)
    {
        IERC20(inputToken).transferFrom(msg.sender, address(this), inputAmount);
        feeJuice.mint(msg.sender, inputAmount);
        return inputAmount;
    }
}

contract SwapBridgeRouterPermit2ForkTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 internal constant BRIDGE_WITNESS_TYPEHASH = keccak256(
        "BridgeWitness(address tokenPortal,address bridgeToken,uint256 totalAmount,uint256 fuelAmount,bytes32 aztecRecipient,bytes32 fuelRecipient,bytes32 tokenSecretHash,bytes32 fuelSecretHash,uint256 minFuelOutput,bytes32 routeHash,bool isPrivate)"
    );
    bytes32 internal constant PERMIT_WITNESS_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,BridgeWitness witness)BridgeWitness(address tokenPortal,address bridgeToken,uint256 totalAmount,uint256 fuelAmount,bytes32 aztecRecipient,bytes32 fuelRecipient,bytes32 tokenSecretHash,bytes32 fuelSecretHash,uint256 minFuelOutput,bytes32 routeHash,bool isPrivate)TokenPermissions(address token,uint256 amount)"
    );

    uint256 internal userPk = 0xA11CE;
    address internal user;

    ForkMintableToken internal usdc;
    ForkMintableToken internal feeJuice;
    ForkFeeJuicePortal internal feeJuicePortal;
    ForkTokenPortal internal tokenPortal;
    ForkSwap internal swapTarget;
    SwapBridgeRouter internal router;
    bool internal forkConfigured;

    bytes32 internal constant AZTEC_RECIPIENT = bytes32(uint256(0x1234));
    bytes32 internal constant FUEL_SECRET = bytes32(uint256(0x5678));
    bytes32 internal constant TOKEN_SECRET = bytes32(uint256(0x9ABC));

    function setUp() public {
        string memory rpcUrl = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            return;
        }

        vm.createSelectFork(rpcUrl);
        forkConfigured = true;
        user = vm.addr(userPk);

        usdc = new ForkMintableToken("USDC", "USDC");
        feeJuice = new ForkMintableToken("FeeJuice", "FJ");
        feeJuicePortal = new ForkFeeJuicePortal(address(feeJuice));
        tokenPortal = new ForkTokenPortal(address(usdc));
        swapTarget = new ForkSwap(address(feeJuice));
        router = new SwapBridgeRouter(PERMIT2, address(feeJuicePortal), address(swapTarget));

        usdc.mint(user, 1_000e6);
        vm.prank(user);
        usdc.approve(PERMIT2, type(uint256).max);
    }

    function testFork_permitWitnessBridgeWithFuel() public {
        if (!forkConfigured) return;

        SwapBridgeRouter.BridgeParams memory p = _defaultBridgeParams(100e6, 10e6);
        SwapBridgeRouter.PermitParams memory permit = _signPermitWitness(p);

        vm.prank(user);
        router.bridgeWithFuel(p, permit);

        assertEq(usdc.balanceOf(address(tokenPortal)), 90e6, "token portal amount");
        assertEq(feeJuice.balanceOf(address(feeJuicePortal)), 10e6, "fee juice amount");
    }

    function testFork_revertOnWitnessTamper() public {
        if (!forkConfigured) return;

        SwapBridgeRouter.BridgeParams memory p = _defaultBridgeParams(100e6, 10e6);
        SwapBridgeRouter.PermitParams memory permit = _signPermitWitness(p);
        p.aztecRecipient = bytes32(uint256(0xDEAD));

        vm.prank(user);
        vm.expectRevert();
        router.bridgeWithFuel(p, permit);
    }

    function _defaultBridgeParams(uint256 totalAmount, uint256 fuelAmount)
        internal
        view
        returns (SwapBridgeRouter.BridgeParams memory)
    {
        IUniswapFuelSwap.PoolKey[] memory path = new IUniswapFuelSwap.PoolKey[](1);
        path[0] = IUniswapFuelSwap.PoolKey({
            currency0: address(usdc),
            currency1: address(feeJuice),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        bool[] memory zeroForOnes = new bool[](1);
        zeroForOnes[0] = true;

        return SwapBridgeRouter.BridgeParams({
            tokenPortal: address(tokenPortal),
            bridgeToken: address(usdc),
            totalAmount: totalAmount,
            fuelAmount: fuelAmount,
            aztecRecipient: AZTEC_RECIPIENT,
            fuelRecipient: AZTEC_RECIPIENT,
            tokenSecretHash: TOKEN_SECRET,
            fuelSecretHash: FUEL_SECRET,
            minFuelOutput: 0,
            path: path,
            zeroForOnes: zeroForOnes,
            isPrivate: false,
            cleanHands: CleanHandsData({nonce: 0, actionId: 0, signature: ""}),
            passport: PassportData({maxAmount: 0, nonce: 0, deadline: 0, signature: ""})
        });
    }

    function _signPermitWitness(SwapBridgeRouter.BridgeParams memory p)
        internal
        view
        returns (SwapBridgeRouter.PermitParams memory)
    {
        uint256 nonce = 0x0102;
        uint256 deadline = block.timestamp + 30 minutes;
        bytes32 routeHash = keccak256(abi.encode(p.path, p.zeroForOnes));
        bytes32 witness = keccak256(
            abi.encode(
                BRIDGE_WITNESS_TYPEHASH,
                p.tokenPortal,
                p.bridgeToken,
                p.totalAmount,
                p.fuelAmount,
                p.aztecRecipient,
                p.fuelRecipient,
                p.tokenSecretHash,
                p.fuelSecretHash,
                p.minFuelOutput,
                routeHash,
                p.isPrivate
            )
        );
        bytes32 tokenPermissionsHash = keccak256(
            abi.encode(TOKEN_PERMISSIONS_TYPEHASH, p.bridgeToken, p.totalAmount)
        );
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_WITNESS_TRANSFER_FROM_TYPEHASH,
                tokenPermissionsHash,
                address(router),
                nonce,
                deadline,
                witness
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                _domainSeparator(),
                structHash
            )
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return SwapBridgeRouter.PermitParams({
            nonce: nonce,
            deadline: deadline,
            signature: bytes.concat(r, s, bytes1(v))
        });
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Permit2")),
                block.chainid,
                PERMIT2
            )
        );
    }
}
