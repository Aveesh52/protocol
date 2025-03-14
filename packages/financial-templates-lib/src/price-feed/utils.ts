import lodash from "lodash";
import assert from "assert";
import { averageBlockTimeSeconds, MAX_SAFE_JS_INT, estimateBlocksElapsed } from "@uma/common";
import type { BN } from "../types";

type WithoutStringTimestamp<T extends { timestamp: number | string }> = T & { timestamp: number };

// Downloads blocks and caches them for certain time into the past.
// Allows some in memory searches to go from timestamp to block number.
// Use blocks parameter to optionally insert prefilled cache of blocks.
// Block array is sorted from oldest to newest (smallest timestamp => newest timestamp)
export const BlockHistory = <T extends { number: number; timestamp: number | string }>(
  getBlock: (number?: number) => Promise<T>,
  blocks: T[] = []
): {
  has(number: number): boolean;
  latest(): T;
  insert(block: T): T[];
  getClosestAfter(timestamp: number): T;
  getClosestBefore: (timestamp: number) => T;
  update: (lookback: number, now: number, bufferBlockPercent?: number) => Promise<T[]>;
  listBlocks(): T[];
} => {
  assert(getBlock, "requires getBlock(number) function");

  // Check if we have downloaded a block by number
  function has(number: number): boolean {
    return blocks.find((block) => block.number === number) !== undefined;
  }

  function latest(): T {
    return blocks[blocks.length - 1];
  }

  // Used internally, but will insert a block into cache sorted by timestamp
  function insert(block: T): T[] {
    const index = lodash.sortedIndexBy(blocks, block, "timestamp");
    blocks.splice(index, 0, block);
    return blocks;
  }

  // Gets block equal to or newer (larger) than timestamp
  function getClosestAfter(timestamp: number) {
    // this gaurantees you will get the index of the block you need to insert before
    // or in other words the next block older than timestamp
    const index = lodash.sortedIndexBy(blocks, { timestamp } as T, "timestamp");
    return blocks[index];
  }

  // Gets block equal to or older (lower) than timestamp
  function getClosestBefore(timestamp: number) {
    const index = lodash.sortedIndexBy(blocks, { timestamp } as T, "timestamp");
    // need to check for an exact match in this case, otherwise go to the older block
    if (blocks[index] && blocks[index].timestamp === timestamp) return blocks[index];
    return blocks[index - 1];
  }

  // Main call to update cache, will take care of fetching all blocks, caching and pruning cache.
  async function update(lookback: number, now: number, bufferBlockPercent = 1.1) {
    assert(lookback >= 0, "requires lookback in seconds");
    assert(now >= 0, "requires current time");

    // Note, we make an informed approximation about the block height that corresponds to the earliest timestamp,
    // this allows us to query all block heights from this early number to the current number in parallel, instead of
    // having to traverse backwards sequentially from the current number to this early number.
    const latestBlock = (await getBlock()) as WithoutStringTimestamp<T>;
    const latestBlockHeight = latestBlock.number;
    // Add a conservative block height buffer so that we capture all of the blocks within the lookback window,
    // and if the result is negative then set it to 0. On a test network it is possible for the `earliestBlockHeight`
    // to be negative.
    const earliestBlockHeight = Math.max(
      0,
      latestBlockHeight - Math.floor((bufferBlockPercent * lookback) / (await averageBlockTimeSeconds()))
    );

    // Push all getBlock() promises into an array to execute in parallel
    const getBlockPromises: Promise<WithoutStringTimestamp<T>>[] = [];
    for (let i = earliestBlockHeight; i <= latestBlockHeight; i++) {
      getBlockPromises.push(getBlock(i) as Promise<WithoutStringTimestamp<T>>);
    }
    const result = await Promise.all(getBlockPromises);

    // Insert all blocks into cache whose timestamp is equal to or greater than (now-lookback).
    result.map((_block) => {
      if (_block.timestamp >= now - lookback) {
        insert(_block);
      }
    });
    return result;
  }

  // Return all blocks in cache
  function listBlocks() {
    return blocks;
  }

  return {
    // Public main API
    update,
    getClosestBefore,
    getClosestAfter,
    // Private, but can use as needed
    has,
    insert,
    listBlocks,
    latest,
  };
};

