import assert from "assert";
import SynthPrices from "../libs/synthPrices";
import { AppState, PriceSample, Currencies, BaseConfig } from "..";
import * as uma from "@uma/sdk";
import bluebird from "bluebird";
import * as Queries from "../libs/queries";
import { calcSyntheticPrice, Profile } from "../libs/utils";

interface Config extends BaseConfig {
  cryptowatchApiKey?: string;
  tradermadeApiKey?: string;
  quandlApiKey?: string;
  defipulseApiKey?: string;
  priceFeedDecimals?: number;
  currency?: Currencies;
}

type Dependencies = Pick<
  AppState,
  "web3" | "emps" | "synthPrices" | "erc20s" | "prices" | "stats" | "registeredEmps" | "marketPrices" | "lsps"
>;

export default function (config: Config, appState: Dependencies) {
  const { currency = "usd", debug } = config;
  const { web3, emps, synthPrices, prices } = appState;
  const getSynthPrices = SynthPrices(config, web3);

  const queries = Queries.Emp(appState);
  const profile = Profile(debug);

  // get or create a history table by an erc20 token address. this might be a bit confusing because we also have a
  // synthPrices table which store raw synth price queried from bot. This table stores the currency converted price over time.
  function getOrCreateHistoryTable(tokenAddress: string) {
    if (prices[currency].history[tokenAddress] == null) {
      prices[currency].history[tokenAddress] = uma.tables.historicalPrices.SortedJsMap();
    }
    return prices[currency].history[tokenAddress];
  }

  // utility to grab last price based on address
  function getLatestSynthPriceFromTable(empAddress: string) {
    const result = synthPrices.latest[empAddress];
    assert(uma.utils.exists(result), "no latest sythetic price found for emp: " + empAddress);
    return result;
  }

  // pulls price from latest and stuffs it into historical table.
  async function updatePriceHistory(empAddress: string) {
    const emp = await getFullEmpState(empAddress);
    assert(uma.utils.exists(emp.tokenCurrency), "Requires emp.tokenCurrency: " + empAddress);
    const table = getOrCreateHistoryTable(emp.tokenCurrency);
    const [timestamp, price] = await getLatestPriceFromTable(empAddress, emp.tokenCurrency);
    // if this timestamp exists in the table, dont bother re-adding it
    assert(uma.utils.exists(price), "No latest price available for: " + empAddress);
    assert(
      !(await table.hasByTimestamp(timestamp)),
      `Synthetic price already exists for emp address ${empAddress} at timestamp: ${timestamp}`
    );
    return table.create({ timestamp, price });
  }

  async function updatePriceHistories(addresses: string[]) {
    return Promise.allSettled(addresses.map(updatePriceHistory));
  }

  // updates raw synth price, in relation to collateral
  async function updateLatestSynthPrice(empAddress: string) {
    const result: PriceSample = await getSynthPrices.getCurrentPrice(empAddress);
    synthPrices.latest[empAddress] = result;
    return result;
  }

  async function updateLatestSynthPrices(empAddresses: string[]) {
    // slow down updates by running them serially to prevent rate limits, conform to Promise.allSettled
    return bluebird.mapSeries(empAddresses, async (empAddress) => {
      const end = profile(`Synth price for ${empAddress}`);
      try {
        return {
          status: "fulfilled",
          value: await updateLatestSynthPrice(empAddress),
        };
      } catch (err) {
        return {
          status: "rejected",
          reason: err,
        };
      } finally {
        end();
      }
    });
  }

  async function getFullEmpState(empAddress: string) {
    const emp = await queries.getAny(empAddress);
    // the full state has collateral decimals, pulled from erc20 state
    return queries.getFullState(emp);
  }

  // gets any price from table, synthetic or collateral. Synthetics go into this table once converted to usd
  async function getLatestPriceFromTable(empAddress: string, currencyAddress: string) {
    // PriceSample is type [ timestamp:number, price:string]
    const priceSample: PriceSample = prices[currency].latest[currencyAddress];
    assert(uma.utils.exists(priceSample), "No latest price found for emp: " + empAddress);

    const price = priceSample[1];
    assert(uma.utils.exists(price), "Invalid latest price found on emp: " + empAddress);

    return priceSample;
  }

  // convert synth price to {currency} which is typically usd, based on the current collateral price
  async function updateLatestPrice(empAddress: string) {
    const emp = await queries.getAny(empAddress);

    assert(uma.utils.exists(emp.collateralCurrency), "Requires contract collateralCurrency: " + empAddress);
    assert(uma.utils.exists(emp.tokenCurrency), "Requires contract tokenCurrency: " + empAddress);

    const [synthTimestamp, synthPrice] = await getLatestSynthPriceFromTable(empAddress);
    const [collateralTimestamp, collateralPrice] = await getLatestPriceFromTable(empAddress, emp.collateralCurrency);

    // converted price from raw synth to currency ( usually usd)
    const price = calcSyntheticPrice(synthPrice, collateralPrice).toString();

    // use the most recent timestamp to index this price
    const timestamp = Math.max(collateralTimestamp, synthTimestamp);
    prices[currency].latest[emp.tokenCurrency] = [timestamp, price.toString()];
    return [timestamp, price];
  }

  async function updateLatestPrices(empAddresses: string[]) {
    // slow down updates by running them serially to prevent rate limits, conform to Promise.allSettled
    return bluebird.mapSeries(empAddresses, async (empAddress) => {
      const end = profile(`Update Synth to USD for ${empAddress}`);
      try {
        return {
          status: "fulfilled",
          value: await updateLatestPrice(empAddress),
        };
      } catch (err) {
        return {
          status: "rejected",
          reason: err,
        };
      } finally {
        end();
      }
    });
  }

  async function update() {
    // synth prices are looked up by emp address, not synthetic token address
    const empAddresses = Array.from(await emps.active.keys());
    // this gets raw synth price without regard to currency, stores them in table. not really useful until converted to usd.
    await updateLatestSynthPrices(empAddresses).then((results) => {
      results.forEach((result) => {
        if (result.status === "rejected") console.error("Error updating synthetic price: " + result.reason.message);
      });
    });
    // this converts latest synth prices to a currency price, based on collateral price relationship
    await updateLatestPrices(empAddresses).then((results) => {
      results.forEach((result) => {
        if (result.status === "rejected")
          console.error(`Error updating synthetic ${currency} price: ${result.reason.message}`);
      });
    });
    // this takes converted prices and creates a historical record
    await updatePriceHistories(empAddresses).then((results) => {
      results.forEach((result) => {
        if (result.status === "rejected")
          console.error("Error updating historical synthetic price: " + result.reason.message);
      });
    });
  }

  return {
    update,
    utils: {
      getOrCreateHistoryTable,
      getLatestSynthPriceFromTable,
      updatePriceHistories,
      updatePriceHistory,
      updateLatestPrice,
      updateLatestPrices,
      updateLatestSynthPrice,
      updateLatestSynthPrices,
      getFullEmpState,
      getLatestPriceFromTable,
    },
  };
}
