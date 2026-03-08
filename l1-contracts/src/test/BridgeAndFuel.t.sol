// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test, console} from "forge-std/Test.sol";
import {ERC20} from "@oz/token/ERC20/ERC20.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {BridgeAndFuel} from "../BridgeAndFuel.sol";
import {MockFuelSwap} from "../MockFuelSwap.sol";

// ─── Simple mintable ERC20 for tests ─────────────────────────────────────────

contract TestERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function decimals() public pure override returns (uint8) { return 6; }

    function mint(address _to, uint256 _amount) external {
        _mint(_to, _amount);
    }
}

// ─── Mock FeeJuice (mintable) ───────────────────────────────────────────────

contract MockFeeJuice is ERC20 {
    constructor() ERC20("FeeJuice", "FJ") {}

    function mint(address _to, uint256 _amount) external {
        _mint(_to, _amount);
    }
}

// ─── Mock FeeAssetHandler (mimics Aztec's public mint) ──────────────────────

contract MockFeeAssetHandler {
    MockFeeJuice public feeJuice;
    uint256 public mintAmount;

    constructor(address _feeJuice, uint256 _mintAmount) {
        feeJuice = MockFeeJuice(_feeJuice);
        mintAmount = _mintAmount;
    }

    function mint(address _recipient) external {
        feeJuice.mint(_recipient, mintAmount);
    }
}

// ─── Mock FeeJuicePortal ─────────────────────────────────────────────────────

contract MockFeeJuicePortal {
    IERC20 public UNDERLYING;
    uint256 public nextIndex;

    constructor(address _underlying) {
        UNDERLYING = IERC20(_underlying);
    }

    function depositToAztecPublic(bytes32 _to, uint256 _amount, bytes32 _secretHash)
        external
        returns (bytes32, uint256)
    {
        UNDERLYING.transferFrom(msg.sender, address(this), _amount);
        bytes32 key = keccak256(abi.encode(_to, _amount, _secretHash, nextIndex));
        uint256 idx = nextIndex++;
        return (key, idx);
    }
}

// ─── Mock TokenPortal ────────────────────────────────────────────────────────

