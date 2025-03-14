#!/usr/bin/env node

require("dotenv").config();
const retry = require("async-retry");

// Helpers
const { getWeb3, SUPPORTED_CONTRACT_VERSIONS, PublicNetworks } = require("@uma/common");
// JS libs
const { Liquidator } = require("./src/liquidator");
const { ProxyTransactionWrapper } = require("./src/proxyTransactionWrapper");
const {
  GasEstimator,
  FinancialContractClient,
  Networker,
  Logger,
  createReferencePriceFeedForFinancialContract,
  waitForLogger,
  delay,
  setAllowance,
  DSProxyManager,
  multicallAddressMap,
} = require("@uma/financial-templates-lib");

// Contract ABIs and network Addresses.
const { getAbi, getAddress, findContractVersion } = require("@uma/core");

/**
 * @notice Continuously attempts to liquidate positions in the Financial Contract contract.
 * @param {Object} logger Module responsible for sending logs.
 * @param {Object} web3 web3.js instance with unlocked wallets used for all on-chain connections.
 * @param {String} financialContractAddress Contract address of the Financial Contract.
 * @param {Number} pollingDelay The amount of seconds to wait between iterations. If set to 0 then running in serverless
 *     mode which will exit after the loop.
 * @param {Number} errorRetries The number of times the execution loop will re-try before throwing if an error occurs.
 * @param {Number} errorRetriesTimeout The amount of milliseconds to wait between re-try iterations on failed loops.
 * @param {Object} priceFeedConfig Configuration to construct the price feed object.
 * @param {Object} [liquidatorConfig] Configuration to construct the liquidator.
 * @param {String} [liquidatorOverridePrice] Optional String representing a Wei number to override the liquidator price feed.
 * @param {Number} [startingBlock] Earliest block to query for contract events that the bot will log about.
 * @param {Number} [endingBlock] Latest block to query for contract events that the bot will log about.
 * @param {Object} [proxyTransactionWrapperConfig] Configuration to construct the proxy transaction wrapper to enable DSProxy
 *     liquidations. This facilitates atomic swap, mint and liquidate transactions against a reserve currency.
 * @return None or throws an Error.
 */
