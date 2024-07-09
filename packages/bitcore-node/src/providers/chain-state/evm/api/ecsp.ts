import { CryptoRpc } from 'crypto-rpc';
import _ from 'lodash';
import { Readable } from 'stream';
import Web3 from 'web3';
import Config from '../../../../config';
import logger from '../../../../logger';
import { IBlock } from '../../../../types/Block';
import { IChainConfig, IEVMNetworkConfig, IProvider } from '../../../../types/Config';
import {
  ExternalGetBlockResults,
  GetBlockParams,
  GetWalletBalanceAtTimeParams,
  IChainStateService,
  StreamAddressUtxosParams,
  StreamBlocksParams,
  StreamTransactionParams,
  StreamTransactionsParams,
  StreamWalletTransactionsParams
} from '../../../../types/namespaces/ChainStateProvider';
import { unixToDate } from '../../../../utils/convert';
import { ParseJsonStream } from '../../../../utils/jsonStream';
import { StatsUtil } from '../../../../utils/stats';
import MoralisAPI from '../../external/providers/moralis';
import { ExternalApiStream, MergedStream } from '../../external/streams/apiStream';
import { NodeQueryStream } from '../../external/streams/nodeStream';
import { InternalStateProvider } from '../../internal/internal';
import { EVMTransactionStorage } from '../models/transaction';
import { EVMTransactionJSON } from '../types';
import { BaseEVMStateProvider } from './csp';
import { PopulateReceiptTransform } from './populateReceiptTransform';
import {
  getProvider,
  isValidProviderType
} from './provider';
import { EVMListTransactionsStream } from './transform';


export interface GetWeb3Response { rpc: CryptoRpc; web3: Web3; dataType: string }

export class BaseEVMExternalStateProvider extends InternalStateProvider implements IChainStateService {
  config: IChainConfig<IEVMNetworkConfig>;

  constructor(public chain: string = 'ETH') {
    super(chain);
    this.config = Config.chains[this.chain] as IChainConfig<IEVMNetworkConfig>;
  }

  async getWeb3(network: string, params?: { type: IProvider['dataType'] }): Promise<GetWeb3Response> {
    for (const rpc of BaseEVMStateProvider.rpcs[this.chain]?.[network] || []) {
      if (!isValidProviderType(params?.type, rpc.dataType)) {
        continue;
      }

      try {
        await Promise.race([
          rpc.web3.eth.getBlockNumber(),
          new Promise((_, reject) => setTimeout(reject, 5000))
        ]);
        return rpc; // return the first applicable rpc that's responsive
      } catch (e) {
        // try reconnecting
        if (typeof (rpc.web3.currentProvider as any)?.disconnect === 'function') {
          (rpc.web3.currentProvider as any)?.disconnect?.();
          (rpc.web3.currentProvider as any)?.connect?.();
          if ((rpc.web3.currentProvider as any)?.connected) {
            return rpc;
          }
        }
        const idx = BaseEVMStateProvider.rpcs[this.chain][network].indexOf(rpc);
        BaseEVMStateProvider.rpcs[this.chain][network].splice(idx, 1);
      }
    }

    logger.info(`Making a new connection for ${this.chain}:${network}`);
    const dataType = params?.type;
    const providerConfig = getProvider({ network, dataType, config: this.config });
    // Default to using ETH CryptoRpc with all EVM chain configs
    const rpcConfig = { ...providerConfig, chain: 'ETH', currencyConfig: {} };
    const rpc = new CryptoRpc(rpcConfig, {}).get('ETH');
    const rpcObj = { rpc, web3: rpc.web3, dataType: rpcConfig.dataType || 'combined' };
    if (!BaseEVMStateProvider.rpcs[this.chain]) {
      BaseEVMStateProvider.rpcs[this.chain] = {};
    }
    if (!BaseEVMStateProvider.rpcs[this.chain][network]) {
      BaseEVMStateProvider.rpcs[this.chain][network] = [];
    }
    BaseEVMStateProvider.rpcs[this.chain][network].push(rpcObj);
    return rpcObj;
  }

  async getChainId({ network }) {
    const { web3 } = await this.getWeb3(network);
    return await web3.eth.getChainId();
  }

  async getLocalTip({ chain, network, includeTxs = false }): Promise<IBlock> {
    const { web3 } = await this.getWeb3(network);
    const block = await web3.eth.getBlock('latest');
    return ECSP.transformBlockData({ chain, network, block, includeTxs }) as IBlock;
  }

