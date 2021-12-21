/// <reference path="simple-linear-scale.d.ts"/>
import { DatabaseManager } from "@subsquid/hydra-common";
import { Bid, Parachain } from "../generated/model";
import { ensure } from "./ensure";
import { ensureParachain } from "./parachain";
import { times, findKey, partial, isEqual, groupBy, find } from "lodash";
import linearScale from "simple-linear-scale";
import dotenv from 'dotenv'
dotenv.config()
console.log(process.env.ENDING_PERIOD_LENGTH)
if (!process.env.ENDING_PERIOD_LENGTH)
  throw new Error("env.ENDING_PERIOD_LENGTH is not specified");
export const auctionEndingPeriodLength = BigInt(
  process.env.ENDING_PERIOD_LENGTH || ""
);

/**
 * Find or create, and then upsert a bid
 * with a specific slot range as ID
 */
export const ensureBid = async (
  store: DatabaseManager,
  paraId: string,
  balance: bigint,
  leasePeriodStart: bigint,
  leasePeriodEnd: bigint
) => {
  const id = `${leasePeriodStart.toString()}-${leasePeriodEnd.toString()}`;
  const parachain = await ensureParachain(store, paraId);

  const bid = await ensure<Bid>(store, Bid, id, {
    parachain,
    balance,
    leasePeriodStart,
    leasePeriodEnd,
  });

  await store.save(bid);
  return { bid, parachain };
};

export const updateBid = async (
  store: DatabaseManager,
  id: string,
  balance: bigint,
  parachain: Parachain
) => {
  const bid = await store.get(Bid, { where: { id } });
  // update the bid with latest parachain and balance if it already existed
  if (bid && balance > bid.balance) {
    bid.parachain = parachain;
    bid.balance = balance;

    await store.save(bid);
  }
};

/**
 * Reimplementation of `calculate_winners` from the Polkadot auction module
 * https://github.com/paritytech/polkadot/blob/9fc3088f9e8dae5eaf062503fcefbb75a548c016/runtime/common/src/auctions.rs#L571
 */
const leasePeriodsPerSlot = 8;
export const targetLeasePeriod = [6, 13];

/**
 * Replicate slot range serialization logic from the Polkadot runtime
 *
 * https://github.com/paritytech/polkadot/blob/9fc3088f9e8dae5eaf062503fcefbb75a548c016/runtime/common/slot_range_helper/src/lib.rs#L279
 */
export type IndexedBids = { [key: string]: Bid };
export type SlotRange = {
  leasePeriodStart: bigint;
  leasePeriodEnd: bigint;
};

// generate a unique index for each slot range combination
export const slotRangePairing = (() => {
  const rangeIndexes: { [key: string]: string } = {};
  let index = 0;
  times(8).forEach((i) => {
    times(8).forEach((j) => {
      if (i > j) return;
      rangeIndexes[`${i}-${j}`] = `${index}`;
      index++;
    });
  });
  return rangeIndexes;
})();

// convert a slot range to slot length/duration to be used as bid weight
export const slotRangeIndexToLength = (slotRangeIndex: string) => {
  const minimalSlotRange = findKey(
    slotRangePairing,
    partial(isEqual, slotRangeIndex)
  );
  const slotRange = minimalSlotRange?.split("-") as string[];
  const slotRangeLength =
    BigInt(slotRange[1]) - BigInt(slotRange[0]) + BigInt(1);
  return slotRangeLength;
};

// convert the given slot range to the previously generated unique index
export const slotRangeToIndex = ({
  leasePeriodStart,
  leasePeriodEnd,
}: SlotRange) => slotRangePairing[`${leasePeriodStart}-${leasePeriodEnd}`];

const slotRangeScale = linearScale(targetLeasePeriod, [
  0,
  leasePeriodsPerSlot - 1
]);
// this function will transform e.g. 13-20 to 0-7, same as runtime's SlotRange::new_bounded
export const minimizeSlotRange = ({
  leasePeriodStart,
  leasePeriodEnd,
}: SlotRange): SlotRange => ({
  leasePeriodStart: BigInt(slotRangeScale(Number(leasePeriodStart))),
  leasePeriodEnd: BigInt(slotRangeScale(Number(leasePeriodEnd))),
});

/**
 * Convert the best existing bids into a data structure
 * using unique slot range indexes as keys
 */
export const bidsIntoRangeIndexes = (bids: Bid[]) => {
  const bidsWithIndexes: IndexedBids = {};

  bids.forEach((bid) => {
    const minimalSlotRangeIndex = slotRangeToIndex(bid);
    bidsWithIndexes[minimalSlotRangeIndex] = bid;
  });

  return bidsWithIndexes;
};

/**
 * Find a bid for the given unique slot range index
 * and multiply it by slot range length
 */
export const bestBidForRangeIndex = (
  indexedBids: IndexedBids,
  slotRangeIndex: string
): bigint | undefined => {
  const bid = indexedBids[slotRangeIndex];
  if (!bid) return;

  const slotLength = slotRangeIndexToLength(slotRangeIndex);
    //const weightedBid = bid.balance?.mul(new BN(slotLength));
    const weightedBid = bid.balance * BigInt(slotLength);
    return weightedBid;
};