contract MockTokenPortal {
    address public token;
    uint256 public nextIndex;

    constructor(address _token) {
        token = _token;
    }

    function depositToAztecPublic(bytes32 _to, uint256 _amount, bytes32 _secretHash)
        external
        returns (bytes32, uint256)
    {
        IERC20(token).transferFrom(msg.sender, address(this), _amount);
        bytes32 key = keccak256(abi.encode(_to, _amount, _secretHash, nextIndex));
        uint256 idx = nextIndex++;
        return (key, idx);
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

contract BridgeAndFuelTest is Test {
    BridgeAndFuel bridge;
    MockFuelSwap swap;
    MockFeeJuice feeJuice;
    MockFeeAssetHandler feeAssetHandler;
    TestERC20 usdc;
    MockFeeJuicePortal feeJuicePortal;
    MockTokenPortal tokenPortal;

    address user = address(0xBEEF);
    bytes32 aztecRecipient = bytes32(uint256(0xCAFE));
    bytes32 tokenSecretHash = bytes32(uint256(0x1111));
    bytes32 fuelSecretHash = bytes32(uint256(0x2222));

    function setUp() public {
        // Deploy tokens
        usdc = new TestERC20("USDC", "USDC");
        feeJuice = new MockFeeJuice();

        // Deploy FeeAssetHandler mock (mints 1000e18 per call)
        feeAssetHandler = new MockFeeAssetHandler(address(feeJuice), 1000e18);

        // Deploy MockFuelSwap with 1:1 rate, using FeeAssetHandler
        swap = new MockFuelSwap(address(feeJuice), address(feeAssetHandler), 1e18);

        // Deploy mock portals
        feeJuicePortal = new MockFeeJuicePortal(address(feeJuice));
        tokenPortal = new MockTokenPortal(address(usdc));

        // Deploy orchestrator
        bridge = new BridgeAndFuel();

        // Fund user
        usdc.mint(user, 1000e6);
    }

    function _buildSwapData(uint256 inputAmount, uint256 minOutput) internal view returns (bytes memory) {
        return abi.encodeWithSelector(MockFuelSwap.swap.selector, address(usdc), inputAmount, minOutput);
    }

    function _buildParams(uint256 totalAmount, uint256 fuelAmount, uint256 minFuelOutput)
        internal
        view
        returns (BridgeAndFuel.BridgeParams memory)
    {
        return BridgeAndFuel.BridgeParams({
            tokenPortal: address(tokenPortal),
            bridgeToken: address(usdc),
            totalAmount: totalAmount,
            fuelAmount: fuelAmount,
            aztecRecipient: aztecRecipient,
            tokenSecretHash: tokenSecretHash,
            fuelSecretHash: fuelSecretHash,
            feeJuicePortal: address(feeJuicePortal),
            swapTarget: address(swap),
            swapAllowanceTarget: address(swap),
            minFuelOutput: minFuelOutput
        });
    }

    function _expectedFjOutput(uint256 usdcAmount) internal pure returns (uint256) {
        return usdcAmount * (10 ** (18 - 6)); // normalize 6-dec to 18-dec at 1:1 rate
    }

    // ─── Happy path ──────────────────────────────────────────────────────

    function test_bridgeWithFuel_happyPath() public {
        uint256 totalAmount = 100e6;
        uint256 fuelAmount = 10e6;
        uint256 bridgeAmount = totalAmount - fuelAmount;
        uint256 expectedFjOutput = _expectedFjOutput(fuelAmount);

        vm.startPrank(user);
        usdc.approve(address(bridge), totalAmount);

        bridge.bridgeWithFuel(
            _buildParams(totalAmount, fuelAmount, expectedFjOutput),
            _buildSwapData(fuelAmount, expectedFjOutput)
        );
        vm.stopPrank();

        // Verify balances
        assertEq(usdc.balanceOf(user), 1000e6 - totalAmount, "user USDC not debited");
        assertEq(usdc.balanceOf(address(tokenPortal)), bridgeAmount, "tokenPortal didn't receive bridge amount");
        assertEq(usdc.balanceOf(address(swap)), fuelAmount, "swap didn't receive fuel input");
        assertEq(feeJuice.balanceOf(address(feeJuicePortal)), expectedFjOutput, "feeJuicePortal didn't receive fuel");
    }

    // ─── Revert: zero totalAmount ────────────────────────────────────────

    function test_revert_zeroTotalAmount() public {
        vm.startPrank(user);
        usdc.approve(address(bridge), 100e6);

        vm.expectRevert("BridgeAndFuel: zero amount");
        bridge.bridgeWithFuel(
            _buildParams(0, 0, 0),
            _buildSwapData(0, 0)
        );
        vm.stopPrank();
    }

    // ─── Revert: fuelAmount >= totalAmount ───────────────────────────────

    function test_revert_fuelAmountEqualToTotal() public {
        uint256 totalAmount = 100e6;

        vm.startPrank(user);
        usdc.approve(address(bridge), totalAmount);

        vm.expectRevert("BridgeAndFuel: invalid fuelAmount");
        bridge.bridgeWithFuel(
            _buildParams(totalAmount, totalAmount, totalAmount),
            _buildSwapData(totalAmount, totalAmount)
        );
        vm.stopPrank();
    }

    // ─── Revert: zero fuelAmount ─────────────────────────────────────────

    function test_revert_zeroFuelAmount() public {
        uint256 totalAmount = 100e6;

        vm.startPrank(user);
        usdc.approve(address(bridge), totalAmount);

        vm.expectRevert("BridgeAndFuel: invalid fuelAmount");
        bridge.bridgeWithFuel(
            _buildParams(totalAmount, 0, 0),
            _buildSwapData(0, 0)
        );
        vm.stopPrank();
    }

    // ─── Revert: insufficient approval ───────────────────────────────────

    function test_revert_insufficientApproval() public {
        uint256 totalAmount = 100e6;
        uint256 fuelAmount = 10e6;

        vm.startPrank(user);
        usdc.approve(address(bridge), totalAmount - 1); // not enough

        vm.expectRevert();
        bridge.bridgeWithFuel(
            _buildParams(totalAmount, fuelAmount, fuelAmount),
            _buildSwapData(fuelAmount, fuelAmount)
        );
        vm.stopPrank();
    }

    // ─── Revert: slippage (minFuelOutput too high) ───────────────────────

    function test_revert_slippage() public {
        uint256 totalAmount = 100e6;
        uint256 fuelAmount = 10e6;
        uint256 expectedFjOutput = _expectedFjOutput(fuelAmount);

        vm.startPrank(user);
        usdc.approve(address(bridge), totalAmount);

        vm.expectRevert("BridgeAndFuel: swap failed");
        bridge.bridgeWithFuel(
            _buildParams(totalAmount, fuelAmount, expectedFjOutput + 1),
            _buildSwapData(fuelAmount, expectedFjOutput + 1)
        );
        vm.stopPrank();
    }

    // ─── Multiple sequential operations ──────────────────────────────────

    function test_multipleDeposits() public {
        uint256 totalAmount = 50e6;
        uint256 fuelAmount = 5e6;
        uint256 expectedFjOutput = _expectedFjOutput(fuelAmount);

        vm.startPrank(user);
        usdc.approve(address(bridge), totalAmount * 2);

        // First deposit
        bridge.bridgeWithFuel(
            _buildParams(totalAmount, fuelAmount, expectedFjOutput),
            _buildSwapData(fuelAmount, expectedFjOutput)
        );

        // Second deposit with different secrets
        BridgeAndFuel.BridgeParams memory p2 = _buildParams(totalAmount, fuelAmount, expectedFjOutput);
        p2.tokenSecretHash = bytes32(uint256(0x3333));
        p2.fuelSecretHash = bytes32(uint256(0x4444));

        bridge.bridgeWithFuel(p2, _buildSwapData(fuelAmount, expectedFjOutput));
        vm.stopPrank();

        assertEq(usdc.balanceOf(user), 1000e6 - totalAmount * 2, "user balance after two deposits");
        assertEq(tokenPortal.nextIndex(), 2, "tokenPortal should have 2 deposits");
        assertEq(feeJuicePortal.nextIndex(), 2, "feeJuicePortal should have 2 deposits");
    }
}