  async getFee(params) {
    let { network, target = 4 } = params;
    const { web3 } = await this.getWeb3(network, { type: 'historical' });
    const latestBlock = await web3.eth.getBlockNumber();
    // Getting the 25th percentile gas prices from the last 4k blocks
    const feeHistory = await web3.eth.getFeeHistory(20 * 200, latestBlock, [25]);
    const gasPrices: Array<BigInt> = [];
    const length = Math.min(feeHistory.baseFeePerGas.length, feeHistory.reward.length);
    for (let i = 0; i < length; i++) {
      // Adds base fee with reward / priority fee to get total gas price in wei
      // For pre-type2 blocks the gas prices are returned as rewards and zeroes are returned for the base fee per gas
      gasPrices.push(BigInt(feeHistory.baseFeePerGas[i]) + BigInt(feeHistory.reward[i][0]));
    }
    // Sort descending with an appropriate BigInt comparator
    gasPrices.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    const whichQuartile: number = Math.min(target, 4) || 1;
    const quartileMedian: BigInt = StatsUtil.getNthQuartileMedian(gasPrices, whichQuartile);
    const feerate = Number(quartileMedian.toString());
    // Fee returned in wei
    return { feerate, blocks: target };
  }

  async getBlocks(params: GetBlockParams) {
    try {
      const { chain, network } = params;
      const { query } = await this.getBlocksParams(params);
      const { web3 } = await this.getWeb3(network, { type: 'historical' });
      const tip = await this.getLocalTip(params);
      const tipHeight = tip ? tip.height : 0;
      const blockTransform = async (block) => {
        block = await block;
        let confirmations = 0;
        const blockHeight = block.height || block.number || 0;
        if (blockHeight >= 0) {
          confirmations = tipHeight - blockHeight + 1;
        }
        const convertedBlock = ECSP.transformBlockData({ chain, network, block }) as IBlock;
        return { ...convertedBlock, confirmations };
      };

      const batch = new web3.eth.BatchRequest();
      const blockPromises: Promise<any>[] = [];
      const blockNumbers = _.range(query.startBlock, query.endBlock + 1);
      // batch getBlock requests to reduce latency
      for (let i = 0; i < blockNumbers.length; i++) {
        const blockPromise = new Promise<any>((resolve, reject) => {
          batch.add(
            (web3.eth.getBlock as any).request(blockNumbers[i], (error, block) => {
              if (error) {
                return reject(error);
              }
              return resolve(block);
            }));
        });
        blockPromises.push(blockPromise);
      };
      batch.execute();

      return Promise.all(blockPromises)
        .then(blockPromises.map(blockTransform) as any)
        .catch(error => error);
    } catch (err: any) {
      logger.error('Error getting blocks from historical node: %o', err.log || err);
    }
    return undefined;
  }

  async getTransaction(params: StreamTransactionParams) {
    try {
      let { chain, network, txId } = params;
      if (typeof txId !== 'string' || !chain || !network) {
        throw new Error('Missing required param');
      }
      const { web3 } = await this.getWeb3(network, { type: 'historical' });
      const tip = await this.getLocalTip(params);
      const tipHeight = tip ? tip.height : 0;
      return await this._getTransaction({ chain, network, txId, tipHeight, web3 });
    } catch (err: any) {
      logger.error('Error getting transactions from historical node %o', err.log || err);
    }
    return undefined;
  }

  async _getTransaction({ chain, network, txId, tipHeight, web3 }) {
    const tx: any = await web3.eth.getTransaction(txId);
    if (tx) {
      let confirmations = 0;
      if (tx.blockNumber && tx.blockNumber >= 0) {
        confirmations = tipHeight - tx.blockNumber + 1;
      }
      tx.blockTime = await this.getBlockTimestamp(tx.blockHash, { network });
      const receipt = await web3.eth.getTransactionReceipt(txId);
      if (receipt) {
        const fee = receipt.gasUsed * parseInt(tx.gasPrice);
        tx.receipt = receipt;
        tx.fee = fee;
      }
      const tansformedTx = ECSP.transformTransactionData({ tx, network, chain });
      const convertedTx = EVMTransactionStorage._apiTransform(tansformedTx, { object: true }) as EVMTransactionJSON;
      return { ...convertedTx, confirmations };
    }
    return undefined;
  }

  // stream all transactions from a desired block
  async streamTransactions(params: StreamTransactionsParams) {
    const { chain, network, req, res, args } = params;
    let { blockHash, blockHeight } = args;
    try {
      if (blockHeight !== undefined) {
        blockHeight = Number(blockHeight);
      }
      // get block tip for confirmations
      const tip = await this.getLocalTip(params);
      const tipHeight = tip ? tip.height : 0;
      const { web3 } = await this.getWeb3(network, { type: 'historical' });
      // get block with desired transactions
      const block = await web3.eth.getBlock(blockHash || blockHeight);
      const getTransaction = (async (txId) => {
        return await this._getTransaction({ chain, network, txId, tipHeight, web3 });
      }).bind(this);
      const txStream = new NodeQueryStream(block?.transactions || [], getTransaction, args);
      // stream results into response
      const result = await NodeQueryStream.onStream(txStream, req!, res!);
      if (result?.success === false) {
        logger.error('Error mid-stream (streamTransactions): %o', result.error?.log || result.error);
      }
    } catch (err: any) {
      logger.error('Error streaming transactions from historical node %o', err.log || err);
      throw err;
    }
  }