async function run({
  logger,
  web3,
  financialContractAddress,
  pollingDelay,
  errorRetries,
  errorRetriesTimeout,
  priceFeedConfig,
  liquidatorConfig,
  liquidatorOverridePrice,
  startingBlock,
  endingBlock,
  proxyTransactionWrapperConfig,
}) {
  try {
    const getTime = () => Math.round(new Date().getTime() / 1000);

    // If pollingDelay === 0 then the bot is running in serverless mode and should send a `debug` level log.
    // Else, if running in loop mode (pollingDelay != 0), then it should send a `info` level log.
    logger[pollingDelay === 0 ? "debug" : "info"]({
      at: "Liquidator#index",
      message: "Liquidator started 🌊",
      financialContractAddress,
      pollingDelay,
      errorRetries,
      errorRetriesTimeout,
      priceFeedConfig,
      liquidatorConfig,
      liquidatorOverridePrice,
      startingBlock,
      endingBlock,
      proxyTransactionWrapperConfig,
    });

    // Load unlocked web3 accounts and get the networkId.
    const [detectedContract, accounts, networkId] = await Promise.all([
      findContractVersion(financialContractAddress, web3),
      web3.eth.getAccounts(),
      web3.eth.net.getId(),
    ]);

    const networkName = PublicNetworks[Number(networkId)] ? PublicNetworks[Number(networkId)].name : null;
    // Append the contract version and type to the liquidatorConfig, if the liquidatorConfig does not already contain one.
    if (!liquidatorConfig) liquidatorConfig = {};
    if (!liquidatorConfig.contractVersion) liquidatorConfig.contractVersion = detectedContract?.contractVersion;
    if (!liquidatorConfig.contractType) liquidatorConfig.contractType = detectedContract?.contractType;

    // Check that the version and type is supported. Note if either is null this check will also catch it.
    if (
      SUPPORTED_CONTRACT_VERSIONS.filter(
        (vo) =>
          vo.contractType == liquidatorConfig.contractType && vo.contractVersion == liquidatorConfig.contractVersion
      ).length == 0
    )
      throw new Error(
        `Contract version specified or inferred is not supported by this bot. Liquidator config:${JSON.stringify(
          liquidatorConfig
        )} & detectedContractVersion:${JSON.stringify(detectedContract)} is not part of ${JSON.stringify(
          SUPPORTED_CONTRACT_VERSIONS
        )}`
      );

    // Setup contract instances. This uses the contract version pulled in from previous step.
    const financialContract = new web3.eth.Contract(
      getAbi(liquidatorConfig.contractType, liquidatorConfig.contractVersion),
      financialContractAddress
    );

    // Returns whether the Financial Contract has expired yet
    const checkIsExpiredOrShutdownPromise = async () => {
      const [expirationOrShutdownTimestamp, contractTimestamp] = await Promise.all([
        liquidatorConfig.contractType === "ExpiringMultiParty"
          ? financialContract.methods.expirationTimestamp().call()
          : financialContract.methods.emergencyShutdownTimestamp().call(),
        financialContract.methods.getCurrentTime().call(),
      ]);
      // Check if Financial Contract is expired.
      if (
        Number(contractTimestamp) >= Number(expirationOrShutdownTimestamp) &&
        Number(expirationOrShutdownTimestamp) > 0
      ) {
        logger.info({
          at: "Liquidator#index",
          message: `Financial Contract is ${
            liquidatorConfig.contractType === "ExpiringMultiParty" ? "expired" : "shutdown"
          }, can only withdraw liquidator dispute rewards 🕰`,
          expirationOrShutdownTimestamp,
          contractTimestamp,
        });
        return true;
      } else {
        return false;
      }
    };

    // Generate Financial Contract properties to inform bot of important on-chain state values that we only want to query once.
    const [
      collateralRequirement,
      priceIdentifier,
      minSponsorTokens,
      collateralTokenAddress,
      syntheticTokenAddress,
      withdrawLiveness,
    ] = await Promise.all([
      financialContract.methods.collateralRequirement().call(),
      financialContract.methods.priceIdentifier().call(),
      financialContract.methods.minSponsorTokens().call(),
      financialContract.methods.collateralCurrency().call(),
      financialContract.methods.tokenCurrency().call(),
      financialContract.methods.withdrawalLiveness().call(),
    ]);

    const collateralToken = new web3.eth.Contract(getAbi("ExpandedERC20"), collateralTokenAddress);
    const syntheticToken = new web3.eth.Contract(getAbi("ExpandedERC20"), syntheticTokenAddress);
    const [collateralDecimals, syntheticDecimals] = await Promise.all([
      collateralToken.methods.decimals().call(),
      syntheticToken.methods.decimals().call(),
    ]);

    const financialContractProps = {
      crRatio: collateralRequirement,
      priceIdentifier: priceIdentifier,
      minSponsorSize: minSponsorTokens,
      withdrawLiveness,
    };

    // Add block window into `liquidatorConfig`
    liquidatorConfig = { ...liquidatorConfig, startingBlock, endingBlock };

    // Load unlocked web3 accounts, get the networkId and set up price feed.
    const priceFeed = await createReferencePriceFeedForFinancialContract(
      logger,
      web3,
      new Networker(logger),
      getTime,
      financialContractAddress,
      priceFeedConfig
    );

    if (!priceFeed) {
      throw new Error("Price feed config is invalid");
    }

    // Create the financialContractClient to query on-chain information, GasEstimator to get latest gas prices and an
    // instance of Liquidator to preform liquidations.
    const financialContractClient = new FinancialContractClient(
      logger,
      getAbi(liquidatorConfig.contractType, liquidatorConfig.contractVersion),
      web3,
      financialContractAddress,
      networkName ? multicallAddressMap[networkName].multicall : null,
      collateralDecimals,
      syntheticDecimals,
      priceFeed.getPriceFeedDecimals(),
      liquidatorConfig.contractType
    );

    const gasEstimator = new GasEstimator(logger, 60, networkId);
    await gasEstimator.update();

    let dsProxyManager;
    if (proxyTransactionWrapperConfig?.useDsProxyToLiquidate) {
      dsProxyManager = new DSProxyManager({
        logger,
        web3,
        gasEstimator,
        account: accounts[0],
        dsProxyFactoryAddress:
          proxyTransactionWrapperConfig?.dsProxyFactoryAddress || getAddress("DSProxyFactory", networkId),
        dsProxyFactoryAbi: getAbi("DSProxyFactory"),
        dsProxyAbi: getAbi("DSProxy"),
        availableAccounts: proxyTransactionWrapperConfig.availableAccounts || 1,
      });

      // Load in an existing DSProxy for the account EOA if one already exists or create a new one for the user.
      await dsProxyManager.initializeDSProxy();
    }

    const proxyTransactionWrapper = new ProxyTransactionWrapper({
      web3,
      financialContract,
      gasEstimator,
      syntheticToken,
      collateralToken,
      account: accounts[0],
      dsProxyManager,
      proxyTransactionWrapperConfig,
    });

    const liquidator = new Liquidator({
      logger,
      financialContractClient,
      proxyTransactionWrapper,
      gasEstimator,
      syntheticToken,
      priceFeed,
      account: accounts[0],
      financialContractProps,
      liquidatorConfig,
    });

    logger.debug({
      at: "Liquidator#index",
      message: "Liquidator initialized",
      collateralDecimals: Number(collateralDecimals),
      syntheticDecimals: Number(syntheticDecimals),
      priceFeedDecimals: Number(priceFeed.getPriceFeedDecimals()),
      priceFeedConfig,
      liquidatorConfig,
    });

    if (proxyTransactionWrapperConfig == {} || !proxyTransactionWrapperConfig?.useDsProxyToLiquidate) {
      // The Financial Contract requires approval to transfer the liquidator's collateral and synthetic tokens in order to liquidate
      // a position. We'll set this once to the max value and top up whenever the bot's allowance drops below MAX_INT / 2.
      const collateralApproval = await setAllowance(
        web3,
        gasEstimator,
        accounts[0],
        financialContractAddress,
        collateralTokenAddress
      );
      const syntheticApproval = await setAllowance(
        web3,
        gasEstimator,
        accounts[0],
        financialContractAddress,
        syntheticTokenAddress
      );
      if (collateralApproval)
        logger.info({
          at: "Liquidator#index",
          message: "Approved Financial Contract to transfer unlimited collateral tokens 💰",
          collateralApprovalTx: collateralApproval.tx.transactionHash,
        });

      if (syntheticApproval)
        logger.info({
          at: "Liquidator#index",
          message: "Approved Financial Contract to transfer unlimited synthetic tokens 💰",
          syntheticApprovalTx: syntheticApproval.tx.transactionHash,
        });
    }

    // Create a execution loop that will run indefinitely (or yield early if in serverless mode)
    for (;;) {
      // Check if Financial Contract expired before running current iteration.
      let isExpiredOrShutdown = await checkIsExpiredOrShutdownPromise();

      await retry(
        async () => {
          // Update the liquidators state. This will update the clients, price feeds and gas estimator.
          await liquidator.update();
          if (!isExpiredOrShutdown) {
            // Check for liquidatable positions and submit liquidations. Bounded by current synthetic balance and
            // considers override price if the user has specified one.
            const currentSyntheticBalance = await proxyTransactionWrapper.getEffectiveSyntheticTokenBalance();

            await liquidator.liquidatePositions(currentSyntheticBalance, liquidatorOverridePrice);
          }
          // Check for any finished liquidations that can be withdrawn.
          await liquidator.withdrawRewards();
        },
        {
          retries: errorRetries,
          minTimeout: errorRetriesTimeout * 1000, // delay between retries in ms
          randomize: false,
          onRetry: (error) => {
            logger.debug({
              at: "Liquidator#index",
              message: "An error was thrown in the execution loop - retrying",
              error: typeof error === "string" ? new Error(error) : error,
            });
          },
        }
      );
      // If the polling delay is set to 0 then the script will terminate the bot after one full run.
      if (pollingDelay === 0) {
        logger.debug({ at: "Liquidator#index", message: "End of serverless execution loop - terminating process" });
        await waitForLogger(logger);
        await delay(2); // waitForLogger does not always work 100% correctly in serverless. add a delay to ensure logs are captured upstream.
        break;
      }
      logger.debug({
        at: "Liquidator#index",
        message: "End of execution loop - waiting polling delay",
        pollingDelay: `${pollingDelay} (s)`,
      });
      await delay(Number(pollingDelay));
    }
  } catch (error) {
    // If any error is thrown, catch it and bubble up to the main try-catch for error processing in the Poll function.
    throw typeof error === "string" ? new Error(error) : error;
  }
}