// Given a price function which uses block numbers to get price,
// this creates a cache of prices to allow you to search by block timestamp
// This data does not get pruned since its extremely minimal, just [timestamp]:price
export const PriceHistory = <T>(
  getPrice: (blockNumber: number) => Promise<T | null>,
  prices: { [timestamp: number]: T } = {}
): {
  currentPrice: () => T | null;
  getBetween: (start: number, end?: number) => T[];
  get: (timestamp: number) => T;
  has: (timestamp: number) => boolean;
  set: (timestamp: number, price: T) => T;
  update: (block: { timestamp: number | string; number: number }) => Promise<T | undefined>;
  list: () => [number: number, price: T][];
} => {
  assert(getPrice, "requires getPrice(blockNumber) function");

  // Get the latest known price from current block
  function currentPrice(): T | null {
    const result = list().reduce(
      (result, [timestamp, price]) => {
        if (result.price === undefined || result.price === null) return { timestamp, price };
        if (result.timestamp < timestamp) return { timestamp, price };
        return result;
      },
      { timestamp: 0, price: null as null | T }
    );
    return result.price;
  }

  // set price at time
  function set(timestamp: number, price: T) {
    assert(timestamp >= 0, "requires timestamp in seconds");
    prices[timestamp] = price;
    return price;
  }

  // Get a price at a timestamp. Timestamp must be exact. Use in conjunction with blockHistory.
  function get(timestamp: number): T {
    assert(timestamp >= 0, "requires timestamp in seconds");
    assert(has(timestamp), "no price for that timestamp, use block timestamp");
    return prices[timestamp];
  }

  // Get prices between two timestamps. End time defaults to now.
  function getBetween(start: number, end = Date.now()): T[] {
    assert(start <= end, "Start time must be less than end time");
    return Object.keys(prices)
      .map(Number)
      .filter((timestamp) => timestamp <= end && timestamp >= start)
      .map((key) => prices[key]);
  }

  // Check if price exists at a timestamp
  function has(timestamp: number): boolean {
    return prices[timestamp] !== undefined;
  }

  // Update price for block unless a price exists already
  async function update(block: { timestamp: number | string; number: number }): Promise<T | undefined> {
    assert(
      block.timestamp !== null && block.timestamp !== undefined && Number(block.timestamp) >= 0,
      "requires block with timestamp"
    );
    assert(block.number >= 0, "requires block with number");
    const timestamp = Number(block.timestamp);
    if (has(timestamp)) return get(timestamp);
    const price = await getPrice(block.number);
    if (price !== undefined && price !== null) {
      // Only add prices to history that are non-null.
      return set(timestamp, price);
    }
  }

  // List all prices in format [ [ timestamp, price] ]
  function list(): [number: number, price: T][] {
    return Object.entries(prices).map(([number, price]) => [parseInt(number), price]);
  }

  return {
    // Public main api
    currentPrice,
    getBetween,
    get,
    // Private but can use if needed
    has,
    set,
    update,
    list,
  };
};

/**
 * @notice Constructs the BlockFinder, which is a simple class-like object to find blocks by timestamp, but keeps a
 *      cache to optimize the search.
 * @param {Function} requestBlock async function, like web3.eth.getBlock that returns a block for a particular block
 *      number or returns the latest block if no argument is provided. Blocks returned must have a `number` and
 */
