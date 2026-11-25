import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Common, createCustomCommon, Hardfork, Mainnet } from '@ethereumjs/common';
import { createVM, runTx, type VM } from '@ethereumjs/vm';
import { createLegacyTx } from '@ethereumjs/tx';
import {
  Account,
  Address as EthAddress,
  bytesToHex,
  createAddressFromPrivateKey,
  createZeroAddress,
  hexToBytes,
} from '@ethereumjs/util';
import {
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { AEVUM_CHAIN_ID } from '../shared/aevum.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

export interface CompiledArtifact {
  contractName: string;
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
}

export interface TestActor {
  name: string;
  privateKey: Hex;
  privateKeyBytes: Uint8Array;
  address: Address;
  ethAddress: EthAddress;
  account: PrivateKeyAccount;
}

export interface DecodedLog {
  address: Address;
  eventName: string;
  args: Record<string, unknown>;
}

export interface TxReceiptInfo {
  gasUsed: bigint;
  createdAddress?: Address;
  returnValue: Hex;
  logs: DecodedLog[];
}

export function loadArtifact(contractName: string): CompiledArtifact {
  const filePath = path.join(ROOT, 'artifacts', `${contractName}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as CompiledArtifact;
}

export function makeActor(name: string, privateKey: Hex): TestActor {
  const privateKeyBytes = hexToBytes(privateKey);
  const ethAddress = createAddressFromPrivateKey(privateKeyBytes);
  const account = privateKeyToAccount(privateKey);
  return {
    name,
    privateKey,
    privateKeyBytes,
    address: account.address,
    ethAddress,
    account,
  };
}

export class LocalAevumEvm {
  readonly common: Common;
  readonly vm: VM;
  timestamp: bigint;
  blockNumber: bigint;
  private readonly nonces = new Map<string, bigint>();
  private readonly abiRegistry = new Map<string, Abi>();

  private constructor(common: Common, vm: VM, initialTimestamp: bigint) {
    this.common = common;
    this.vm = vm;
    this.timestamp = initialTimestamp;
    this.blockNumber = 4_071_600n;
  }

  static async create(actors: TestActor[], initialTimestamp = 1_795_593_600n): Promise<LocalAevumEvm> {
    const common = createCustomCommon(
      {
        name: 'qday-aevum-testnet',
        chainId: AEVUM_CHAIN_ID,
      },
      Mainnet,
      {
        hardfork: Hardfork.Shanghai,
      }
    );

    const vm = await createVM({ common });
    const env = new LocalAevumEvm(common, vm, initialTimestamp);

    for (const actor of actors) {
      await vm.stateManager.putAccount(
        actor.ethAddress,
        new Account(0n, 1000n * 10n ** 18n)
      );
      env.nonces.set(actor.address.toLowerCase(), 0n);
    }

    return env;
  }

  registerAbi(address: Address, abi: Abi): void {
    this.abiRegistry.set(address.toLowerCase(), abi);
  }

  advanceTime(seconds: bigint | number): void {
    this.timestamp += BigInt(seconds);
    this.blockNumber += 1n;
  }

  private getBlockStub() {
    const ts = this.timestamp;
    const num = this.blockNumber;
    return {
      common: this.common,
      header: {
        number: num,
        timestamp: ts,
        coinbase: createZeroAddress(),
        gasLimit: 30_000_000n,
        difficulty: 0n,
        prevRandao: new Uint8Array(32),
        baseFeePerGas: 1_000_000_000n,
      },
    } as unknown as Parameters<typeof runTx>[1]['block'];
  }

  async deploy(
    sender: TestActor,
    artifact: CompiledArtifact,
    args: readonly unknown[] = []
  ): Promise<{ address: Address; receipt: TxReceiptInfo }> {
    const deployData = encodeDeployData({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: args as unknown[],
    });

    const receipt = await this.sendRawTx(sender, undefined, deployData, artifact.abi);
    if (!receipt.createdAddress) {
      throw new Error(`Deployment of ${artifact.contractName} did not produce a contract address`);
    }
    this.registerAbi(receipt.createdAddress, artifact.abi);
    return { address: receipt.createdAddress, receipt };
  }

  async write(
    sender: TestActor,
    to: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = []
  ): Promise<TxReceiptInfo> {
    const data = encodeFunctionData({
      abi,
      functionName,
      args: args as unknown[],
    });
    return this.sendRawTx(sender, to, data, abi);
  }

  async read<T = unknown>(
    to: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
    caller?: TestActor
  ): Promise<T> {
    const data = encodeFunctionData({
      abi,
      functionName,
      args: args as unknown[],
    });

    const res = await this.vm.evm.runCall({
      to: new EthAddress(hexToBytes(to)),
      caller: caller ? caller.ethAddress : createZeroAddress(),
      origin: caller ? caller.ethAddress : createZeroAddress(),
      data: hexToBytes(data),
      gasLimit: 10_000_000n,
      block: this.getBlockStub(),
    });

    if (res.execResult.exceptionError) {
      throw this.formatRevertError(res.execResult.returnValue, abi, res.execResult.exceptionError.error);
    }

    const decoded = decodeFunctionResult({
      abi,
      functionName,
      data: bytesToHex(res.execResult.returnValue) as Hex,
    });
    return decoded as T;
  }

  async expectRevert(
    fn: () => Promise<unknown>,
    expectedErrorName: string
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes(expectedErrorName)) {
        throw new Error(`Expected revert "${expectedErrorName}", but got: ${msg}`);
      }
      return;
    }
    throw new Error(`Expected transaction to revert with "${expectedErrorName}", but it succeeded`);
  }

  private async sendRawTx(
    sender: TestActor,
    to: Address | undefined,
    data: Hex,
    primaryAbi?: Abi
  ): Promise<TxReceiptInfo> {
    const key = sender.address.toLowerCase();
    const nonce = this.nonces.get(key) ?? 0n;

    const tx = createLegacyTx(
      {
        nonce,
        gasPrice: 1_000_000_000n,
        gasLimit: 8_000_000n,
        to: to ? new EthAddress(hexToBytes(to)) : undefined,
        data: hexToBytes(data),
        value: 0n,
      },
      { common: this.common }
    ).sign(sender.privateKeyBytes);

    this.blockNumber += 1n;
    const result = await runTx(this.vm, {
      tx,
      block: this.getBlockStub(),
      skipBlockGasLimitValidation: true,
    });

    // EVM increments nonce even on revert
    this.nonces.set(key, nonce + 1n);

    if (result.execResult.exceptionError) {
      const abi = primaryAbi ?? (to ? this.abiRegistry.get(to.toLowerCase()) : undefined);
      throw this.formatRevertError(
        result.execResult.returnValue,
        abi,
        result.execResult.exceptionError.error
      );
    }

    const rawLogs = result.execResult.logs ?? [];
    const logs: DecodedLog[] = [];
    for (const [logAddr, topics, logData] of rawLogs) {
      const address = bytesToHex(logAddr) as Address;
      const abi = this.abiRegistry.get(address.toLowerCase());
      if (!abi) continue;
      try {
        const decoded = decodeEventLog({
          abi,
          data: bytesToHex(logData) as Hex,
          topics: topics.map((t) => bytesToHex(t) as Hex) as [Hex, ...Hex[]],
        });
        logs.push({
          address,
          eventName: decoded.eventName ?? 'Unknown',
          args: (decoded.args ?? {}) as Record<string, unknown>,
        });
      } catch {
        // Ignore non-matching log topics
      }
    }

    return {
      gasUsed: result.totalGasSpent,
      createdAddress: result.createdAddress
        ? (result.createdAddress.toString() as Address)
        : undefined,
      returnValue: bytesToHex(result.execResult.returnValue) as Hex,
      logs,
    };
  }

  private formatRevertError(returnBytes: Uint8Array, abi: Abi | undefined, fallback: string): Error {
    const hex = bytesToHex(returnBytes) as Hex;
    if (abi && hex.length >= 10) {
      try {
        const decoded = decodeErrorResult({ abi, data: hex });
        const argStr = decoded.args ? `(${decoded.args.map(String).join(', ')})` : '';
        return new Error(`EVM Revert: ${decoded.errorName}${argStr}`);
      } catch {
        // Check standard Error(string) selector 0x08c379a0
      }
    }
    if (hex.startsWith('0x08c379a0')) {
      try {
        const decoded = decodeErrorResult({
          abi: [
            {
              type: 'error',
              name: 'Error',
              inputs: [{ name: 'message', type: 'string' }],
            },
          ],
          data: hex,
        });
        return new Error(`EVM Revert: ${String(decoded.args?.[0] ?? fallback)}`);
      } catch {
        // fall through
      }
    }
    return new Error(`EVM Revert: ${fallback} (${hex})`);
  }
}