  async streamAddressTransactions(params: StreamAddressUtxosParams) {
    const { req, res, args, chain, network, address } = params;
    const { tokenAddress } = args;
    try {
      let result;
      const chainId = await this.getChainId({ network });
      // Calculate confirmations with tip height
      const tip = await this.getLocalTip(params);
      args.tipHeight = tip ? tip.height : 0;
      if (!args.tokenAddress) {
        const txStream = MoralisAPI.streamTransactionsByAddress({ chainId, chain, network, address, args });
        result = await ExternalApiStream.onStream(txStream, req!, res!);
      } else {
        const tokenTransfers = MoralisAPI.streamERC20TransactionsByAddress({ chainId, chain, network, address, tokenAddress, args });
        result = await ExternalApiStream.onStream(tokenTransfers, req!, res!);
      }
      if (result?.success === false) {
        logger.error('Error mid-stream (streamAddressTransactions): %o', result.error?.log || result.error);
      }
    } catch (err: any) {
      logger.error('Error streaming address transactions from external provider: %o', err.log || err);
      throw err;
    }
  }

  async streamWalletTransactions(params: StreamWalletTransactionsParams) {
    const { network, wallet, chain, req, res, args } = params;
    try {
      if (!wallet?._id) {
        throw new Error('Missing wallet');
      }
      const chainId = await this.getChainId({ network });
      const tip = await this.getLocalTip(params);
      const walletAddresses = (await this.getWalletAddresses(wallet._id!)).map(addy => addy.address.toLowerCase());
      const txStreams: Readable[] = [];
      const ethTransactionTransform = new EVMListTransactionsStream(walletAddresses);
      const populateReceipt = new PopulateReceiptTransform();
      const parseStream = new ParseJsonStream();
      const mergedStream = new MergedStream(); // Stream to combine the output of multiple streams
      const resultStream = new MergedStream(); // Stream to write to the res object

      // Tip height used to calculate confirmations
      args.tipHeight = tip ? tip.height : 0;
      args.order = args.order || 'ASC'; // bws expects ascending order
      // Defaults to pulling only the first 10 transactions per address
      for (let i = 0; i < walletAddresses.length; i++) {
        // args / query params are processed at the api provider level
        txStreams.push(MoralisAPI.streamTransactionsByAddress({ chainId, chain, network, address: walletAddresses[i], args }));
      }
      // Pipe all txStreams to the mergedStream
      ExternalApiStream.mergeStreams(txStreams, mergedStream);
      // Transform transactions proccessed through merged stream
      mergedStream
      .eventPipe(parseStream)
      .eventPipe(populateReceipt)
      .eventPipe(ethTransactionTransform)
      .eventPipe(resultStream);
      // Ensure resultStream resolves
      const result = await ExternalApiStream.onStream(resultStream, req!, res!, { jsonl: true });
      if (result?.success === false) {
        logger.error('Error mid-stream (streamWalletTransactions): %o', result.error?.log || result.error);
      }
    } catch (err: any) {
      logger.error('Error streaming wallet transactions from external provider: %o', err.log || err);
      throw err;
    }
  }

  async getWalletBalanceAtTime(params: GetWalletBalanceAtTimeParams): Promise<{ confirmed: number; unconfirmed: number; balance: number }> {
    const { network, time, wallet } = params;
    try {
      if (!wallet?._id) {
        throw new Error('Missing wallet');
      }
      const addresses = (await this.getWalletAddresses(wallet._id!)).map(addy => addy.address);
      // get block number based on time
      const block = await this.getBlockNumberByDate({ network, date: time });
      const result: any = await this.getNativeBalanceByBlock({ network, block, addresses });
      return { unconfirmed: 0, confirmed: result?.total_balance, balance: result?.total_balance };
    } catch (err: any) {
      logger.error('Error getting wallet balance at time from external provider %o', err.log || err);
      throw err;
    }
  }

  async getBlockTimestamp(blockNumber, { network }): Promise<Date> {
    const { web3 } = await this.getWeb3(network);
    const block = await web3.eth.getBlock(blockNumber);
    return unixToDate(block.timestamp);
  }