export const BlockFinder = <T extends { number: number; timestamp: number | string }>(
  requestBlock: (requestedBlock: string | number) => Promise<T>,
  blocks: T[] = []
): {
  getBlockForTimestamp: (timestamp: number) => Promise<T>;
} => {
  assert(requestBlock, "requestBlock function must be provided");

  // Grabs the most recent block and caches it.
  async function getLatestBlock() {
    const block = await requestBlock("latest");
    const index = lodash.sortedIndexBy(blocks, block, "number");
    if (blocks[index]?.number !== block.number) blocks.splice(index, 0, block);
    return blocks[index];
  }

  // Grabs the block for a particular number and caches it.
  async function getBlock(number: number) {
    const index = lodash.sortedIndexBy(blocks, { number } as T, "number");
    if (blocks[index]?.number === number) return blocks[index]; // Return early if block already exists.
    const block = await requestBlock(number);
    blocks.splice(index, 0, block); // A simple insert at index.
    return block;
  }

  // Return the latest block, between startBlock and endBlock, whose timestamp is <= timestamp.
  // Effectively, this is an interpolation search algorithm to minimize block requests.
  // Note: startBlock and endBlock _must_ be different blocks.
  async function findBlock(_startBlock: T, _endBlock: T, timestamp: number): Promise<T> {
    const [startBlock, endBlock] = [_startBlock, _endBlock] as WithoutStringTimestamp<T>[];
    // In the case of equality, the endBlock is expected to be passed as the one whose timestamp === the requested
    // timestamp.
    if (endBlock.timestamp === timestamp) return endBlock;

    // If there's no equality, but the blocks are adjacent, return the startBlock, since we want the returned block's
    // timestamp to be <= the requested timestamp.
    if (endBlock.number === startBlock.number + 1) return startBlock;

    assert(endBlock.number !== startBlock.number, "startBlock cannot equal endBlock");
    assert(
      timestamp < endBlock.timestamp && timestamp > startBlock.timestamp,
      "timestamp not in between start and end blocks"
    );

    // Interpolating the timestamp we're searching for to block numbers.
    const totalTimeDifference = endBlock.timestamp - startBlock.timestamp;
    const totalBlockDistance = endBlock.number - startBlock.number;
    const blockPercentile = (timestamp - startBlock.timestamp) / totalTimeDifference;
    const estimatedBlock = startBlock.number + Math.round(blockPercentile * totalBlockDistance);

    // Clamp ensures the estimated block is strictly greater than the start block and strictly less than the end block.
    const newBlock = await getBlock(lodash.clamp(estimatedBlock, startBlock.number + 1, endBlock.number - 1));

    // Depending on whether the new block is below or above the timestamp, narrow the search space accordingly.
    if (newBlock.timestamp < timestamp) {
      return findBlock(newBlock, endBlock, timestamp);
    } else {
      return findBlock(startBlock, newBlock, timestamp);
    }
  }

  /**
   * @notice Gets the latest block whose timestamp is <= the provided timestamp.
   * @param {number} timestamp timestamp to search.
   */
  async function getBlockForTimestamp(timestamp: number | string): Promise<T> {
    timestamp = Number(timestamp);
    assert(timestamp !== undefined && timestamp !== null, "timestamp must be provided");
    // If the last block we have stored is too early, grab the latest block.
    if (blocks.length === 0 || blocks[blocks.length - 1].timestamp < timestamp) {
      const block = await getLatestBlock();
      if (timestamp >= block.timestamp) return block;
    }

    // Check the first block. If it's grater than our timestamp, we need to find an earlier block.
    if (blocks[0].timestamp > timestamp) {
      const initialBlock = blocks[0] as WithoutStringTimestamp<T>;
      const cushion = 1.1;
      // Ensure the increment block distance is _at least_ a single block to prevent an infinite loop.
      const incrementDistance = Math.max(await estimateBlocksElapsed(initialBlock.timestamp - timestamp, cushion), 1);

      // Search backwards by a constant increment until we find a block before the timestamp or hit block 0.
      for (let multiplier = 1; ; multiplier++) {
        const distance = multiplier * incrementDistance;
        const blockNumber = Math.max(0, initialBlock.number - distance);
        const block = await getBlock(blockNumber);
        if (block.timestamp <= timestamp) break; // Found an earlier block.
        assert(blockNumber > 0, "timestamp is before block 0"); // Block 0 was not earlier than this timestamp. Throw.
      }
    }

    // Find the index where the block would be inserted and use that as the end block (since it is >= the timestamp).
    const index = lodash.sortedIndexBy(blocks, { timestamp } as T, "timestamp");
    return findBlock(blocks[index - 1], blocks[index], timestamp);
  }

  return { getBlockForTimestamp };
};

type TwapEvent = [timestamp: number, price: BN | null];

// Given a list of price events in chronological order [timestamp, price] and a time window, returns the time-weighted
// average price.
export const computeTWAP = (
  events: TwapEvent[],
  startTime: number,
  endTime: number,
  startingPriceSum: BN
): BN | null => {
  // Add fake element that's far in the future to the end of the array to simplify TWAP calculation.
  events.push([MAX_SAFE_JS_INT, null]);

  let lastPrice = null;
  let lastTime = null;
  let priceSum = startingPriceSum;
  let timeSum = 0;
  for (const event of events) {
    // Because the price window goes up until the next event, computation cannot start until event 2.
    if (lastTime && lastPrice) {
      const startWindow = Math.max(lastTime, startTime);
      const endWindow = Math.min(event[0], endTime);
      const windowLength = Math.max(endWindow - startWindow, 0);
      priceSum = priceSum.add(lastPrice.muln(windowLength));
      timeSum += windowLength;
    }

    // If first event is later than end time, return null
    if (event[0] > endTime) {
      break;
    }

    // events are in the shape: [timestamp, price]
    lastPrice = event[1];
    lastTime = event[0];
  }

  if (timeSum === 0) {
    return null;
  }

  return priceSum.divn(timeSum);
};