/**
 * Logis for determining/calculating winning bids replicated from the
 * Polkadot runtime. Iterates over slot range combination selecting
 * the most suitable/winning bids as a result.
 *
 * NOTE: Uncertain how exactly the implementation works, but it is
 * copied 1:1 from the runtime and behaves as specified in the runtime tests.
 */
export const determineWinningBids = (indexedBids: IndexedBids): Bid[] => {
  const winningBids = (() => {
    const bestWinnersEndingAt: { [key: string]: any } = {};

    for (let i = 0; i <= leasePeriodsPerSlot; i++) {
      const slotRange: SlotRange = {
        leasePeriodStart: BigInt(0),
        leasePeriodEnd: BigInt(i),
      };
      const slotRangeIndex = slotRangeToIndex(slotRange);
      const bid = bestBidForRangeIndex(indexedBids, slotRangeIndex);

      if (bid) {
        bestWinnersEndingAt[i] = {
          ranges: [slotRange],
          bid,
        };
      }

      for (let j = 0; j <= i; j++) {
        const slotRange: SlotRange = {
          leasePeriodStart: BigInt(j + 1),
          leasePeriodEnd: BigInt(i),
        };
        const slotRangeIndex = slotRangeToIndex(slotRange);
        let bid = bestBidForRangeIndex(indexedBids, slotRangeIndex);

        // those two for loops above cover all slot range combinations, now its time to choose the highest bids
        if (bid) {
          bid = bid + (bestWinnersEndingAt[j]?.bid || BigInt(0));

          if (bid! > (bestWinnersEndingAt[i]?.bid || BigInt(0))) {
            bestWinnersEndingAt[i] = {
              ranges: (bestWinnersEndingAt[j]?.ranges || []).concat(slotRange),
              bid,
            };
          }
        } else {
          const shouldReplaceBestWinners = (
            bestWinnersEndingAt[j]?.bid || BigInt(0)
          ) > (bestWinnersEndingAt[i]?.bid || BigInt(0));

          if (shouldReplaceBestWinners) {
            bestWinnersEndingAt[i] = { ...bestWinnersEndingAt[j] };
          }
        }
      }
    }

    const winningRanges = bestWinnersEndingAt[leasePeriodsPerSlot - 1]?.ranges;
    // map the winningRanges back to the actual bids that won those ranges
    const winningBids = winningRanges
      .map((range: SlotRange) => {
        const slotRangeIndex = slotRangeToIndex(range);
        const finalWinner = indexedBids[slotRangeIndex];
        return finalWinner;
      })
      .filter((winner: SlotRange) => winner);

    return winningBids;
  })();

  return winningBids;
};

/**
 * Determine winning bids after transforming the currently in-db-indexed bids, into a object
 * that uses unique slot range combinations as indexes, in order to be consumed
 * by the winner calculation algorithm.
 */
export const determineWinningBidsFromCurrentBids = (bids: Bid[]): Bid[] => {
  bids = bids.map((bid) => {
    const minimizedSlotRange = minimizeSlotRange(bid);
    bid.leasePeriodStart = minimizedSlotRange.leasePeriodStart;
    bid.leasePeriodEnd = minimizedSlotRange.leasePeriodEnd;
    return bid;
  });
  const indexedBids = bidsIntoRangeIndexes(bids);
  return determineWinningBids(indexedBids);
};

/**
 * In case someone decides to place a manual bid outside of the crowdloan,
 * we need to be able to account for it as funds pledged by the given parachain.
 */
export const upsertFundsPledgedWithWinningBids = async (
  store: DatabaseManager
) => {
  const allBids = await store.getMany(Bid, {
    relations: ["parachain"],
  });
  const winningBids = determineWinningBidsFromCurrentBids(allBids);
  const winningBidsByParachain = groupBy(
    winningBids,
    (bid) => bid.parachain.id
  );

  const winningParachainIDs = Object.keys(winningBidsByParachain);
  const winningParachains = await store.getMany(Parachain, {
    // array of where clauses containing the winning paraIDs acts as an 'OR' statement
    where: winningParachainIDs.map((id) => ({ id })),
  });

  const winningParachainsFundsPledged = winningParachainIDs.map((paraId) => {
    const sumOfBids = winningBidsByParachain[paraId].reduce(
      (sum, bid) => sum + bid.balance,
      BigInt(0)
    );

    return {
      paraId,
      fundsPledged: sumOfBids,
    };
  });

  const updateWinningParachainsFundsPledged = winningParachainsFundsPledged.map(
    ({ paraId, fundsPledged }, i) => {
      const parachain = find(winningParachains, { id: paraId });
      /**
       * If fundsPledged from the winning bids for the given paraId
       * are greater than the fundsPledged currently stored, replace them.
       *
             * 
       *
       * This covers the case when there is a manual bid higher than the
             * This covers the case when there is a manual bid higher than the 
       * This covers the case when there is a manual bid higher than the
       * crowdloan amount raised.
       */
      if (parachain && parachain.fundsPledged < fundsPledged) {
        parachain.fundsPledged = fundsPledged;
        return store.save(parachain);
      }
    }
  );

  await Promise.all(updateWinningParachainsFundsPledged);
};
