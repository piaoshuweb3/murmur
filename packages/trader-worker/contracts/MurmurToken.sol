// SPDX-License-Identifier: MIT
// =============================================================================
// MurmurToken — the deployment's OWN ERC-20 (spec: docs/murmur-合约部署彩排手册.md §7)
// =============================================================================
// WHY IT EXISTS. PredictionArena is denominated in "MURMUR" and the community gate reads a
// token balance — but this deployment must be 100% self-sovereign, so the token is written and
// issued HERE, by us, minted once, and owned by nobody. Upstream's token (if it shares a name)
// is a different asset with no relation to this one.
//
// SOVEREIGNTY RULES (all deliberate):
//   · ZERO dependencies — hand-written minimal ERC-20, same house style as the other five contracts.
//   · FIXED SUPPLY — the full supply is minted ONCE to the treasury passed at deploy, then the
//     mint path is burned out of existence. No pause, no blacklist, no owner, no re-mint, no upgrade.
//   · NO BACKDOORS — self-sovereignty does not mean admin privileges; it means nobody (including
//     us) can touch holders' balances outside the public transfer rules.
//   · Value capture lives in the explicit arenas (Arena/WarCoffer fees), never in a hidden token tax.
// =============================================================================

pragma solidity ^0.8.24;

contract MurmurToken {
    // ---------- metadata ----------
    string public constant name = "Murmur";
    string public constant symbol = "MURMUR";
    uint8   public constant decimals = 18;

    // ---------- ledger ----------
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // ---------- events ----------
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // ---------- one-shot mint ----------
    /// The ONLY mint. `treasury_` receives the entire fixed supply; after construction no
    /// privileged caller exists — the contract is a plain, rule-bound ERC-20 forever.
    constructor(address treasury_, uint256 supply_) {
        require(treasury_ != address(0), "MURMUR: zero treasury");
        totalSupply = supply_;
        balanceOf[treasury_] = supply_;
        emit Transfer(address(0), treasury_, supply_);
    }

    // ---------- ERC-20 ----------
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
        require(a >= value, "MURMUR: allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value; // max-approval stays open
        _move(from, to, value);
        return true;
    }

    // ---------- internals ----------
    function _move(address from, address to, uint256 value) private {
        require(to != address(0), "MURMUR: zero to");
        uint256 bal = balanceOf[from];
        require(bal >= value, "MURMUR: balance");
        unchecked {
            balanceOf[from] = bal - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
