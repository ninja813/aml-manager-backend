# Ethereum Mainnet Setup for USDT Testing

## Environment Variables (.env file)

Create a `.env` file in your backend directory with these values:

```bash
# Ethereum Mainnet Configuration for USDT Testing
MAINNET_RPC_URL=https://mainnet.infura.io/v3/your-project-id
PRIVATE_KEY=your-private-key-here
TREASURY_PULLER_ADDRESS=your-contract-address-here
TOKEN_ADDRESS=0xdAC17F958D2ee523a2206206994597C13D831ec7
PERMIT2_ADDRESS=0x000000000022D473030F116dDEE9F6B43aC78BA3
```

## Required Information

### 1. RPC URL
- **Infura**: Get your project ID from [infura.io](https://infura.io)
- **Alchemy**: Get your API key from [alchemy.com](https://alchemy.com)
- **QuickNode**: Get your endpoint from [quicknode.com](https://quicknode.com)

### 2. Private Key
- Your wallet's private key (keep this secure!)
- Make sure it has some ETH for gas fees

### 3. Treasury Puller Address
- Deploy your contract to mainnet first
- Get the contract address from the deployment

### 4. Token Address
- USDT on Ethereum mainnet: `0xdAC17F958D2ee523a2206206994597C13D831ec7`
- This is already configured in the code

## Testing Steps

1. **Test USDT and Permit2**: `node test-usdt-mainnet.js`
2. **Start your server**: `npm start`
3. **Test the full flow** with your frontend

## Important Notes

⚠️ **Real Money**: Mainnet uses real ETH and real USDT
⚠️ **Gas Costs**: Transactions can be expensive (especially during high network activity)
⚠️ **Security**: Make sure your private key is secure
⚠️ **Testing**: Consider using a testnet first for development