  protected async getBlocksParams(params: GetBlockParams | StreamBlocksParams) {
    const { chain, network, sinceBlock, blockId, args = {} } = params;
    let { startDate, endDate, date, since, direction, paging } = args;
    let { limit = 10, sort = { height: -1 } } = args;
    let options = { limit, sort, since, direction, paging };
    const query: ExternalGetBlockResults = { startBlock: 0, endBlock: 0 };
    if (!chain || !network) {
      throw new Error('Missing required chain and/or network param');
    }
    if (blockId) {
      if (blockId.length >= 64) {
        query['block'] = blockId;
      } else {
        let height = parseInt(blockId, 10);
        if (Number.isNaN(height) || height.toString(10) !== blockId) {
          throw new Error('invalid block id provided');
        }
        query['height'] = height;
      }
    }
  
    if (date) {
      startDate = new Date(date);
      endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);
    }
    if (startDate) {
      query.startBlock = await this.getBlockNumberByDate({ date: startDate, network }) || 0;
    }
    if (endDate) {
      query.endBlock = await this.getBlockNumberByDate({ date: endDate, network }) || 0;
    }

    // Get range
    if (sinceBlock) {
      let height = Number(sinceBlock);
      if (isNaN(height) || height.toString(10) !== sinceBlock) {
        throw new Error('invalid block id provided');
      }
      query.startBlock = height;
      query.endBlock = height + limit;
    } else if (query?.block) {
      const blockNum = await this.getBlockNumberByBlockId({ blockId: query.block, network });
      if (!blockNum) {
        throw new Error(`Could not get block ${query.block}`);
      }
      query['height'] = blockNum;
    }

    if (query?.height) {
      query.startBlock = query?.height;
      query.endBlock = query?.height;
    }

    if (!query.startBlock || !query.endBlock) {
      // Calaculate range with options
      const tip = await this.getLocalTip(params);
      const tipHeight = tip ? tip.height : 0;
      query.endBlock = query.endBlock || tipHeight;
      query.startBlock = query.startBlock || query.endBlock - 1;
    }

    if (limit > 0 && (query.endBlock - query.startBlock) > limit) {
      query.endBlock = query.startBlock + limit;
    }

    if (sort === -1) {
      let b = query.startBlock;
      query.startBlock = query.endBlock;
      query.endBlock = b;
    }

    // { limit, sort, since, direction, paging };
    return { query, options };
  }

  async getBlockNumberByDate({ date, network }) {
    const chainId = await this.getChainId({ network });
    const res = await MoralisAPI.getBlockByDate({ chainId, date });
    const block = JSON.parse((res as any).body);
    return block.number ? Number((block as any).number) : undefined;
  }

  async getBlockNumberByBlockId({ blockId, network }) {
    const chainId = await this.getChainId({ network })
    const res = await MoralisAPI.getBlockByHash({ chainId, blockId });
    const block = JSON.parse((res as any).body);
    return block.number ? Number((block as any).number) : undefined;
  }

  async getNativeBalanceByBlock({ network, block, addresses }) {
    const chainId = await this.getChainId({ network });
    const res = await MoralisAPI.getNativeBalanceByBlock({ chainId, block, addresses });
    return JSON.parse((res as any).body);
  }

  static transformBlockData({ chain, network, block, includeTxs = false }) {
    let data: IBlock = {
      chain,
      network,
      height: block.number,
      hash: block.hash,
      time: unixToDate(block.timestamp), // unix to iso
      timeNormalized: unixToDate(block.timestamp), // unix to iso
      previousBlockHash: block.parentHash,
      nextBlockHash: '',
      transactionCount: block.transactions.length,
      size: block.size,
      reward: 5,
      processed: true,
      nonce: block.nonce, // hex string
      difficulty: block.difficulty,
      gasUsed: block.gasUsed, // BigNumber
      gasLimit: block.gasLimit, // BigNumber
      baseFeePerGas: block.baseFeePerGas // BigNumber
    } as IBlock; // IEVMBlock
    if (includeTxs) { data.transactions = block.transactions; }
    return data;
  }

  static transformTransactionData({ chain, network, tx }) {
    return {
      txid: tx.hash,
      chain,
      network,
      blockHeight: tx.blockNumber || tx.block_number,
      blockHash: tx.blockHash || tx.block_hash,
      blockTime: tx.blockTime || tx.block_timestamp,
      blockTimeNormalized: tx.blockTimeNormalized,
      fee: tx.fee,
      value: tx.value,
      gasLimit: tx.gasLimit || tx.gas,
      gasPrice: tx.gasPrice || tx.gas_price,
      nonce: tx.nonce,
      to: tx.to || tx.to_address,
      from: tx.from || tx.from_address,
      data: tx.data,
      effects: tx.effects,
    }
  }
}

const ECSP = BaseEVMExternalStateProvider;