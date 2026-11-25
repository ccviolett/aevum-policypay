// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockTUSD8
 * @notice STRICTLY FOR LOCAL AUTOMATED UNIT TESTING ONLY.
 *         NEVER deploy this contract to QDay Aevum Testnet!
 *         On Aevum Testnet (Chain ID 44005), ALWAYS use the official live tUSD8 contract:
 *         0x456569838f1d43009A91ebA4263147Afd7233483 (6 decimals).
 */
contract MockTUSD8 {
    string public constant name = "tUSD8";
    string public constant symbol = "tUSD8";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        require(to != address(0), "MockTUSD8: zero address");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "MockTUSD8: insufficient allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        return _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        require(to != address(0), "MockTUSD8: zero recipient");
        uint256 bal = balanceOf[from];
        require(bal >= value, "MockTUSD8: insufficient balance");
        unchecked {
            balanceOf[from] = bal - value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}