async function Poll(callback) {
  try {
    if (!process.env.EMP_ADDRESS && !process.env.FINANCIAL_CONTRACT_ADDRESS) {
      throw new Error(
        "Bad environment variables! Specify an EMP_ADDRESS or FINANCIAL_CONTRACT_ADDRESS for the location of the financial contract the bot is expected to interact with."
      );
    }

    // This object is spread when calling the `run` function below. It relies on the object enumeration order and must
    // match the order of parameters defined in the`run` function.
    const executionParameters = {
      // Financial Contract Address. Should be an Ethereum address
      financialContractAddress: process.env.EMP_ADDRESS || process.env.FINANCIAL_CONTRACT_ADDRESS,
      // Default to 1 minute delay. If set to 0 in env variables then the script will exit after full execution.
      pollingDelay: process.env.POLLING_DELAY ? Number(process.env.POLLING_DELAY) : 60,
      // Default to 3 re-tries on error within the execution loop.
      errorRetries: process.env.ERROR_RETRIES ? Number(process.env.ERROR_RETRIES) : 3,
      // Default to 1 seconds in between error re-tries.
      errorRetriesTimeout: process.env.ERROR_RETRIES_TIMEOUT ? Number(process.env.ERROR_RETRIES_TIMEOUT) : 1,
      // Read price feed configuration from an environment variable. This can be a crypto watch, medianizer or uniswap
      // price feed Config defines the exchanges to use. If not provided then the bot will try and infer a price feed
      // from the EMP_ADDRESS. EG with medianizer: {"type":"medianizer","pair":"ethbtc",
      // "lookback":7200, "minTimeBetweenUpdates":60,"medianizedFeeds":[{"type":"cryptowatch","exchange":"coinbase-pro"},
      // {"type":"cryptowatch","exchange":"binance"}]}
      priceFeedConfig: process.env.PRICE_FEED_CONFIG ? JSON.parse(process.env.PRICE_FEED_CONFIG) : null,
      // If there is a liquidator config, add it. Else, set to null. This config contains crThreshold,liquidationDeadline,
      // liquidationMinPrice, txnGasLimit & logOverrides. Example config:
      // { "crThreshold":0.02,  -> Liquidate if a positions collateral falls more than this % below the min CR requirement
      //   "liquidationDeadline":300, -> Aborts if the transaction is mined this amount of time after the last update
      //   "liquidationMinPrice":0, -> Aborts if the amount of collateral in the position per token is below this ratio
      //   "txnGasLimit":9000000 -> Gas limit to set for sending on-chain transactions.
      //   "defenseActivationPercent": undefined -> Set to > 0 to turn on "Whale Defense" strategy.
      //                               Specifies how far along a withdraw must be in % before defense strategy kicks in.
      //   "logOverrides":{"positionLiquidated":"warn"}, -> override specific events log levels.
      //   "contractType":"ExpiringMultiParty", -> override the kind of contract the liquidator is pointing at.
      //   "contractVersion":"1.2.2"} -> override the contract version the liquidator is pointing at.
      liquidatorConfig: process.env.LIQUIDATOR_CONFIG ? JSON.parse(process.env.LIQUIDATOR_CONFIG) : {},
      // If there is a LIQUIDATOR_OVERRIDE_PRICE environment variable then the liquidator will disregard the price from the
      // price feed and preform liquidations at this override price. Use with caution as wrong input could cause invalid liquidations.
      liquidatorOverridePrice: process.env.LIQUIDATOR_OVERRIDE_PRICE,
      // Block number to search for events from. If set, acts to offset the search to ignore events in the past. If
      // either startingBlock or endingBlock is not sent, then the bot will search for event.
      startingBlock: process.env.STARTING_BLOCK_NUMBER,
      // Block number to search for events to. If set, acts to limit from where the monitor bot will search for events up
      // until. If either startingBlock or endingBlock is not sent, then the bot will search for event.
      endingBlock: process.env.ENDING_BLOCK_NUMBER,
      // If there is a dsproxy config, the bot can be configured to send transactions via a smart contract wallet (DSProxy).
      // This enables the bot to preform swap, mint & liquidate, enabling a single reserve currency.
      // Note that the DSProxy will be deployed on the first run of the bot. Subsequent runs will re-use the proxy. example:
      // { "useDsProxyToLiquidate": "true", If enabled, the bot will send liquidations via a DSProxy.
      //  "dsProxyFactoryAddress": "0x123..." -> Will default to an UMA deployed version if non provided.
      // "liquidatorReserveCurrencyAddress": "0x123..." -> currency DSProxy will trade from when liquidating.
      // "uniswapRouterAddress": "0x123..." -> uniswap router address to enable reserve trading. Defaults to mainnet router.
      // "uniswapFactoryAddress": "0x123..." -> uniswap factory address. Defaults to mainnet factory.
      // "maxReserverTokenSpent": "10000000000" -> max amount to spend in reserve currency. scaled by reserve currency
      //      decimals. defaults to MAX_UINT (no limit). Note that this is separate to the WDF, which behaves as per usual
      //      and considers the maximum amount of synthetics that could be minted, given the current reserve balance.
      // "availableAccounts": "1"} -> the number of EOAs the bot should use when performing liquidations. This only works
      // if you have configured your DSProxy with a DSGuard with permissions on your other EOAs unlocked from your account.
      proxyTransactionWrapperConfig: process.env.DSPROXY_CONFIG ? JSON.parse(process.env.DSPROXY_CONFIG) : {},
    };

    await run({ logger: Logger, web3: getWeb3(), ...executionParameters });
  } catch (error) {
    Logger.error({
      at: "Liquidator#index",
      message: "Liquidator execution error🚨",
      error: typeof error === "string" ? new Error(error) : error,
      notificationPath: "infrastructure-error",
    });
    await waitForLogger(Logger);
    callback(error);
  }
  callback();
}

function nodeCallback(err) {
  if (err) {
    console.error(err);
    process.exit(1);
  } else process.exit(0);
}

// If called directly by node, execute the Poll Function. This lets the script be run as a node process.
if (require.main === module) {
  Poll(nodeCallback)
    .then(() => {})
    .catch(nodeCallback);
}

// Attach this function to the exported function in order to allow the script to be executed through both truffle and a test runner.
Poll.run = run;
module.exports = Poll;
