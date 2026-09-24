// SPDX-License-Identifier: MIT
// =============================================================================
// MockUSDC — R1 fork 彩排 / R2 测试网专用 USDC 替身（docs/murmur-合约部署彩排手册.md R2）
// =============================================================================
// WHY. Arc 主网 USDC precompile（0x3600..0000）在 anvil fork 上只读可复刻、写入被
// Arc 节点的原生 precompile 层阻断（eth_call transfer 即 revert——真实节点不受影响）。
// 因此资金路径彩排使用本替身资产：接口与 FiatTokenV2 对齐（6 decimals + EIP-3009
// transferWithAuthorization + AuthorizationUsed 事件 + EIP-712 域 name="USDC" version="2"）。
//
// ⚠ TESTNET/REHEARSAL ONLY — 本合约绝不上主网：mint 是公开水龙头，仅供彩排与测试网。
//   主网部署清单（R3）里没有它；WarCoffer 在主网始终指向 Arc 原生 USDC precompile。
// 零依赖手写，风格与五件套一致；无 owner、无 pause、无升级。
// =============================================================================

pragma solidity ^0.8.24;

contract MockUSDC {
    string public constant name = "USD Coin (rehearsal)";
    string public symbol = "mUSDC";
    uint8   public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice EIP-712 domain（与 Circle FiatTokenV2 同构：name "USDC", version "2"）
    bytes32 public immutable DOMAIN_SEPARATOR;

    /// @notice nonce => 已用（EIP-3009 防重放）
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed from, address indexed to, uint256 value);

    bytes32 private constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("USDC")),
            keccak256(bytes("2")),
            block.chainid,
            address(this)
        ));
    }

    // ---------------------- 彩排/测试网水龙头（主网禁用本合约） ----------------------
    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    // ---------------------- ERC-20 ----------------------
    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= value, "mUSDC: allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        _move(from, to, value);
        return true;
    }

    // ---------------------- EIP-3009（x402 结算原语，FiatTokenV2 语义） ----------------------
    /// @notice flat 9 参形态：由 facilitator 代买家提交（买家只出签名，从不出钥）。
    function transferWithAuthorization(
        address from, address to, uint256 value,
        uint256 validAfter, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s
    ) external {
        require(block.timestamp >= validAfter, "mUSDC: auth not yet valid");
        require(block.timestamp <= validBefore, "mUSDC: auth expired");
        require(!authorizationState[from][nonce], "mUSDC: nonce used");
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01", DOMAIN_SEPARATOR,
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
        ));
        address signer = ecrecover(digest, _normV(v), r, s);
        require(signer != address(0) && signer == from, "mUSDC: bad signature");
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, to, value);
        _move(from, to, value);
    }

    // ---------------------- internals ----------------------
    function _normV(uint8 v) internal pure returns (uint8) { return v < 27 ? v + 27 : v; }

    function _move(address from, address to, uint256 value) private {
        require(to != address(0), "mUSDC: zero to");
        uint256 bal = balanceOf[from];
        require(bal >= value, "mUSDC: balance");
        unchecked {
            balanceOf[from] = bal - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
